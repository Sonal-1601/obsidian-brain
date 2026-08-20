import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../config.js";
import { Vault } from "../vault/vault.js";
import { scanProject } from "./scanner.js";
import { analyze, analyzeStub, type Analysis } from "./analyzer.js";
import { AnalysisCache } from "./cache.js";
import { buildModel, fileTags, modelStats, type CodeModel, type ModelStats } from "./model.js";
import {
  renderDashboard,
  renderFileNote,
  renderModuleNote,
  renderPackageNote,
  type RenderContext,
} from "./render.js";
import { ensureDir, toPosix } from "../util/fsx.js";
import { log } from "../util/log.js";

export interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  orphaned: number;
}

export interface SyncReport {
  counts: SyncCounts;
  stats: ModelStats;
  durationMs: number;
  model: CodeModel;
  /** Note ids touched in this run, for journal and live-reload consumers. */
  changedNotes: string[];
}

export const DASHBOARD_NAME = "Dashboard";

function emptyCounts(): SyncCounts {
  return { created: 0, updated: 0, unchanged: 0, deleted: 0, orphaned: 0 };
}

function tally(counts: SyncCounts, status: "created" | "updated" | "unchanged"): void {
  counts[status] += 1;
}

/**
 * One full pass: scan the project, analyse what changed, rebuild the model, and
 * reconcile the vault against it.
 *
 * The whole pipeline is idempotent — running it twice with no source changes
 * writes nothing the second time, which is what makes watch mode safe to run
 * continuously alongside Obsidian.
 */
export async function runSync(
  config: Config,
  options: { vault?: Vault; cache?: AnalysisCache } = {},
): Promise<SyncReport> {
  const started = Date.now();
  const vault = options.vault ?? new Vault(config);
  await vault.ensure();
  await ensureDir(vault.paths.stateDir);

  const cache = options.cache ?? (await AnalysisCache.load(vault.paths.stateDir));

  const scan = await scanProject(config, {
    projectRoot: vault.paths.projectRoot,
    // Never mirror the vault into itself, and never mirror our own state.
    denyRoots: [vault.paths.vaultRoot, vault.paths.stateDir],
  });

  const sources: Array<{ file: (typeof scan.files)[number]; analysis: Analysis }> = [];
  for (const file of scan.files) {
    let analysis = cache.get(file.relPath, file.size, file.mtimeMs);
    if (!analysis) {
      if (file.tooLarge) {
        analysis = analyzeStub(file.relPath, file.ext, file.size);
      } else {
        try {
          const raw = await fs.readFile(file.absPath, "utf8");
          analysis = analyze(file.relPath, file.ext, raw);
        } catch (error) {
          log.debug(`could not read ${file.relPath}: ${(error as Error).message}`);
          analysis = analyzeStub(file.relPath, file.ext, file.size);
        }
      }
      cache.set(file.relPath, file.size, file.mtimeMs, analysis);
    }
    sources.push({ file, analysis });
  }
  cache.retain(new Set(scan.files.map((f) => f.relPath)));

  const filesFolder = `${config.mirror.folder}/Files`;
  const modulesFolder = `${config.mirror.folder}/Modules`;
  const packagesFolder = `${config.mirror.folder}/Packages`;

  const model = buildModel(sources, scan.directories, {
    projectName: config.projectName,
    filesFolder,
    modulesFolder,
    packagesFolder,
    emitPackages: config.mirror.emitPackages,
    emitModules: config.mirror.emitModules,
  });

  const ctx: RenderContext = {
    model,
    metaFolder: config.vault.metaFolder,
    dashboardName: DASHBOARD_NAME,
    excerptLines: config.mirror.excerptLines,
    projectRoot: vault.paths.projectRoot,
  };

  const counts = emptyCounts();
  const changedNotes: string[] = [];
  const keepFiles = new Set<string>();
  const keepModules = new Set<string>();
  const keepPackages = new Set<string>();

  for (const entry of model.files.values()) {
    keepFiles.add(entry.noteId);
    const result = await vault.upsertManaged({
      folder: filesFolder,
      name: entry.noteName,
      kind: "file",
      frontmatter: {
        source_path: entry.relPath,
        language: entry.analysis.language.id,
        lines: entry.analysis.lines,
        bytes: entry.size,
        dependencies: entry.imports.filter((i) => i.kind === "internal").length,
        dependents: entry.importedBy.length,
        updated: new Date(entry.mtimeMs).toISOString(),
        tags: fileTags(entry),
      },
      managedBody: renderFileNote(entry, ctx),
    });
    tally(counts, result.status);
    if (result.status !== "unchanged") changedNotes.push(result.ref.id);
  }

  if (config.mirror.emitModules) {
    for (const module of model.modules.values()) {
      keepModules.add(module.noteId);
      const result = await vault.upsertManaged({
        folder: modulesFolder,
        name: module.noteName,
        kind: "module",
        frontmatter: {
          source_dir: module.dir || ".",
          files: module.files.length,
          subfolders: module.childDirs.length,
          lines: module.lines,
          tags: ["sbv/module"],
        },
        managedBody: renderModuleNote(module, ctx),
      });
      tally(counts, result.status);
      if (result.status !== "unchanged") changedNotes.push(result.ref.id);
    }
  }

  if (config.mirror.emitPackages) {
    for (const pkg of model.packages.values()) {
      keepPackages.add(pkg.noteId);
      const result = await vault.upsertManaged({
        folder: packagesFolder,
        name: pkg.noteName,
        kind: "package",
        frontmatter: {
          package: pkg.name,
          builtin: pkg.builtin,
          used_by: pkg.usedBy.length,
          tags: ["sbv/package", pkg.builtin ? "package/builtin" : "package/external"],
        },
        managedBody: renderPackageNote(pkg, ctx),
      });
      tally(counts, result.status);
      if (result.status !== "unchanged") changedNotes.push(result.ref.id);
    }
  }

  const stats = modelStats(model);
  // The dashboard embeds a sync timestamp, which would otherwise make it the
  // one note that rewrites on every single pass. Hash a timestamp-free variant
  // so it is only rewritten when the project actually changed.
  const dashboardBody = renderDashboard(ctx, stats);
  const dashboardHashInput = dashboardBody.replace(model.generatedAt, "");
  const dashboard = await vault.upsertManaged({
    folder: config.vault.metaFolder,
    name: DASHBOARD_NAME,
    kind: "dashboard",
    frontmatter: {
      project: config.projectName,
      files: stats.fileCount,
      lines: stats.totalLines,
      tags: ["sbv/dashboard"],
    },
    managedBody: dashboardBody,
    hashInput: dashboardHashInput,
  });
  tally(counts, dashboard.status);
  if (dashboard.status !== "unchanged") changedNotes.push(dashboard.ref.id);

  if (config.mirror.pruneOrphans) {
    const filePrune = await vault.pruneManaged(filesFolder, keepFiles, "file");
    counts.deleted += filePrune.deleted.length;
    counts.orphaned += filePrune.orphaned.length;
    changedNotes.push(...filePrune.deleted, ...filePrune.orphaned);

    if (config.mirror.emitModules) {
      const modulePrune = await vault.pruneManaged(modulesFolder, keepModules, "module");
      counts.deleted += modulePrune.deleted.length;
      counts.orphaned += modulePrune.orphaned.length;
      changedNotes.push(...modulePrune.deleted, ...modulePrune.orphaned);
    }
    if (config.mirror.emitPackages) {
      const packagePrune = await vault.pruneManaged(packagesFolder, keepPackages, "package");
      counts.deleted += packagePrune.deleted.length;
      counts.orphaned += packagePrune.orphaned.length;
      changedNotes.push(...packagePrune.deleted, ...packagePrune.orphaned);
    }
    await vault.cleanEmptyDirs(path.join(vault.root, config.mirror.folder));
  }

  await cache.save();

  return {
    counts,
    stats,
    durationMs: Date.now() - started,
    model,
    changedNotes,
  };
}

export function formatSyncReport(report: SyncReport, vaultRoot: string): string {
  const c = report.counts;
  const parts = [
    `${c.created} created`,
    `${c.updated} updated`,
    `${c.unchanged} unchanged`,
  ];
  if (c.deleted) parts.push(`${c.deleted} deleted`);
  if (c.orphaned) parts.push(`${c.orphaned} orphaned`);
  return `${parts.join(", ")} in ${report.durationMs}ms -> ${toPosix(vaultRoot)}`;
}
