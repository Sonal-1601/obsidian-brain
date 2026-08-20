import path from "node:path";
import type { Analysis } from "./analyzer.js";
import { languageById } from "./languages.js";
import { readFileOrNull, writeFileAtomic } from "../util/fsx.js";
import { log } from "../util/log.js";

/**
 * Persistent analysis cache.
 *
 * Re-parsing every file on every keystroke-triggered sync is the difference
 * between a watch loop that feels instant and one that does not. Entries are
 * keyed by size and mtime, which is the same heuristic build tools use.
 */

const CACHE_VERSION = 2;

interface CachedEntry {
  size: number;
  mtimeMs: number;
  languageId: string;
  analysis: Omit<Analysis, "language">;
}

interface CacheFile {
  version: number;
  entries: Record<string, CachedEntry>;
}

export class AnalysisCache {
  private entries = new Map<string, CachedEntry>();
  private dirty = false;

  private constructor(private readonly filePath: string) {}

  static async load(stateDir: string): Promise<AnalysisCache> {
    const cache = new AnalysisCache(path.join(stateDir, "analysis-cache.json"));
    const raw = await readFileOrNull(cache.filePath);
    if (!raw) return cache;
    try {
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_VERSION) return cache;
      for (const [key, value] of Object.entries(parsed.entries)) {
        cache.entries.set(key, value);
      }
    } catch (error) {
      log.debug(`ignoring unreadable analysis cache: ${(error as Error).message}`);
    }
    return cache;
  }

  get(relPath: string, size: number, mtimeMs: number): Analysis | null {
    const entry = this.entries.get(relPath);
    if (!entry) return null;
    if (entry.size !== size || entry.mtimeMs !== mtimeMs) return null;
    return { ...entry.analysis, language: languageById(entry.languageId) };
  }

  set(relPath: string, size: number, mtimeMs: number, analysis: Analysis): void {
    const { language, ...rest } = analysis;
    this.entries.set(relPath, { size, mtimeMs, languageId: language.id, analysis: rest });
    this.dirty = true;
  }

  delete(relPath: string): void {
    if (this.entries.delete(relPath)) this.dirty = true;
  }

  /** Drop entries for files that no longer exist, keeping the cache bounded. */
  retain(keep: Set<string>): void {
    for (const key of [...this.entries.keys()]) {
      if (!keep.has(key)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const payload: CacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    await writeFileAtomic(this.filePath, JSON.stringify(payload));
    this.dirty = false;
  }
}
