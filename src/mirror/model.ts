import type { Analysis, SymbolInfo, TodoInfo } from "./analyzer.js";
import { resolveImport, isNodeBuiltin, packageNameOf, type ResolveContext, type ResolvedImport } from "./resolver.js";
import type { SourceFile } from "./scanner.js";
import { dirToNoteName, packageToNoteName, pathToNoteName, tagSegment } from "../util/slug.js";

/**
 * The in-memory graph of the project, built once per sync.
 *
 * Note identity is decided here and nowhere else: every renderer and the
 * visualiser both read `noteId` from this model, so a link target can never
 * drift from the note that was actually written.
 */

export interface FileEntry {
  relPath: string;
  ext: string;
  size: number;
  mtimeMs: number;
  tooLarge: boolean;
  analysis: Analysis;
  /** Resolved outgoing imports. */
  imports: ResolvedImport[];
  /** Project-relative paths of files importing this one. */
  importedBy: string[];
  /** External package names this file depends on. */
  packages: string[];
  noteId: string;
  noteName: string;
  /** Parent directory, "" for repository root. */
  dir: string;
}

export interface ModuleEntry {
  dir: string;
  /** "" for the repository root. */
  parent: string | null;
  childDirs: string[];
  files: string[];
  noteId: string;
  noteName: string;
  /** Total lines across files directly in this directory. */
  lines: number;
}

export interface PackageEntry {
  name: string;
  builtin: boolean;
  usedBy: string[];
  /** True when the package appears in a manifest rather than only in imports. */
  declared: boolean;
  noteId: string;
  noteName: string;
}

export interface CodeModel {
  projectName: string;
  files: Map<string, FileEntry>;
  modules: Map<string, ModuleEntry>;
  packages: Map<string, PackageEntry>;
  generatedAt: string;
}

export interface BuildOptions {
  projectName: string;
  filesFolder: string;
  modulesFolder: string;
  packagesFolder: string;
  emitPackages: boolean;
  emitModules: boolean;
}

export function fileNoteName(relPath: string): string {
  return pathToNoteName(relPath);
}

export function moduleNoteName(dir: string, projectName: string): string {
  return dir === "" ? projectName : dirToNoteName(dir);
}

export function buildModel(
  sources: Array<{ file: SourceFile; analysis: Analysis }>,
  directories: string[],
  options: BuildOptions,
): CodeModel {
  const knownFiles = new Set(sources.map((s) => s.file.relPath));
  const knownDirs = new Set(directories);
  const ctx: ResolveContext = { knownFiles, knownDirs };

  const files = new Map<string, FileEntry>();
  for (const { file, analysis } of sources) {
    const dir = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/")) : "";
    files.set(file.relPath, {
      relPath: file.relPath,
      ext: file.ext,
      size: file.size,
      mtimeMs: file.mtimeMs,
      tooLarge: file.tooLarge,
      analysis,
      imports: [],
      importedBy: [],
      packages: [],
      noteId: `${options.filesFolder}/${fileNoteName(file.relPath)}`,
      noteName: fileNoteName(file.relPath),
      dir,
    });
  }

  const packages = new Map<string, PackageEntry>();
  const addPackage = (name: string, user: string, declared: boolean) => {
    if (!options.emitPackages || !name) return;
    let entry = packages.get(name);
    if (!entry) {
      entry = {
        name,
        builtin: isNodeBuiltin(name),
        usedBy: [],
        declared: false,
        noteId: `${options.packagesFolder}/${packageToNoteName(name)}`,
        noteName: packageToNoteName(name),
      };
      packages.set(name, entry);
    }
    if (declared) entry.declared = true;
    if (user && !entry.usedBy.includes(user)) entry.usedBy.push(user);
  };

  // Resolve imports now that every file is known.
  for (const entry of files.values()) {
    const resolved: ResolvedImport[] = [];
    for (const imp of entry.analysis.imports) {
      const result = resolveImport(imp, entry.relPath, entry.analysis.language, ctx);
      resolved.push(result);
      if (result.kind === "internal") {
        if (result.target === entry.relPath) continue;
        const target = files.get(result.target);
        if (target && !target.importedBy.includes(entry.relPath)) {
          target.importedBy.push(entry.relPath);
        }
      } else if (result.kind === "package") {
        const name = packageNameOf(result.name);
        if (!entry.packages.includes(name)) entry.packages.push(name);
        addPackage(name, entry.relPath, false);
      }
    }
    entry.imports = resolved;
    for (const dep of entry.analysis.declaredDependencies) {
      addPackage(dep, entry.relPath, true);
    }
  }

  const modules = new Map<string, ModuleEntry>();
  if (options.emitModules) {
    const allDirs = new Set<string>([""]);
    for (const dir of directories) allDirs.add(dir);
    for (const entry of files.values()) allDirs.add(entry.dir);

    for (const dir of allDirs) {
      modules.set(dir, {
        dir,
        parent: dir === "" ? null : dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "",
        childDirs: [],
        files: [],
        noteId: `${options.modulesFolder}/${moduleNoteName(dir, options.projectName)}`,
        noteName: moduleNoteName(dir, options.projectName),
        lines: 0,
      });
    }
    for (const module of modules.values()) {
      if (module.parent === null) continue;
      const parent = modules.get(module.parent);
      if (parent && !parent.childDirs.includes(module.dir)) parent.childDirs.push(module.dir);
    }
    for (const entry of files.values()) {
      const module = modules.get(entry.dir);
      if (!module) continue;
      module.files.push(entry.relPath);
      module.lines += entry.analysis.lines;
    }
    for (const module of modules.values()) {
      module.files.sort();
      module.childDirs.sort();
    }
  }

  for (const entry of files.values()) {
    entry.importedBy.sort();
    entry.packages.sort();
  }
  for (const pkg of packages.values()) pkg.usedBy.sort();

  return {
    projectName: options.projectName,
    files,
    modules,
    packages,
    generatedAt: new Date().toISOString(),
  };
}

/** Tags applied to a generated file note. */
export function fileTags(entry: FileEntry): string[] {
  const tags = ["sbv/file", `code/${tagSegment(entry.analysis.language.id)}`];
  if (entry.dir) tags.push(`module/${tagSegment(entry.dir.replace(/\//g, "-"))}`);
  if (entry.analysis.todos.length) tags.push("sbv/todo");
  if (entry.importedBy.length === 0 && entry.imports.length === 0) tags.push("sbv/isolated");
  return tags;
}

export interface ModelStats {
  fileCount: number;
  moduleCount: number;
  packageCount: number;
  totalLines: number;
  internalEdges: number;
  packageEdges: number;
  unresolved: number;
  todoCount: number;
  byLanguage: Array<{ language: string; files: number; lines: number }>;
}

export function modelStats(model: CodeModel): ModelStats {
  let totalLines = 0;
  let internalEdges = 0;
  let packageEdges = 0;
  let unresolved = 0;
  let todoCount = 0;
  const byLanguage = new Map<string, { files: number; lines: number }>();

  for (const entry of model.files.values()) {
    totalLines += entry.analysis.lines;
    todoCount += entry.analysis.todos.length;
    for (const imp of entry.imports) {
      if (imp.kind === "internal") internalEdges += 1;
      else if (imp.kind === "package") packageEdges += 1;
      else unresolved += 1;
    }
    const key = entry.analysis.language.label;
    const bucket = byLanguage.get(key) ?? { files: 0, lines: 0 };
    bucket.files += 1;
    bucket.lines += entry.analysis.lines;
    byLanguage.set(key, bucket);
  }

  return {
    fileCount: model.files.size,
    moduleCount: model.modules.size,
    packageCount: model.packages.size,
    totalLines,
    internalEdges,
    packageEdges,
    unresolved,
    todoCount,
    byLanguage: [...byLanguage.entries()]
      .map(([language, v]) => ({ language, ...v }))
      .sort((a, b) => b.lines - a.lines),
  };
}

/** Symbols worth surfacing in a note, exported first. */
export function rankSymbols(symbols: SymbolInfo[], limit = 40): SymbolInfo[] {
  return [...symbols]
    .sort((a, b) => {
      if (a.exported !== b.exported) return a.exported ? -1 : 1;
      return a.line - b.line;
    })
    .slice(0, limit);
}

export function rankTodos(todos: TodoInfo[], limit = 20): TodoInfo[] {
  return todos.slice(0, limit);
}
