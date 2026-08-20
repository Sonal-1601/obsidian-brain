import { promises as fs } from "node:fs";
import type { Vault } from "../vault/vault.js";
import { MANAGED_KEY } from "../vault/vault.js";
import { extractLinks, extractTags, parseNote, stripManagedBody } from "../util/markdown.js";
import { computeMetrics, type GraphMetrics } from "./metrics.js";

/**
 * Builds the knowledge graph from the vault itself, not from the code model.
 *
 * Reading the vault is what makes the graph a *second brain* rather than a
 * dependency diagram: hand-written concept notes, decisions, and session logs
 * participate as first-class nodes, and a link a human types by hand is worth
 * exactly as much as one the mirror generated.
 */

export type NodeKind =
  | "file"
  | "module"
  | "package"
  | "concept"
  | "session"
  | "decision"
  | "journal"
  | "dashboard"
  | "note"
  | "orphaned"
  | "phantom";

export interface GraphNode {
  /** Vault-relative path without extension. */
  id: string;
  /** Basename, used for short wikilink resolution and as the display label. */
  name: string;
  label: string;
  kind: NodeKind;
  tags: string[];
  /** Top-level vault folder, useful for colouring. */
  folder: string;
  /** Bytes of user-authored (non-generated) content. */
  userBytes: number;
  size: number;
  mtimeMs: number;
  /** Present for mirrored notes: the source file they represent. */
  sourcePath?: string;
  language?: string;
  lines?: number;
  outDegree: number;
  inDegree: number;
  /** True when the note does not exist on disk but is linked to. */
  phantom: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** False when the target note does not exist. */
  resolved: boolean;
  /** True for embeds (`![[note]]`). */
  embed: boolean;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metrics: GraphMetrics;
  generatedAt: string;
  vaultPath: string;
  projectName: string;
}

function kindFor(id: string, frontmatter: Record<string, unknown>): NodeKind {
  const marker = frontmatter[MANAGED_KEY];
  if (typeof marker === "string") {
    const known: NodeKind[] = [
      "file", "module", "package", "concept", "session",
      "decision", "journal", "dashboard", "orphaned",
    ];
    if ((known as string[]).includes(marker)) return marker as NodeKind;
  }
  const top = id.split("/")[0]?.toLowerCase() ?? "";
  if (top === "concepts") return "concept";
  if (top === "sessions") return "session";
  if (top === "decisions") return "decision";
  if (top === "journal") return "journal";
  return "note";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Resolve a link target the way Obsidian does: an exact vault path first, then
 * a unique basename match, case-insensitively as a last resort.
 */
function makeResolver(nodesById: Map<string, GraphNode>, byName: Map<string, string[]>) {
  const lowerById = new Map<string, string>();
  for (const id of nodesById.keys()) lowerById.set(id.toLowerCase(), id);

  return (rawTarget: string): string | null => {
    const cleaned = rawTarget.replace(/^\.\//, "").trim();
    if (!cleaned) return null;

    // Try the target as written before stripping `.md`: a mirrored markdown
    // file legitimately has an id ending in `.md` (README.md -> README.md.md),
    // and stripping first would make every link to one unresolvable.
    if (nodesById.has(cleaned)) return cleaned;

    const target = cleaned.replace(/\.md$/i, "");
    if (!target) return null;
    if (nodesById.has(target)) return target;

    const rawLower = lowerById.get(cleaned.toLowerCase());
    if (rawLower) return rawLower;

    const byPathLower = lowerById.get(target.toLowerCase());
    if (byPathLower) return byPathLower;

    const rawByName = byName.get(cleaned) ?? byName.get(cleaned.toLowerCase());
    if (rawByName && rawByName.length > 0) {
      return [...rawByName].sort((a, b) => a.length - b.length)[0] ?? null;
    }

    const candidates = byName.get(target) ?? byName.get(target.toLowerCase());
    if (candidates && candidates.length > 0) {
      // Obsidian prefers the shortest path when a basename is ambiguous.
      return [...candidates].sort((a, b) => a.length - b.length)[0] ?? null;
    }
    return null;
  };
}

export interface BuildGraphOptions {
  /** Include unresolved links as phantom nodes, as Obsidian's graph does. */
  includePhantoms?: boolean;
  /** Skip notes in these top-level folders. */
  excludeFolders?: string[];
}

export async function buildKnowledgeGraph(
  vault: Vault,
  options: BuildGraphOptions = {},
): Promise<KnowledgeGraph> {
  const includePhantoms = options.includePhantoms ?? true;
  const exclude = new Set((options.excludeFolders ?? []).map((f) => f.toLowerCase()));

  const refs = await vault.listNotes();
  const nodesById = new Map<string, GraphNode>();
  const byName = new Map<string, string[]>();
  const rawLinks: Array<{ from: string; target: string; embed: boolean }> = [];

  for (const ref of refs) {
    const folder = ref.id.includes("/") ? ref.id.slice(0, ref.id.indexOf("/")) : "";
    if (exclude.has(folder.toLowerCase())) continue;

    let raw: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      raw = await fs.readFile(ref.absPath, "utf8");
      stat = await fs.stat(ref.absPath);
    } catch {
      continue;
    }

    const parsed = parseNote(raw);
    const tags = extractTags(parsed.body, parsed.frontmatter);
    const node: GraphNode = {
      id: ref.id,
      name: ref.name,
      label: asString(parsed.frontmatter.title) ?? ref.name,
      kind: kindFor(ref.id, parsed.frontmatter),
      tags,
      folder,
      userBytes: Buffer.byteLength(stripManagedBody(parsed.body), "utf8"),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sourcePath: asString(parsed.frontmatter.source_path),
      language: asString(parsed.frontmatter.language),
      lines: asNumber(parsed.frontmatter.lines),
      outDegree: 0,
      inDegree: 0,
      phantom: false,
    };
    nodesById.set(node.id, node);
    const bucket = byName.get(node.name) ?? [];
    bucket.push(node.id);
    byName.set(node.name, bucket);

    for (const link of extractLinks(parsed.body)) {
      rawLinks.push({ from: node.id, target: link.target, embed: link.embed });
    }
  }

  // Index basenames case-insensitively too, for forgiving resolution.
  for (const [name, ids] of [...byName.entries()]) {
    const lower = name.toLowerCase();
    if (lower !== name && !byName.has(lower)) byName.set(lower, ids);
  }

  const resolve = makeResolver(nodesById, byName);
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  for (const link of rawLinks) {
    const resolved = resolve(link.target);
    let targetId = resolved;

    if (!resolved) {
      if (!includePhantoms) continue;
      const phantomId = `?${link.target}`;
      if (!nodesById.has(phantomId)) {
        nodesById.set(phantomId, {
          id: phantomId,
          name: link.target,
          label: link.target,
          kind: "phantom",
          tags: [],
          folder: "",
          userBytes: 0,
          size: 0,
          mtimeMs: 0,
          outDegree: 0,
          inDegree: 0,
          phantom: true,
        });
      }
      targetId = phantomId;
    }

    if (!targetId || targetId === link.from) continue;
    const key = `${link.from}->${targetId}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source: link.from, target: targetId, resolved: Boolean(resolved), embed: link.embed });
  }

  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (source) source.outDegree += 1;
    if (target) target.inDegree += 1;
  }

  const nodes = [...nodesById.values()];
  const metrics = computeMetrics(nodes, edges);

  return {
    nodes,
    edges,
    metrics,
    generatedAt: new Date().toISOString(),
    vaultPath: vault.root,
    projectName: vault.config.projectName,
  };
}
