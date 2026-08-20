import type { RawImport } from "./analyzer.js";
import type { LanguageSpec } from "./languages.js";

/**
 * Resolves import specifiers to project files.
 *
 * Everything is done against the in-memory set of scanned paths rather than the
 * filesystem, so a full resolve pass costs no I/O and stays correct during
 * incremental syncs.
 */

export type ResolvedImport =
  | { kind: "internal"; target: string; specifier: string; line: number }
  | { kind: "package"; name: string; specifier: string; line: number }
  | { kind: "unresolved"; specifier: string; line: number };

/** Normalise `a/./b/../c` without touching the filesystem. */
function normalize(p: string): string {
  const parts: string[] = [];
  for (const segment of p.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function join(base: string, rel: string): string {
  return normalize(base ? `${base}/${rel}` : rel);
}

/**
 * The npm package name for a specifier, e.g. `@scope/pkg/sub` -> `@scope/pkg`.
 * Node builtins are returned with their `node:` prefix stripped.
 */
export function packageNameOf(specifier: string): string {
  const clean = specifier.replace(/^node:/, "");
  if (clean.startsWith("@")) {
    const parts = clean.split("/");
    return parts.slice(0, 2).join("/");
  }
  return clean.split("/")[0] ?? clean;
}

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dgram", "dns",
  "events", "fs", "http", "http2", "https", "module", "net", "os", "path", "perf_hooks",
  "process", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
  "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(packageNameOf(specifier));
}

export interface ResolveContext {
  /** Every project-relative path known to the scanner. */
  knownFiles: Set<string>;
  /** Directories that exist in the project. */
  knownDirs: Set<string>;
}

/** Try a candidate path plus the language's extension and index variations. */
function tryCandidates(base: string, lang: LanguageSpec, ctx: ResolveContext): string | null {
  if (ctx.knownFiles.has(base)) return base;

  // TypeScript's NodeNext style writes `./foo.js` for a file that is `foo.ts`.
  const jsToTs = base.replace(/\.(js|mjs|cjs)$/, "");
  if (jsToTs !== base) {
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      if (ctx.knownFiles.has(jsToTs + ext)) return jsToTs + ext;
    }
  }

  for (const ext of lang.resolveExtensions) {
    if (ctx.knownFiles.has(base + ext)) return base + ext;
  }
  for (const index of lang.indexFiles) {
    const candidate = base ? `${base}/${index}` : index;
    if (ctx.knownFiles.has(candidate)) return candidate;
  }
  // Sass partials: `./vars` may live at `./_vars.scss`.
  const dir = dirname(base);
  const name = base.slice(dir ? dir.length + 1 : 0);
  if (name) {
    for (const ext of lang.resolveExtensions) {
      const partial = join(dir, `_${name}${ext}`);
      if (ctx.knownFiles.has(partial)) return partial;
    }
  }
  return null;
}

/** Python dotted modules, resolved from the file's package and from the root. */
function resolvePython(
  specifier: string,
  fromPath: string,
  lang: LanguageSpec,
  ctx: ResolveContext,
): string | null {
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const rest = specifier.slice(leadingDots).replace(/\./g, "/");

  if (leadingDots > 0) {
    let base = dirname(fromPath);
    for (let i = 1; i < leadingDots; i += 1) base = dirname(base);
    return tryCandidates(rest ? join(base, rest) : base, lang, ctx);
  }
  // Absolute-looking import: try from the project root, then from common source roots.
  const direct = tryCandidates(rest, lang, ctx);
  if (direct) return direct;
  for (const prefix of ["src", "lib", "app"]) {
    const candidate = tryCandidates(join(prefix, rest), lang, ctx);
    if (candidate) return candidate;
  }
  return null;
}

export function resolveImport(
  imp: RawImport,
  fromPath: string,
  lang: LanguageSpec,
  ctx: ResolveContext,
): ResolvedImport {
  const { specifier, line } = imp;

  if (imp.kind === "url") return { kind: "unresolved", specifier, line };

  if (lang.id === "python") {
    const target = resolvePython(specifier, fromPath, lang, ctx);
    if (target) return { kind: "internal", target, specifier, line };
    if (imp.kind === "relative") return { kind: "unresolved", specifier, line };
    return { kind: "package", name: packageNameOf(specifier.replace(/\./g, "/")), specifier, line };
  }

  if (imp.kind === "relative") {
    const base = join(dirname(fromPath), specifier);
    const target = tryCandidates(base, lang, ctx);
    if (target) return { kind: "internal", target, specifier, line };
    return { kind: "unresolved", specifier, line };
  }

  if (imp.kind === "absolute") {
    const target = tryCandidates(normalize(specifier), lang, ctx);
    if (target) return { kind: "internal", target, specifier, line };
    return { kind: "unresolved", specifier, line };
  }

  // Bare specifier. Many projects alias these to internal paths, so try the
  // common aliases before declaring it an external package.
  const stripped = specifier.replace(/^[~@#]?\//, "").replace(/^[~@#]/, "");
  for (const prefix of ["", "src/", "lib/", "app/"]) {
    const candidate = tryCandidates(normalize(prefix + stripped), lang, ctx);
    if (candidate) return { kind: "internal", target: candidate, specifier, line };
  }

  if (lang.id === "rust") {
    // `use crate::a::b` and `mod x` point inside the crate.
    const path = specifier.replace(/^crate::/, "").replace(/::.*$/, "").replace(/[{},;* ]/g, "");
    if (path) {
      const dir = dirname(fromPath);
      const candidate = tryCandidates(join(dir, path), lang, ctx);
      if (candidate) return { kind: "internal", target: candidate, specifier, line };
      const fromSrc = tryCandidates(join("src", path), lang, ctx);
      if (fromSrc) return { kind: "internal", target: fromSrc, specifier, line };
    }
    return { kind: "unresolved", specifier, line };
  }

  if (lang.id === "c") {
    const candidate = tryCandidates(join(dirname(fromPath), specifier), lang, ctx);
    if (candidate) return { kind: "internal", target: candidate, specifier, line };
  }

  if (lang.id === "markdown") {
    const candidate = tryCandidates(join(dirname(fromPath), specifier), lang, ctx);
    if (candidate) return { kind: "internal", target: candidate, specifier, line };
    return { kind: "unresolved", specifier, line };
  }

  return { kind: "package", name: packageNameOf(specifier), specifier, line };
}
