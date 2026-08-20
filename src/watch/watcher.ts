import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Config } from "../config.js";
import { Vault } from "../vault/vault.js";
import { AnalysisCache } from "../mirror/cache.js";
import { runSync, type SyncReport } from "../mirror/sync.js";
import { writeJournalEntry } from "./journal.js";
import { isInside, toPosix } from "../util/fsx.js";
import { DEFAULT_EXCLUDES } from "../config.js";
import { log } from "../util/log.js";

/**
 * Watches the project and re-syncs the vault.
 *
 * Two behaviours matter more than raw speed here. First, events are coalesced:
 * a save that triggers a formatter, a bundler, and a test run can emit dozens
 * of events in a few hundred milliseconds, and they should produce exactly one
 * sync. Second, syncs never overlap — a run in progress sets a flag, and any
 * events arriving mid-run schedule exactly one follow-up pass.
 */

export interface WatcherEvents {
  onSync?: (report: SyncReport, changedPaths: string[]) => void | Promise<void>;
  onError?: (error: Error) => void;
  onReady?: () => void;
}

export interface WatcherHandle {
  close: () => Promise<void>;
  /** Force a sync now, bypassing the debounce. */
  syncNow: () => Promise<SyncReport>;
}

export async function startWatcher(
  config: Config,
  events: WatcherEvents = {},
): Promise<WatcherHandle> {
  const vault = new Vault(config);
  await vault.ensure();
  const cache = await AnalysisCache.load(vault.paths.stateDir);

  const projectRoot = vault.paths.projectRoot;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerunRequested = false;
  let pending = new Set<string>();
  let closed = false;

  const runOnce = async (): Promise<SyncReport> => {
    const changed = [...pending];
    pending = new Set();
    const report = await runSync(config, { vault, cache });

    if (config.watch.journal && (report.counts.created || report.counts.updated || report.counts.deleted)) {
      await writeJournalEntry(vault, config, report, changed).catch((error: unknown) => {
        log.warn(`journal entry failed: ${(error as Error).message}`);
      });
    }
    await events.onSync?.(report, changed);
    return report;
  };

  const drain = async (): Promise<void> => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      do {
        rerunRequested = false;
        await runOnce();
      } while (rerunRequested && !closed);
    } catch (error) {
      events.onError?.(error as Error);
      log.error(`sync failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, Math.max(50, config.watch.debounceMs));
  };

  // chokidar's `ignored` is consulted for directories too, so returning true
  // for an excluded directory prunes the whole subtree instead of walking it.
  const ignoredNames = new Set(
    DEFAULT_EXCLUDES.filter((p) => !p.includes("*")).map((p) => p.replace(/\/$/, "")),
  );
  const denyRoots = [vault.paths.vaultRoot, vault.paths.stateDir].map((p) => path.resolve(p));

  const ignored = (target: string): boolean => {
    const resolved = path.resolve(target);
    if (denyRoots.some((deny) => isInside(deny, resolved))) return true;
    const rel = toPosix(path.relative(projectRoot, resolved));
    if (rel.startsWith("..")) return true;
    for (const segment of rel.split("/")) {
      if (!segment) continue;
      if (ignoredNames.has(segment)) return true;
      if (segment.startsWith(".") && segment !== ".github" && segment !== ".claude") return true;
    }
    return false;
  };

  const watcher: FSWatcher = chokidar.watch(projectRoot, {
    ignored,
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  watcher.on("all", (event, changedPath) => {
    const rel = toPosix(path.relative(projectRoot, changedPath));
    // A changed file's cached analysis is stale by definition.
    if (event === "unlink" || event === "change" || event === "add") cache.delete(rel);
    pending.add(rel);
    log.debug(`${event} ${rel}`);
    schedule();
  });

  watcher.on("error", (error) => {
    events.onError?.(error as Error);
    log.error(`watcher error: ${(error as Error).message}`);
  });

  await new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });
  events.onReady?.();

  return {
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      await watcher.close();
      await cache.save();
    },
    syncNow: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return runOnce();
    },
  };
}
