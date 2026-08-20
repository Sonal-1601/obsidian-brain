import path from "node:path";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import type { Config } from "../config.js";
import { DEFAULT_EXCLUDES } from "../config.js";
import { IgnoreSet, parseIgnoreFile } from "../util/ignore.js";
import { isInside, readFileOrNull, toPosix } from "../util/fsx.js";
import { log } from "../util/log.js";

export interface SourceFile {
  /** Project-relative posix path, e.g. `src/mirror/scanner.ts`. */
  relPath: string;
  absPath: string;
  /** Lowercased extension including the dot, e.g. `.ts`. */
  ext: string;
  size: number;
  mtimeMs: number;
  /** True when the file exceeded maxFileSizeKb and was not read. */
  tooLarge: boolean;
}

export interface ScanResult {
  files: SourceFile[];
  /** Project-relative posix paths of every directory containing kept files. */
  directories: string[];
  skipped: number;
}

export interface ScanOptions {
  projectRoot: string;
  /** Absolute paths that must never be scanned (the vault, the state dir). */
  denyRoots?: string[];
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".class", ".jar", ".wasm",
  ".sqlite", ".db", ".pyc", ".pyo",
]);

/**
 * Walks the project and returns the files worth mirroring.
 *
 * Three filters compose here, in order of cost: the built-in exclude list and
 * config excludes (cheap, applied to directory names before descending),
 * .gitignore rules collected per-directory, and finally the extension and size
 * limits. Anything inside the vault itself is refused outright — mirroring the
 * vault into the vault is an infinite regress.
 */
export async function scanProject(config: Config, options: ScanOptions): Promise<ScanResult> {
  const root = path.resolve(options.projectRoot);
  const deny = (options.denyRoots ?? []).map((p) => path.resolve(p));
  const extensions = new Set(config.source.extensions.map((e) => e.toLowerCase()));
  const maxBytes = Math.max(0, config.source.maxFileSizeKb) * 1024;

  const baseIgnore = new IgnoreSet();
  baseIgnore.addPatterns(DEFAULT_EXCLUDES);
  baseIgnore.addPatterns(config.source.exclude);

  const files: SourceFile[] = [];
  const directories = new Set<string>();
  let skipped = 0;

  const walk = async (dir: string, relDir: string, inherited: IgnoreSet): Promise<void> => {
    let ignoreSet = inherited;
    if (config.source.respectGitignore) {
      const gitignore = await readFileOrNull(path.join(dir, ".gitignore"));
      if (gitignore) {
        ignoreSet = inherited.clone();
        ignoreSet.add(parseIgnoreFile(gitignore, relDir));
      }
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      log.debug(`skipping unreadable directory ${dir}: ${(error as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (deny.some((d) => isInside(d, abs) || path.resolve(abs) === d)) continue;

      const isDot = entry.name.startsWith(".");
      if (isDot && !config.source.includeDotfiles) {
        // .github and .claude carry real project meaning; other dotfiles rarely do.
        const allowlisted = entry.isDirectory() && (entry.name === ".github" || entry.name === ".claude");
        if (!allowlisted) continue;
      }

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (ignoreSet.ignores(rel, true)) continue;
        await walk(abs, rel, ignoreSet);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ignoreSet.ignores(rel, false)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      if (extensions.size > 0 && !extensions.has(ext)) {
        // Extensionless files that are clearly project meta still earn a note.
        const keepAnyway = ext === "" && /^(dockerfile|makefile|procfile|justfile|readme|license)$/i.test(entry.name);
        if (!keepAnyway) {
          skipped += 1;
          continue;
        }
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }

      files.push({
        relPath: toPosix(rel),
        absPath: abs,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tooLarge: maxBytes > 0 && stat.size > maxBytes,
      });
      if (relDir) directories.add(toPosix(relDir));
    }
  };

  await walk(root, "", baseIgnore);

  // Register every ancestor directory so module notes form a full tree.
  const allDirs = new Set<string>();
  for (const dir of directories) {
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      allDirs.add(parts.slice(0, i).join("/"));
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    files,
    directories: [...allDirs].sort(),
    skipped,
  };
}
