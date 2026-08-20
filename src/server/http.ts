import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import type { Config } from "../config.js";
import { Vault } from "../vault/vault.js";
import { buildKnowledgeGraph, type KnowledgeGraph } from "../graph/build.js";
import { localGraph } from "../graph/metrics.js";
import { runSync } from "../mirror/sync.js";
import { startWatcher, type WatcherHandle } from "../watch/watcher.js";
import { obsidianUri } from "../mcp/tools.js";
import { stripManagedBody } from "../util/markdown.js";
import { log } from "../util/log.js";

/**
 * Local HTTP server for the graph visualiser.
 *
 * Bound to the loopback interface by default: the vault can contain anything a
 * person has written about their own code, and this server exposes note bodies
 * without authentication, so it must not be reachable from the network unless
 * the operator explicitly asks for it.
 *
 * Live updates use Server-Sent Events rather than a websocket — the traffic is
 * one-directional and SSE reconnects on its own.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  close: () => Promise<void>;
  url: string;
  port: number;
}

interface Client {
  id: number;
  res: http.ServerResponse;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readUiAsset(name: string): Promise<string> {
  // Works both from dist (after build) and from src during development.
  const candidates = [
    path.join(here, "ui", name),
    path.join(here, "..", "..", "src", "server", "ui", name),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(`UI asset not found: ${name}`);
}

export interface StartServerOptions {
  /** Also watch the project and push updates to connected browsers. */
  watch?: boolean;
  /** Run a full sync before serving. */
  syncFirst?: boolean;
}

export async function startServer(
  config: Config,
  options: StartServerOptions = {},
): Promise<ServerHandle> {
  const vault = new Vault(config);
  await vault.ensure();

  if (options.syncFirst) {
    await runSync(config, { vault });
  }

  let graph: KnowledgeGraph | null = null;
  let graphPromise: Promise<KnowledgeGraph> | null = null;

  const refreshGraph = async (): Promise<KnowledgeGraph> => {
    // Collapse concurrent rebuild requests onto one in-flight build.
    if (graphPromise) return graphPromise;
    graphPromise = buildKnowledgeGraph(vault)
      .then((result) => {
        graph = result;
        return result;
      })
      .finally(() => {
        graphPromise = null;
      });
    return graphPromise;
  };

  const getGraph = async (): Promise<KnowledgeGraph> => graph ?? (await refreshGraph());

  const clients = new Map<number, Client>();
  let nextClientId = 1;

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients.values()) {
      client.res.write(payload);
    }
  };

  let watcher: WatcherHandle | null = null;
  if (options.watch) {
    watcher = await startWatcher(config, {
      onSync: async (report) => {
        await refreshGraph();
        broadcast("sync", {
          at: new Date().toISOString(),
          created: report.counts.created,
          updated: report.counts.updated,
          deleted: report.counts.deleted,
          files: report.stats.fileCount,
        });
      },
      onError: (error) => broadcast("error", { message: error.message }),
    });
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      log.error(`request failed: ${(error as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
      else res.end();
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname;

    if (route === "/" || route === "/index.html") {
      const html = await readUiAsset("index.html");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    if (route === "/api/graph") {
      const current = await getGraph();
      const rootId = url.searchParams.get("root");
      const depth = Number(url.searchParams.get("depth") ?? "2");
      if (rootId) {
        const local = localGraph(current.nodes, current.edges, rootId, Number.isFinite(depth) ? depth : 2);
        sendJson(res, 200, { ...current, nodes: local.nodes, edges: local.edges, rootId });
        return;
      }
      sendJson(res, 200, current);
      return;
    }

    if (route === "/api/note") {
      const id = url.searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { error: "missing id" });
        return;
      }
      let record;
      try {
        record = await vault.read(id);
      } catch (error) {
        // absPathFor throws for anything trying to escape the vault.
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
      if (!record) {
        sendJson(res, 404, { error: "note not found" });
        return;
      }
      sendJson(res, 200, {
        noteId: record.id,
        title: record.name,
        frontmatter: record.frontmatter,
        content: record.body,
        userContent: stripManagedBody(record.body),
        obsidianUri: obsidianUri(vault.root, record.id),
      });
      return;
    }

    if (route === "/api/stats") {
      const current = await getGraph();
      sendJson(res, 200, {
        projectName: current.projectName,
        vaultPath: current.vaultPath,
        generatedAt: current.generatedAt,
        metrics: {
          ...current.metrics,
          // These two maps are large and the UI reads them from the nodes.
          components: undefined,
          pagerank: undefined,
        },
        watching: Boolean(watcher),
      });
      return;
    }

    if (route === "/api/sync" && req.method === "POST") {
      const report = watcher ? await watcher.syncNow() : await runSync(config, { vault });
      await refreshGraph();
      broadcast("sync", {
        at: new Date().toISOString(),
        created: report.counts.created,
        updated: report.counts.updated,
        deleted: report.counts.deleted,
        files: report.stats.fileCount,
      });
      sendJson(res, 200, { ok: true, counts: report.counts, durationMs: report.durationMs });
      return;
    }

    if (route === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const id = nextClientId++;
      clients.set(id, { id, res });

      // Proxies and laptops sleeping mid-stream both benefit from a heartbeat.
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(id);
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : config.server.port);
    });
  });

  await refreshGraph();
  const url = `http://${config.server.host}:${port}`;

  return {
    url,
    port,
    close: async () => {
      for (const client of clients.values()) client.res.end();
      clients.clear();
      await watcher?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
