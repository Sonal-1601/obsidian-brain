import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { readFileOrNull, toPosix } from "./util/fsx.js";

export const CONFIG_FILENAME = "sbv.config.json";

export interface SourceConfig {
  /** Project root to mirror, relative to the config file. */
  root: string;
  /** Extra glob-ish exclusions on top of .gitignore and the built-in list. */
  exclude: string[];
  /** Only mirror files with these extensions. Empty means "every text file". */
  extensions: string[];
  /** Files larger than this are indexed by metadata only, never by content. */
  maxFileSizeKb: number;
  /** Honour .gitignore entries found in the project. */
  respectGitignore: boolean;
  /** Include dotfiles such as .env.example, .github/workflows. */
  includeDotfiles: boolean;
}

export interface MirrorConfig {
  /** Vault folder that holds all generated code notes. */
  folder: string;
  /** Emit a note per directory, linking to its children. */
  emitModules: boolean;
  /** Emit a note per external dependency (npm/pypi/etc). */
  emitPackages: boolean;
  /** Extract exported symbols into each file note. */
  emitSymbols: boolean;
  /** Include a fenced source excerpt in each file note. 0 disables it. */
  excerptLines: number;
  /** Delete generated notes whose source file disappeared. */
  pruneOrphans: boolean;
}

export interface VaultConfig {
  /** Absolute or config-relative path to the Obsidian vault folder. */
  path: string;
  /** Write .obsidian/* defaults tuned for graph view on init. */
  manageObsidianConfig: boolean;
  /** Folder for Claude-authored session logs. */
  sessionsFolder: string;
  /** Folder for concept notes. */
  conceptsFolder: string;
  /** Folder for decision records. */
  decisionsFolder: string;
  /** Folder for daily notes. */
  journalFolder: string;
  /** Folder for dashboards and generated indexes. */
  metaFolder: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Open the browser when `sbv serve` starts. */
  open: boolean;
}

export interface WatchConfig {
  /** Coalesce bursts of filesystem events into one sync. */
  debounceMs: number;
  /** Also write a dated journal entry summarising each sync. */
  journal: boolean;
}

export interface Config {
  /** Absolute path of the directory holding sbv.config.json. */
  configDir: string;
  /** Absolute path to the config file (may not exist yet). */
  configPath: string;
  projectName: string;
  source: SourceConfig;
  vault: VaultConfig;
  mirror: MirrorConfig;
  server: ServerConfig;
  watch: WatchConfig;
}

export type ConfigInput = Partial<{
  projectName: string;
  source: Partial<SourceConfig>;
  vault: Partial<VaultConfig>;
  mirror: Partial<MirrorConfig>;
  server: Partial<ServerConfig>;
  watch: Partial<WatchConfig>;
}>;

export const DEFAULT_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".idea",
  ".vscode",
  ".DS_Store",
  ".sbv",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "*.min.js",
  "*.map",
];

export const DEFAULT_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".scala", ".ex", ".exs",
  ".sh", ".bash", ".zsh", ".sql", ".graphql", ".proto",
  ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte", ".astro",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".mdx", ".txt",
];

function defaults(configDir: string, projectName: string): Config {
  return {
    configDir,
    configPath: path.join(configDir, CONFIG_FILENAME),
    projectName,
    source: {
      root: ".",
      exclude: [],
      extensions: [...DEFAULT_EXTENSIONS],
      maxFileSizeKb: 512,
      respectGitignore: true,
      includeDotfiles: false,
    },
    vault: {
      path: "./vault",
      manageObsidianConfig: true,
      sessionsFolder: "Sessions",
      conceptsFolder: "Concepts",
      decisionsFolder: "Decisions",
      journalFolder: "Journal",
      metaFolder: "_Meta",
    },
    mirror: {
      folder: "Codebase",
      emitModules: true,
      emitPackages: true,
      emitSymbols: true,
      excerptLines: 0,
      pruneOrphans: true,
    },
    server: { port: 4141, host: "127.0.0.1", open: false },
    watch: { debounceMs: 400, journal: true },
  };
}

function mergeSection<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Expand `~` and resolve against the config directory. */
export function resolvePath(configDir: string, candidate: string): string {
  let value = candidate;
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(configDir, value);
}

/** Walk up from `startDir` looking for sbv.config.json. */
export async function findConfigFile(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface LoadOptions {
  cwd?: string;
  /** Explicit config path; skips the upward search. */
  configPath?: string;
  /** CLI/env overrides applied last. */
  overrides?: ConfigInput;
}

export function applyEnvOverrides(input: ConfigInput): ConfigInput {
  const out: ConfigInput = { ...input };
  const vaultPath = process.env.SBV_VAULT_PATH;
  const port = process.env.SBV_PORT;
  const projectName = process.env.SBV_PROJECT_NAME;
  if (vaultPath) out.vault = { ...out.vault, path: vaultPath };
  if (port && Number.isFinite(Number(port))) out.server = { ...out.server, port: Number(port) };
  if (projectName) out.projectName = projectName;
  return out;
}

export async function loadConfig(options: LoadOptions = {}): Promise<Config> {
  const cwd = path.resolve(options.cwd ?? process.env.SBV_PROJECT_DIR ?? process.cwd());
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : await findConfigFile(cwd);
  const configDir = configPath ? path.dirname(configPath) : cwd;

  let fileInput: ConfigInput = {};
  if (configPath) {
    const raw = await readFileOrNull(configPath);
    if (raw) {
      try {
        fileInput = JSON.parse(raw) as ConfigInput;
      } catch (error) {
        throw new Error(
          `${toPosix(configPath)} is not valid JSON: ${(error as Error).message}`,
        );
      }
    }
  }

  const base = defaults(configDir, path.basename(configDir));
  const merged = mergeInputs(base, fileInput);
  return mergeInputs(merged, applyEnvOverrides(options.overrides ?? {}));
}

function mergeInputs(base: Config, input: ConfigInput): Config {
  return {
    ...base,
    projectName: input.projectName ?? base.projectName,
    source: mergeSection(base.source, input.source),
    vault: mergeSection(base.vault, input.vault),
    mirror: mergeSection(base.mirror, input.mirror),
    server: mergeSection(base.server, input.server),
    watch: mergeSection(base.watch, input.watch),
  };
}

/** Absolute, fully-resolved locations derived from a Config. */
export interface ResolvedPaths {
  projectRoot: string;
  vaultRoot: string;
  mirrorRoot: string;
  filesRoot: string;
  modulesRoot: string;
  packagesRoot: string;
  sessionsRoot: string;
  conceptsRoot: string;
  decisionsRoot: string;
  journalRoot: string;
  metaRoot: string;
  stateDir: string;
}

export function resolvePaths(config: Config): ResolvedPaths {
  const projectRoot = resolvePath(config.configDir, config.source.root);
  const vaultRoot = resolvePath(config.configDir, config.vault.path);
  const mirrorRoot = path.join(vaultRoot, config.mirror.folder);
  return {
    projectRoot,
    vaultRoot,
    mirrorRoot,
    filesRoot: path.join(mirrorRoot, "Files"),
    modulesRoot: path.join(mirrorRoot, "Modules"),
    packagesRoot: path.join(mirrorRoot, "Packages"),
    sessionsRoot: path.join(vaultRoot, config.vault.sessionsFolder),
    conceptsRoot: path.join(vaultRoot, config.vault.conceptsFolder),
    decisionsRoot: path.join(vaultRoot, config.vault.decisionsFolder),
    journalRoot: path.join(vaultRoot, config.vault.journalFolder),
    metaRoot: path.join(vaultRoot, config.vault.metaFolder),
    stateDir: path.join(config.configDir, ".sbv"),
  };
}

/** Serialise the user-editable subset of a config back to JSON. */
export function serializeConfig(config: Config): string {
  const { configDir: _dir, configPath: _path, ...rest } = config;
  return `${JSON.stringify(rest, null, 2)}\n`;
}
