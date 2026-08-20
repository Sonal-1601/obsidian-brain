import { detectLanguage, stripComments, type LanguageSpec } from "./languages.js";
import { extractLinks } from "../util/markdown.js";

/**
 * Static, single-pass analysis of one source file.
 *
 * This is deliberately regex-based rather than AST-based: the mirror covers a
 * dozen languages, needs to run on every keystroke-triggered sync, and only
 * needs enough fidelity to draw a useful graph. Comments are blanked first so
 * commented-out imports never become edges.
 */

export type ImportKind = "relative" | "absolute" | "package" | "url";

export interface RawImport {
  /** The specifier exactly as written in the source. */
  specifier: string;
  kind: ImportKind;
  line: number;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

export interface TodoInfo {
  tag: string;
  text: string;
  line: number;
}

export interface Analysis {
  language: LanguageSpec;
  lines: number;
  bytes: number;
  imports: RawImport[];
  symbols: SymbolInfo[];
  todos: TodoInfo[];
  /** Markdown headings, used as a note outline. */
  headings: string[];
  /** Wikilinks already present in a markdown source file. */
  wikilinks: string[];
  /** Leading docstring/comment or first paragraph, if any. */
  summary: string | null;
  /** Dependencies declared by a manifest such as package.json. */
  declaredDependencies: string[];
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\b[:\s]\s*(.{0,160})/;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function classify(specifier: string): ImportKind {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(specifier) || specifier.startsWith("//")) return "url";
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("/")) return "absolute";
  return "package";
}

function pushImport(out: RawImport[], seen: Set<string>, specifier: string, source: string, index: number): void {
  const trimmed = specifier.trim();
  if (!trimmed) return;
  const key = trimmed;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ specifier: trimmed, kind: classify(trimmed), line: lineOf(source, index) });
}

function collect(
  source: string,
  regex: RegExp,
  group: number,
  out: RawImport[],
  seen: Set<string>,
): void {
  for (const match of source.matchAll(regex)) {
    const value = match[group];
    if (value) pushImport(out, seen, value, source, match.index ?? 0);
  }
}

function extractImports(code: string, lang: LanguageSpec, relPath: string): RawImport[] {
  const out: RawImport[] = [];
  const seen = new Set<string>();

  switch (lang.id) {
    case "typescript":
    case "javascript":
    case "vue":
    case "svelte": {
      collect(code, /(?:^|\s)import\s+[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g, 1, out, seen);
      collect(code, /(?:^|\s)import\s*['"]([^'"]+)['"]/g, 1, out, seen);
      collect(code, /(?:^|\s)export\s+(?:\*|\{[\s\S]{0,400}?\})\s*from\s*['"]([^'"]+)['"]/g, 1, out, seen);
      collect(code, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 1, out, seen);
      collect(code, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 1, out, seen);
      break;
    }
    case "python": {
      collect(code, /^[ \t]*from\s+([.\w]+)\s+import\s+/gm, 1, out, seen);
      for (const match of code.matchAll(/^[ \t]*import\s+([^\n#]+)/gm)) {
        const list = match[1] ?? "";
        for (const part of list.split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0]?.trim();
          if (name) pushImport(out, seen, name, code, match.index ?? 0);
        }
      }
      break;
    }
    case "go": {
      for (const block of code.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
        for (const line of (block[1] ?? "").split("\n")) {
          const m = /"([^"]+)"/.exec(line);
          if (m?.[1]) pushImport(out, seen, m[1], code, block.index ?? 0);
        }
      }
      collect(code, /^[ \t]*import\s+(?:\w+\s+)?"([^"]+)"/gm, 1, out, seen);
      break;
    }
    case "rust": {
      collect(code, /^[ \t]*(?:pub\s+)?use\s+([\w:{}, *]+);/gm, 1, out, seen);
      collect(code, /^[ \t]*(?:pub\s+)?mod\s+(\w+)\s*;/gm, 1, out, seen);
      break;
    }
    case "java":
    case "kotlin":
    case "scala": {
      collect(code, /^[ \t]*import\s+(?:static\s+)?([\w.*]+)\s*;?/gm, 1, out, seen);
      break;
    }
    case "csharp": {
      collect(code, /^[ \t]*using\s+(?:static\s+)?([\w.]+)\s*;/gm, 1, out, seen);
      break;
    }
    case "ruby": {
      collect(code, /\brequire(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/g, 1, out, seen);
      break;
    }
    case "php": {
      collect(code, /^[ \t]*use\s+([\w\\]+)/gm, 1, out, seen);
      collect(code, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, 1, out, seen);
      break;
    }
    case "c": {
      collect(code, /^[ \t]*#\s*include\s*"([^"]+)"/gm, 1, out, seen);
      collect(code, /^[ \t]*#\s*include\s*<([^>]+)>/gm, 1, out, seen);
      break;
    }
    case "elixir": {
      collect(code, /^[ \t]*(?:import|alias|use|require)\s+([\w.]+)/gm, 1, out, seen);
      break;
    }
    case "shell": {
      collect(code, /^[ \t]*(?:source|\.)\s+([^\s;#]+)/gm, 1, out, seen);
      break;
    }
    case "css": {
      collect(code, /@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"]+)['"]/g, 1, out, seen);
      break;
    }
    case "proto": {
      collect(code, /^[ \t]*import\s+(?:public\s+)?"([^"]+)"/gm, 1, out, seen);
      break;
    }
    case "graphql": {
      collect(code, /#\s*import\s+['"]([^'"]+)['"]/g, 1, out, seen);
      break;
    }
    case "markdown": {
      for (const link of extractLinks(code)) {
        if (link.target.startsWith("http")) continue;
        pushImport(out, seen, link.target, code, 0);
      }
      break;
    }
    default:
      break;
  }

  // Sass partials are written without their leading underscore.
  if (lang.id === "css") {
    for (const imp of out) {
      if (imp.kind === "package" && !imp.specifier.includes("/")) imp.kind = "relative";
    }
  }
  void relPath;
  return out;
}

function extractSymbols(code: string, lang: LanguageSpec): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string, index: number, exported: boolean) => {
    const key = `${kind}:${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, line: lineOf(code, index), exported });
  };

  switch (lang.id) {
    case "typescript":
    case "javascript":
    case "vue":
    case "svelte": {
      const patterns: Array<[RegExp, string]> = [
        [/^[ \t]*export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm, "function"],
        [/^[ \t]*export\s+(?:abstract\s+)?class\s+(\w+)/gm, "class"],
        [/^[ \t]*export\s+interface\s+(\w+)/gm, "interface"],
        [/^[ \t]*export\s+type\s+(\w+)/gm, "type"],
        [/^[ \t]*export\s+enum\s+(\w+)/gm, "enum"],
        [/^[ \t]*export\s+(?:const|let|var)\s+(\w+)/gm, "const"],
        [/^[ \t]*export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/gm, "default"],
      ];
      for (const [regex, kind] of patterns) {
        for (const m of code.matchAll(regex)) add(m[1] ?? "", kind, m.index ?? 0, true);
      }
      for (const m of code.matchAll(/^[ \t]*(?:async\s+)?function\s*\*?\s*(\w+)/gm)) {
        add(m[1] ?? "", "function", m.index ?? 0, false);
      }
      for (const m of code.matchAll(/^[ \t]*class\s+(\w+)/gm)) add(m[1] ?? "", "class", m.index ?? 0, false);
      break;
    }
    case "python": {
      for (const m of code.matchAll(/^([ \t]*)(?:async\s+)?def\s+(\w+)/gm)) {
        const indent = (m[1] ?? "").length;
        const name = m[2] ?? "";
        add(name, indent === 0 ? "function" : "method", m.index ?? 0, indent === 0 && !name.startsWith("_"));
      }
      for (const m of code.matchAll(/^class\s+(\w+)/gm)) add(m[1] ?? "", "class", m.index ?? 0, true);
      break;
    }
    case "go": {
      for (const m of code.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm)) {
        const name = m[1] ?? "";
        add(name, "func", m.index ?? 0, /^[A-Z]/.test(name));
      }
      for (const m of code.matchAll(/^type\s+(\w+)/gm)) {
        const name = m[1] ?? "";
        add(name, "type", m.index ?? 0, /^[A-Z]/.test(name));
      }
      break;
    }
    case "rust": {
      for (const m of code.matchAll(/^[ \t]*(pub\s+)?fn\s+(\w+)/gm)) add(m[2] ?? "", "fn", m.index ?? 0, Boolean(m[1]));
      for (const m of code.matchAll(/^[ \t]*(pub\s+)?struct\s+(\w+)/gm)) add(m[2] ?? "", "struct", m.index ?? 0, Boolean(m[1]));
      for (const m of code.matchAll(/^[ \t]*(pub\s+)?enum\s+(\w+)/gm)) add(m[2] ?? "", "enum", m.index ?? 0, Boolean(m[1]));
      for (const m of code.matchAll(/^[ \t]*(pub\s+)?trait\s+(\w+)/gm)) add(m[2] ?? "", "trait", m.index ?? 0, Boolean(m[1]));
      break;
    }
    case "java":
    case "kotlin":
    case "scala":
    case "csharp": {
      for (const m of code.matchAll(/\b(?:public|private|protected|internal)?\s*(?:final\s+|abstract\s+|sealed\s+|data\s+)*(class|interface|enum|object|record|trait)\s+(\w+)/g)) {
        add(m[2] ?? "", m[1] ?? "type", m.index ?? 0, true);
      }
      for (const m of code.matchAll(/^[ \t]*(?:public|private|protected)\s+(?:static\s+)?(?:fun|[\w<>,\[\]]+)\s+(\w+)\s*\(/gm)) {
        add(m[1] ?? "", "method", m.index ?? 0, true);
      }
      break;
    }
    case "ruby": {
      for (const m of code.matchAll(/^[ \t]*def\s+([\w.?!]+)/gm)) add(m[1] ?? "", "def", m.index ?? 0, true);
      for (const m of code.matchAll(/^[ \t]*(class|module)\s+([\w:]+)/gm)) add(m[2] ?? "", m[1] ?? "class", m.index ?? 0, true);
      break;
    }
    case "php": {
      for (const m of code.matchAll(/^[ \t]*(?:abstract\s+|final\s+)?(class|interface|trait)\s+(\w+)/gm)) {
        add(m[2] ?? "", m[1] ?? "class", m.index ?? 0, true);
      }
      for (const m of code.matchAll(/^[ \t]*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)/gm)) {
        add(m[1] ?? "", "function", m.index ?? 0, true);
      }
      break;
    }
    case "elixir": {
      for (const m of code.matchAll(/^[ \t]*defmodule\s+([\w.]+)/gm)) add(m[1] ?? "", "module", m.index ?? 0, true);
      for (const m of code.matchAll(/^[ \t]*def\s+(\w+)/gm)) add(m[1] ?? "", "def", m.index ?? 0, true);
      break;
    }
    case "shell": {
      for (const m of code.matchAll(/^[ \t]*(?:function\s+)?(\w+)\s*\(\)\s*\{/gm)) {
        add(m[1] ?? "", "function", m.index ?? 0, true);
      }
      break;
    }
    case "sql": {
      for (const m of code.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?["`\[]?([\w.]+)/gi)) {
        add(m[2] ?? "", (m[1] ?? "object").toLowerCase(), m.index ?? 0, true);
      }
      break;
    }
    case "graphql": {
      for (const m of code.matchAll(/^[ \t]*(type|input|enum|interface|union|scalar)\s+(\w+)/gm)) {
        add(m[2] ?? "", m[1] ?? "type", m.index ?? 0, true);
      }
      break;
    }
    default:
      break;
  }
  return out.slice(0, 200);
}

function extractSummary(raw: string, lang: LanguageSpec): string | null {
  const lines = raw.split(/\r?\n/);

  if (lang.id === "markdown") {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.startsWith("<!--")) continue;
      return trimmed.slice(0, 300);
    }
    return null;
  }

  if (lang.id === "python") {
    const m = /^[ \t]*(?:"""|''')([\s\S]{0,400}?)(?:"""|''')/.exec(raw);
    if (m?.[1]) return m[1].trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").slice(0, 300) ?? null;
  }

  if (lang.comment === "c") {
    const block = /^[ \t]*\/\*\*?([\s\S]{0,600}?)\*\//.exec(raw);
    if (block?.[1]) {
      const text = block[1]
        .split("\n")
        .map((l) => l.replace(/^[ \t]*\*\s?/, "").trim())
        .filter(Boolean)
        .join(" ");
      if (text) return text.slice(0, 300);
    }
  }

  const prefix = lang.comment === "hash" ? "#" : "//";
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length) break;
      continue;
    }
    if (trimmed.startsWith("#!")) continue;
    if (!trimmed.startsWith(prefix)) break;
    collected.push(trimmed.slice(prefix.length).trim());
    if (collected.length >= 5) break;
  }
  const summary = collected.filter(Boolean).join(" ").trim();
  return summary ? summary.slice(0, 300) : null;
}

function extractTodos(raw: string): TodoInfo[] {
  const out: TodoInfo[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = TODO_RE.exec(lines[i] ?? "");
    if (!m) continue;
    if (m[1] === "NOTE" && !/\bNOTE:/.test(lines[i] ?? "")) continue;
    out.push({ tag: m[1] ?? "TODO", text: (m[2] ?? "").trim(), line: i + 1 });
    if (out.length >= 50) break;
  }
  return out;
}

/** Dependencies declared by a manifest file, so package nodes exist even without imports. */
function extractDeclaredDependencies(relPath: string, raw: string): string[] {
  const base = relPath.split("/").pop()?.toLowerCase() ?? "";
  const out = new Set<string>();
  try {
    if (base === "package.json") {
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = pkg[field];
        if (deps && typeof deps === "object") {
          for (const name of Object.keys(deps as Record<string, unknown>)) out.add(name);
        }
      }
    }
  } catch {
    // A malformed manifest simply contributes no dependencies.
  }
  if (base === "requirements.txt") {
    for (const line of raw.split(/\r?\n/)) {
      const m = /^[ \t]*([A-Za-z0-9_.-]+)\s*(?:[<>=!~]|$)/.exec(line);
      if (m?.[1] && !line.trim().startsWith("#")) out.add(m[1]);
    }
  }
  if (base === "go.mod") {
    for (const m of raw.matchAll(/^[ \t]*(?:require\s+)?([\w.\-]+\.[\w.\-]+\/[^\s]+)\s+v/gm)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return [...out].slice(0, 300);
}

export function analyze(relPath: string, ext: string, raw: string): Analysis {
  const language = detectLanguage(relPath, ext);
  const code = stripComments(raw, language.comment);
  const headings =
    language.id === "markdown"
      ? [...raw.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => `${"#".repeat((m[1] ?? "#").length)} ${(m[2] ?? "").trim()}`).slice(0, 60)
      : [];
  const wikilinks =
    language.id === "markdown" ? extractLinks(raw).map((l) => l.target).slice(0, 100) : [];

  return {
    language,
    lines: raw.length === 0 ? 0 : raw.split(/\r?\n/).length,
    bytes: Buffer.byteLength(raw, "utf8"),
    imports: extractImports(code, language, relPath),
    symbols: extractSymbols(code, language),
    todos: extractTodos(raw),
    headings,
    wikilinks,
    summary: extractSummary(raw, language),
    declaredDependencies: extractDeclaredDependencies(relPath, raw),
  };
}

/** Metadata-only analysis for files too large to read. */
export function analyzeStub(relPath: string, ext: string, bytes: number): Analysis {
  return {
    language: detectLanguage(relPath, ext),
    lines: 0,
    bytes,
    imports: [],
    symbols: [],
    todos: [],
    headings: [],
    wikilinks: [],
    summary: null,
    declaredDependencies: [],
  };
}
