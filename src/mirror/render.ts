import path from "node:path";
import type { CodeModel, FileEntry, ModuleEntry, PackageEntry, ModelStats } from "./model.js";
import { fileTags, modelStats, rankSymbols, rankTodos } from "./model.js";
import { tableCell, wikilink } from "../util/markdown.js";

/**
 * Markdown renderers for generated notes.
 *
 * Every outgoing link is a wikilink to a full vault path with a human-readable
 * alias: the path keeps resolution unambiguous even if a user note happens to
 * share a basename, and the alias keeps the note readable and the graph labels
 * meaningful.
 */

export interface RenderContext {
  model: CodeModel;
  /** Vault-relative folder holding the dashboard. */
  metaFolder: string;
  dashboardName: string;
  /** Include a source excerpt of this many lines; 0 disables. */
  excerptLines: number;
  /** Absolute path of the project root, for `file://` links. */
  projectRoot: string;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function linkToFile(model: CodeModel, relPath: string): string {
  const entry = model.files.get(relPath);
  if (!entry) return `\`${relPath}\``;
  return wikilink(entry.noteId, relPath);
}

function linkToModule(model: CodeModel, dir: string): string | null {
  const module = model.modules.get(dir);
  if (!module) return null;
  return wikilink(module.noteId, dir === "" ? model.projectName : `${dir}/`);
}

function linkToPackage(model: CodeModel, name: string): string {
  const pkg = model.packages.get(name);
  if (!pkg) return `\`${name}\``;
  return wikilink(pkg.noteId, name);
}

function bulletList(items: string[], emptyText: string): string {
  if (items.length === 0) return `_${emptyText}_`;
  return items.map((item) => `- ${item}`).join("\n");
}

/** A file note: what it is, what it depends on, and what depends on it. */
export function renderFileNote(entry: FileEntry, ctx: RenderContext): string {
  const { model } = ctx;
  const lines: string[] = [];
  const a = entry.analysis;

  lines.push(`# ${entry.relPath}`);
  lines.push("");
  if (a.summary) {
    lines.push(`> ${a.summary}`);
    lines.push("");
  }

  const moduleLink = linkToModule(model, entry.dir);
  const facts = [
    `**Language:** ${a.language.label}`,
    `**Lines:** ${a.lines}`,
    `**Size:** ${humanBytes(entry.size)}`,
  ];
  if (moduleLink) facts.push(`**Module:** ${moduleLink}`);
  lines.push(facts.join(" · "));
  lines.push("");

  if (entry.tooLarge) {
    lines.push("> [!note] Indexed by metadata only");
    lines.push("> This file is larger than the configured size limit, so its contents were not parsed.");
    lines.push("");
  }

  const internalImports = entry.imports.filter((i) => i.kind === "internal");
  const packageImports = [...new Set(entry.packages)];
  const unresolved = entry.imports.filter((i) => i.kind === "unresolved");

  lines.push("## Depends on");
  lines.push("");
  const depItems = [
    ...internalImports.map((i) => (i.kind === "internal" ? linkToFile(model, i.target) : "")),
    ...packageImports.map((name) => `${linkToPackage(model, name)} _(package)_`),
  ].filter(Boolean);
  lines.push(bulletList(depItems, "No dependencies."));
  lines.push("");

  lines.push("## Used by");
  lines.push("");
  lines.push(bulletList(entry.importedBy.map((p) => linkToFile(model, p)), "Nothing imports this file yet."));
  lines.push("");

  if (a.symbols.length) {
    const ranked = rankSymbols(a.symbols);
    lines.push("## Symbols");
    lines.push("");
    lines.push("| Name | Kind | Line | Exported |");
    lines.push("| --- | --- | --- | --- |");
    for (const symbol of ranked) {
      lines.push(
        `| \`${tableCell(symbol.name)}\` | ${symbol.kind} | ${symbol.line} | ${symbol.exported ? "yes" : "no"} |`,
      );
    }
    if (a.symbols.length > ranked.length) {
      lines.push("");
      lines.push(`_…and ${a.symbols.length - ranked.length} more._`);
    }
    lines.push("");
  }

  if (a.headings.length) {
    lines.push("## Outline");
    lines.push("");
    for (const heading of a.headings.slice(0, 30)) {
      const depth = (/^#+/.exec(heading)?.[0].length ?? 1) - 1;
      lines.push(`${"  ".repeat(Math.max(0, depth))}- ${heading.replace(/^#+\s*/, "")}`);
    }
    lines.push("");
  }

  if (a.todos.length) {
    lines.push("## Open markers");
    lines.push("");
    for (const todo of rankTodos(a.todos)) {
      lines.push(`- [ ] **${todo.tag}** (line ${todo.line}) ${todo.text}`);
    }
    lines.push("");
  }

  if (unresolved.length) {
    lines.push("## Unresolved imports");
    lines.push("");
    lines.push(bulletList(unresolved.map((i) => `\`${i.specifier}\``), "None."));
    lines.push("");
  }

  const absolute = path.join(ctx.projectRoot, entry.relPath);
  lines.push("---");
  lines.push(`[Open in editor](file://${encodeURI(absolute)})`);

  return lines.join("\n");
}

/** A module note: the directory as a hub linking its files and subdirectories. */
export function renderModuleNote(module: ModuleEntry, ctx: RenderContext): string {
  const { model } = ctx;
  const lines: string[] = [];
  const title = module.dir === "" ? model.projectName : `${module.dir}/`;

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `**Files:** ${module.files.length} · **Subfolders:** ${module.childDirs.length} · **Lines:** ${module.lines}`,
  );
  lines.push("");

  if (module.parent !== null) {
    const parentLink = linkToModule(model, module.parent);
    if (parentLink) {
      lines.push(`Parent: ${parentLink}`);
      lines.push("");
    }
  }

  if (module.childDirs.length) {
    lines.push("## Subfolders");
    lines.push("");
    lines.push(
      bulletList(
        module.childDirs.map((dir) => linkToModule(model, dir) ?? `\`${dir}\``),
        "None.",
      ),
    );
    lines.push("");
  }

  lines.push("## Files");
  lines.push("");
  if (module.files.length === 0) {
    lines.push("_No files directly in this folder._");
  } else {
    lines.push("| File | Language | Lines | Used by |");
    lines.push("| --- | --- | --- | --- |");
    for (const relPath of module.files) {
      const entry = model.files.get(relPath);
      if (!entry) continue;
      lines.push(
        `| ${linkToFile(model, relPath)} | ${entry.analysis.language.label} | ${entry.analysis.lines} | ${entry.importedBy.length} |`,
      );
    }
  }
  lines.push("");

  // Cross-module traffic makes architectural coupling visible at a glance.
  const outbound = new Set<string>();
  const inbound = new Set<string>();
  for (const relPath of module.files) {
    const entry = model.files.get(relPath);
    if (!entry) continue;
    for (const imp of entry.imports) {
      if (imp.kind !== "internal") continue;
      const target = model.files.get(imp.target);
      if (target && target.dir !== module.dir) outbound.add(target.dir);
    }
    for (const importer of entry.importedBy) {
      const source = model.files.get(importer);
      if (source && source.dir !== module.dir) inbound.add(source.dir);
    }
  }

  if (outbound.size || inbound.size) {
    lines.push("## Coupling");
    lines.push("");
    lines.push(
      `**Imports from:** ${[...outbound].sort().map((d) => linkToModule(model, d) ?? d).join(", ") || "_none_"}`,
    );
    lines.push("");
    lines.push(
      `**Imported by:** ${[...inbound].sort().map((d) => linkToModule(model, d) ?? d).join(", ") || "_none_"}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/** A package note: one hub per external dependency. */
export function renderPackageNote(pkg: PackageEntry, ctx: RenderContext): string {
  const { model } = ctx;
  const lines: string[] = [];
  lines.push(`# ${pkg.name}`);
  lines.push("");
  const kind = pkg.builtin ? "Node builtin" : "External package";
  lines.push(`**Type:** ${kind} · **Used by:** ${pkg.usedBy.length} file(s)${pkg.declared ? " · declared in manifest" : ""}`);
  lines.push("");
  lines.push("## Imported by");
  lines.push("");
  lines.push(bulletList(pkg.usedBy.map((p) => linkToFile(model, p)), "Declared but not imported anywhere."));
  lines.push("");
  if (!pkg.builtin) {
    lines.push("---");
    lines.push(`[npm](https://www.npmjs.com/package/${encodeURIComponent(pkg.name)})`);
  }
  return lines.join("\n");
}

/** The dashboard: the note a person opens first. */
export function renderDashboard(ctx: RenderContext, stats: ModelStats): string {
  const { model } = ctx;
  const lines: string[] = [];

  lines.push(`# ${model.projectName}`);
  lines.push("");
  lines.push(`_Mirrored from \`${ctx.projectRoot}\`. Last sync: ${model.generatedAt}._`);
  lines.push("");

  lines.push("## At a glance");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Files | ${stats.fileCount} |`);
  lines.push(`| Lines | ${stats.totalLines} |`);
  lines.push(`| Modules | ${stats.moduleCount} |`);
  lines.push(`| Packages | ${stats.packageCount} |`);
  lines.push(`| Internal links | ${stats.internalEdges} |`);
  lines.push(`| Open markers | ${stats.todoCount} |`);
  lines.push("");

  const root = linkToModule(model, "");
  if (root) {
    lines.push(`Start exploring: ${root}`);
    lines.push("");
  }

  if (stats.byLanguage.length) {
    lines.push("## Languages");
    lines.push("");
    lines.push("| Language | Files | Lines |");
    lines.push("| --- | --- | --- |");
    for (const row of stats.byLanguage.slice(0, 12)) {
      lines.push(`| ${row.language} | ${row.files} | ${row.lines} |`);
    }
    lines.push("");
  }

  // Most-depended-upon files are the ones worth understanding first.
  const hubs = [...model.files.values()]
    .filter((f) => f.importedBy.length > 0)
    .sort((a, b) => b.importedBy.length - a.importedBy.length)
    .slice(0, 12);
  if (hubs.length) {
    lines.push("## Most depended on");
    lines.push("");
    for (const entry of hubs) {
      lines.push(`- ${linkToFile(model, entry.relPath)} — ${entry.importedBy.length} dependents`);
    }
    lines.push("");
  }

  const heaviest = [...model.files.values()]
    .sort((a, b) => b.analysis.lines - a.analysis.lines)
    .slice(0, 10);
  if (heaviest.length) {
    lines.push("## Largest files");
    lines.push("");
    for (const entry of heaviest) {
      lines.push(`- ${linkToFile(model, entry.relPath)} — ${entry.analysis.lines} lines`);
    }
    lines.push("");
  }

  const todoFiles = [...model.files.values()]
    .filter((f) => f.analysis.todos.length > 0)
    .sort((a, b) => b.analysis.todos.length - a.analysis.todos.length)
    .slice(0, 10);
  if (todoFiles.length) {
    lines.push("## Files with open markers");
    lines.push("");
    for (const entry of todoFiles) {
      lines.push(`- ${linkToFile(model, entry.relPath)} — ${entry.analysis.todos.length}`);
    }
    lines.push("");
  }

  const orphans = [...model.files.values()]
    .filter((f) => f.importedBy.length === 0 && f.imports.every((i) => i.kind !== "internal"))
    .slice(0, 15);
  if (orphans.length) {
    lines.push("## Unconnected files");
    lines.push("");
    lines.push("_Nothing imports these and they import nothing internal — entry points, configs, or dead code._");
    lines.push("");
    for (const entry of orphans) {
      lines.push(`- ${linkToFile(model, entry.relPath)}`);
    }
    lines.push("");
  }

  lines.push("## How this vault works");
  lines.push("");
  lines.push("- **Codebase/Files** — one note per source file, linked by its imports.");
  lines.push("- **Codebase/Modules** — one note per folder, linking its files.");
  lines.push("- **Codebase/Packages** — one note per external dependency.");
  lines.push("- **Concepts / Decisions / Sessions** — written by you and by Claude, and free to link into the code notes above.");
  lines.push("");
  lines.push("Anything you write outside the `sbv:begin`/`sbv:end` markers in a generated note is preserved across syncs.");

  return lines.join("\n");
}

export function dashboardStats(model: CodeModel): ModelStats {
  return modelStats(model);
}

export { fileTags };
