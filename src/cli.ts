#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import {
  CONFIG_FILENAME,
  loadConfig,
  resolvePaths,
  serializeConfig,
  type Config,
  type ConfigInput,
} from "./config.js";
import { Vault } from "./vault/vault.js";
import { runSync, formatSyncReport } from "./mirror/sync.js";
import { startWatcher } from "./watch/watcher.js";
import { startServer } from "./server/http.js";
import { runMcpServer } from "./mcp/server.js";
import { buildKnowledgeGraph } from "./graph/build.js";
import { obsidianUri } from "./mcp/tools.js";
import { pathExists, writeFileAtomic, toPosix } from "./util/fsx.js";
import { color, log, setLogLevel } from "./util/log.js";

/**
 * Command-line entry point.
 *
 * Commands are deliberately small wrappers over the library functions so the
 * same code paths run whether they are driven by a person, by the watcher, or
 * by an MCP client.
 */

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { command, positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

async function configFor(args: ParsedArgs): Promise<Config> {
  const overrides: ConfigInput = {};
  const vaultPath = flagString(args, "vault");
  const port = flagString(args, "port");
  const projectName = flagString(args, "name");
  if (vaultPath) overrides.vault = { path: vaultPath };
  if (port) overrides.server = { port: Number(port) };
  if (projectName) overrides.projectName = projectName;

  const cwd = flagString(args, "cwd") ?? process.cwd();
  return loadConfig({ cwd, configPath: flagString(args, "config"), overrides });
}

const HELP = `
${color("second-brain-visualizer", "bold")} — mirror a codebase into an Obsidian vault

${color("Usage:", "bold")} sbv <command> [options]

${color("Commands:", "bold")}
  init            Create sbv.config.json, build the vault, and run a first sync
  sync            Mirror the project into the vault once
  watch           Sync continuously as files change
  serve           Run the graph visualiser (add --watch for live updates)
  open            Open the vault in the Obsidian desktop app
  mcp             Run the MCP server over stdio (for Claude Code / Claude Desktop)
  install-mcp     Print or write the MCP client configuration
  graph           Print knowledge-graph statistics
  doctor          Check the setup and report problems
  help            Show this message

${color("Common options:", "bold")}
  --vault <path>   Vault location (default: ./vault)
  --cwd <path>     Project directory to operate on
  --config <path>  Explicit config file
  --port <n>       Visualiser port (default: 4141)
  --verbose        Debug logging

${color("Typical setup:", "bold")}
  npx sbv init
  npx sbv serve --watch
`;

async function commandInit(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const paths = resolvePaths(config);
  const configPath = path.join(config.configDir, CONFIG_FILENAME);

  if (!(await pathExists(configPath)) || flagBool(args, "force")) {
    await writeFileAtomic(configPath, serializeConfig(config));
    log.print(`${color("created", "info")} ${toPosix(path.relative(process.cwd(), configPath) || CONFIG_FILENAME)}`);
  } else {
    log.print(`${color("kept", "debug")} existing ${CONFIG_FILENAME}`);
  }

  const vault = new Vault(config);
  await vault.ensure({ force: flagBool(args, "force") });
  log.print(`${color("vault", "info")} ${paths.vaultRoot}`);

  const report = await runSync(config, { vault });
  log.print(`${color("synced", "info")} ${formatSyncReport(report, paths.vaultRoot)}`);
  log.print("");
  log.print(`${color("Next steps:", "bold")}`);
  log.print(`  1. Open the vault:      ${color("npx sbv open", "debug")}`);
  log.print(`     (or in Obsidian: "Open folder as vault" -> ${paths.vaultRoot})`);
  log.print(`  2. Watch for changes:   ${color("npx sbv watch", "debug")}`);
  log.print(`  3. Or the live graph:   ${color("npx sbv serve --watch", "debug")}`);
  log.print(`  4. Wire up Claude:      ${color("npx sbv install-mcp --write", "debug")}`);
  return 0;
}

async function commandSync(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const report = await runSync(config);
  const paths = resolvePaths(config);
  log.print(formatSyncReport(report, paths.vaultRoot));
  if (flagBool(args, "stats")) {
    log.print(JSON.stringify(report.stats, null, 2));
  }
  return 0;
}

async function commandWatch(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const paths = resolvePaths(config);
  log.print(`${color("watching", "info")} ${paths.projectRoot}`);
  log.print(`${color("vault", "info")} ${paths.vaultRoot}`);

  const initial = await runSync(config);
  log.print(formatSyncReport(initial, paths.vaultRoot));

  const handle = await startWatcher(config, {
    onSync: (report) => {
      if (report.counts.created || report.counts.updated || report.counts.deleted) {
        log.print(`${new Date().toLocaleTimeString()} ${formatSyncReport(report, paths.vaultRoot)}`);
      }
    },
  });

  log.print(color("Press Ctrl+C to stop.", "dim"));
  await waitForShutdown(async () => {
    await handle.close();
  });
  return 0;
}

async function commandServe(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const watch = flagBool(args, "watch") || flagBool(args, "live");
  const handle = await startServer(config, { watch, syncFirst: true });

  log.print(`${color("visualiser", "info")} ${handle.url}`);
  log.print(`${color("vault", "info")} ${resolvePaths(config).vaultRoot}`);
  if (watch) log.print(color("live updates enabled", "dim"));

  if (config.server.open || flagBool(args, "open")) {
    openExternal(handle.url);
  }

  await waitForShutdown(async () => {
    await handle.close();
  });
  return 0;
}

async function commandOpen(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const paths = resolvePaths(config);
  if (!(await pathExists(paths.vaultRoot))) {
    log.error(`No vault at ${paths.vaultRoot}. Run "sbv init" first.`);
    return 1;
  }
  const uri = obsidianUri(paths.vaultRoot, flagString(args, "note"));
  log.print(uri);
  openExternal(uri);
  return 0;
}

async function commandGraph(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const vault = new Vault(config);
  const graph = await buildKnowledgeGraph(vault);
  const m = graph.metrics;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  log.print(`${color("vault", "bold")} ${graph.vaultPath}`);
  log.print(`${m.nodeCount} notes · ${m.edgeCount} links · ${m.unresolvedEdges} unresolved`);
  log.print(`${m.componentCount} cluster(s), largest ${m.largestComponent} · ${m.orphanCount} orphan(s)`);
  log.print(`average degree ${m.averageDegree.toFixed(2)}`);
  log.print("");
  log.print(color("Most important notes (PageRank):", "bold"));
  for (const hub of m.hubs.slice(0, 12)) {
    const node = byId.get(hub.id);
    const links = `${node?.inDegree ?? 0} in / ${node?.outDegree ?? 0} out`;
    log.print(`  ${hub.score.toFixed(3).padStart(5)}  ${links.padEnd(14)} ${hub.id}`);
  }
  if (m.orphans.length) {
    log.print("");
    log.print(color("Unlinked notes:", "bold"));
    for (const id of m.orphans.slice(0, 10)) log.print(`  ${id}`);
  }
  return 0;
}

async function commandDoctor(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const paths = resolvePaths(config);
  let problems = 0;

  const check = async (label: string, test: () => Promise<boolean | string>) => {
    const result = await test();
    if (result === true) {
      log.print(`  ${color("ok", "info")}    ${label}`);
    } else {
      problems += 1;
      log.print(`  ${color("warn", "warn")}  ${label}${typeof result === "string" ? ` — ${result}` : ""}`);
    }
  };

  log.print(color("Configuration", "bold"));
  await check(`project root ${paths.projectRoot}`, async () =>
    (await pathExists(paths.projectRoot)) || "does not exist",
  );
  await check(`config file ${CONFIG_FILENAME}`, async () =>
    (await pathExists(path.join(config.configDir, CONFIG_FILENAME))) || 'not found — run "sbv init"',
  );

  log.print(color("Vault", "bold"));
  await check(`vault folder ${paths.vaultRoot}`, async () =>
    (await pathExists(paths.vaultRoot)) || 'not created — run "sbv init"',
  );
  await check(".obsidian config present", async () =>
    (await pathExists(path.join(paths.vaultRoot, ".obsidian", "graph.json"))) ||
    "missing; Obsidian will use its own defaults",
  );

  log.print(color("Obsidian", "bold"));
  const appPaths = [
    "/Applications/Obsidian.app",
    path.join(os.homedir(), "Applications", "Obsidian.app"),
  ];
  let found: string | null = null;
  for (const candidate of appPaths) {
    if (await pathExists(candidate)) {
      found = candidate;
      break;
    }
  }
  await check(
    found ? `desktop app installed (${found})` : "desktop app installed",
    async () => (found ? true : "not found in /Applications or ~/Applications"),
  );

  const registry = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "obsidian",
    "obsidian.json",
  );
  if (await pathExists(registry)) {
    try {
      const raw = JSON.parse(await fs.readFile(registry, "utf8")) as {
        vaults?: Record<string, { path?: string }>;
      };
      const known = Object.values(raw.vaults ?? {}).map((v) => v.path);
      const registered = known.some(
        (p) => p && path.resolve(p) === path.resolve(paths.vaultRoot),
      );
      await check("vault registered with Obsidian", async () =>
        registered || 'not yet — run "sbv open" to register it',
      );
    } catch {
      await check("obsidian.json readable", async () => "could not parse");
    }
  } else {
    log.print(`  ${color("info", "debug")}  Obsidian has not been launched yet`);
  }

  log.print(color("Mirror", "bold"));
  const vault = new Vault(config);
  const notes = await vault.listNotes().catch(() => []);
  await check(`${notes.length} note(s) in the vault`, async () =>
    notes.length > 0 || 'empty — run "sbv sync"',
  );

  log.print("");
  log.print(problems === 0 ? color("Everything looks good.", "info") : `${problems} thing(s) need attention.`);
  return problems === 0 ? 0 : 1;
}

async function commandInstallMcp(args: ParsedArgs): Promise<number> {
  const config = await configFor(args);
  const paths = resolvePaths(config);
  const entry = path.join(path.dirname(new URL(import.meta.url).pathname), "cli.js");

  const server = {
    command: process.execPath,
    args: [entry, "mcp"],
    env: {
      SBV_PROJECT_DIR: config.configDir,
      SBV_VAULT_PATH: paths.vaultRoot,
    },
  };

  const claudeCodeSnippet = { mcpServers: { "second-brain": server } };

  if (flagBool(args, "write")) {
    // Claude Code reads .mcp.json from the project root for project-scoped servers.
    const target = path.join(config.configDir, ".mcp.json");
    let existing: { mcpServers?: Record<string, unknown> } = {};
    if (await pathExists(target)) {
      try {
        existing = JSON.parse(await fs.readFile(target, "utf8")) as typeof existing;
      } catch {
        log.warn(`${target} exists but is not valid JSON; it will be replaced.`);
      }
    }
    const merged = {
      ...existing,
      mcpServers: { ...(existing.mcpServers ?? {}), "second-brain": server },
    };
    await writeFileAtomic(target, `${JSON.stringify(merged, null, 2)}\n`);
    log.print(`${color("wrote", "info")} ${target}`);
    log.print("Restart Claude Code in this directory to pick up the server.");
    return 0;
  }

  log.print(color("Add this to .mcp.json in the project root (or your Claude config):", "bold"));
  log.print("");
  log.print(JSON.stringify(claudeCodeSnippet, null, 2));
  log.print("");
  log.print(`Or run: ${color("sbv install-mcp --write", "debug")}`);
  return 0;
}

function openExternal(target: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(opener, [target], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
  child.on("error", () => log.warn(`Could not open ${target} automatically.`));
  child.unref();
}

/** Block until SIGINT/SIGTERM, then run the cleanup once. */
async function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const shutdown = () => {
      if (done) return;
      done = true;
      void cleanup().finally(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (flagBool(args, "verbose")) setLogLevel("debug");

  switch (args.command) {
    case "init":
      return commandInit(args);
    case "sync":
      return commandSync(args);
    case "watch":
      return commandWatch(args);
    case "serve":
    case "server":
      return commandServe(args);
    case "open":
      return commandOpen(args);
    case "graph":
      return commandGraph(args);
    case "doctor":
      return commandDoctor(args);
    case "install-mcp":
      return commandInstallMcp(args);
    case "mcp": {
      const config = await configFor(args);
      await runMcpServer(config);
      // The stdio transport keeps the process alive until the client closes it.
      await new Promise<void>(() => {});
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      log.print(HELP);
      return 0;
    default:
      log.error(`Unknown command: ${args.command}`);
      log.print(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log.error((error as Error).stack ?? String(error));
    process.exitCode = 1;
  });
