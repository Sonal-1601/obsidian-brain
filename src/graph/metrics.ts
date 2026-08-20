import type { GraphEdge, GraphNode } from "./build.js";

/**
 * Structural metrics over the knowledge graph.
 *
 * These exist to answer questions a file tree cannot: which notes are load
 * bearing, which parts of the vault are disconnected islands, and what is
 * floating unlinked. PageRank is computed on the undirected view because a
 * backlink is just as meaningful as a forward link when judging importance in
 * a note graph.
 */

export interface NodeRank {
  id: string;
  score: number;
}

export interface GraphMetrics {
  nodeCount: number;
  edgeCount: number;
  unresolvedEdges: number;
  orphanCount: number;
  /** Number of weakly-connected components. */
  componentCount: number;
  /** Size of the largest component. */
  largestComponent: number;
  /** Component index per node id. */
  components: Record<string, number>;
  /** PageRank per node id, normalised so the maximum is 1. */
  pagerank: Record<string, number>;
  /** Highest-ranked notes, most important first. */
  hubs: NodeRank[];
  /** Notes with no links in either direction. */
  orphans: string[];
  /** Average degree across non-phantom nodes. */
  averageDegree: number;
}

interface Adjacency {
  out: Map<string, string[]>;
  in: Map<string, string[]>;
  undirected: Map<string, Set<string>>;
}

function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const out = new Map<string, string[]>();
  const inbound = new Map<string, string[]>();
  const undirected = new Map<string, Set<string>>();
  for (const node of nodes) {
    out.set(node.id, []);
    inbound.set(node.id, []);
    undirected.set(node.id, new Set());
  }
  for (const edge of edges) {
    out.get(edge.source)?.push(edge.target);
    inbound.get(edge.target)?.push(edge.source);
    undirected.get(edge.source)?.add(edge.target);
    undirected.get(edge.target)?.add(edge.source);
  }
  return { out, in: inbound, undirected };
}

/** Weakly-connected components via iterative breadth-first search. */
function findComponents(nodes: GraphNode[], adj: Adjacency): {
  components: Record<string, number>;
  count: number;
  largest: number;
} {
  const components: Record<string, number> = {};
  let count = 0;
  let largest = 0;

  for (const node of nodes) {
    if (components[node.id] !== undefined) continue;
    const index = count;
    count += 1;
    let size = 0;
    const queue = [node.id];
    components[node.id] = index;
    while (queue.length) {
      const current = queue.pop()!;
      size += 1;
      for (const neighbour of adj.undirected.get(current) ?? []) {
        if (components[neighbour] === undefined) {
          components[neighbour] = index;
          queue.push(neighbour);
        }
      }
    }
    if (size > largest) largest = size;
  }
  return { components, count, largest };
}

/**
 * PageRank over the undirected view.
 *
 * Twenty iterations of power iteration is well past the point of visible
 * change for graphs of this size, and keeps a full recompute cheap enough to
 * run on every sync.
 */
function pagerank(nodes: GraphNode[], adj: Adjacency, damping = 0.85, iterations = 20): Record<string, number> {
  const n = nodes.length;
  if (n === 0) return {};
  const scores = new Map<string, number>();
  for (const node of nodes) scores.set(node.id, 1 / n);

  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of nodes) {
      const neighbours = adj.undirected.get(node.id);
      if (!neighbours || neighbours.size === 0) dangling += scores.get(node.id) ?? 0;
      next.set(node.id, 0);
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    for (const node of nodes) next.set(node.id, base);

    for (const node of nodes) {
      const neighbours = adj.undirected.get(node.id);
      if (!neighbours || neighbours.size === 0) continue;
      const share = (damping * (scores.get(node.id) ?? 0)) / neighbours.size;
      for (const neighbour of neighbours) {
        next.set(neighbour, (next.get(neighbour) ?? 0) + share);
      }
    }
    for (const [id, value] of next) scores.set(id, value);
  }

  let max = 0;
  for (const value of scores.values()) if (value > max) max = value;
  const normalised: Record<string, number> = {};
  for (const [id, value] of scores) normalised[id] = max > 0 ? value / max : 0;
  return normalised;
}

export function computeMetrics(nodes: GraphNode[], edges: GraphEdge[]): GraphMetrics {
  const adj = buildAdjacency(nodes, edges);
  const { components, count, largest } = findComponents(nodes, adj);
  const ranks = pagerank(nodes, adj);

  const orphans = nodes
    .filter((n) => !n.phantom && n.inDegree === 0 && n.outDegree === 0)
    .map((n) => n.id);

  const real = nodes.filter((n) => !n.phantom);
  const totalDegree = real.reduce((sum, n) => sum + n.inDegree + n.outDegree, 0);

  const hubs = nodes
    .filter((n) => !n.phantom)
    .map((n) => ({ id: n.id, score: ranks[n.id] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    unresolvedEdges: edges.filter((e) => !e.resolved).length,
    orphanCount: orphans.length,
    componentCount: count,
    largestComponent: largest,
    components,
    pagerank: ranks,
    hubs,
    orphans,
    averageDegree: real.length ? totalDegree / real.length : 0,
  };
}

/**
 * The neighbourhood around a note, breadth-first to a given depth — the data
 * behind "local graph" views and the `sbv_related_notes` MCP tool.
 */
export function localGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rootId: string,
  depth: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(rootId)) return { nodes: [], edges: [] };

  const neighbours = new Map<string, Set<string>>();
  for (const node of nodes) neighbours.set(node.id, new Set());
  for (const edge of edges) {
    neighbours.get(edge.source)?.add(edge.target);
    neighbours.get(edge.target)?.add(edge.source);
  }

  const included = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of neighbours.get(id) ?? []) {
        if (included.has(neighbour)) continue;
        included.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return {
    nodes: nodes.filter((n) => included.has(n.id)),
    edges: edges.filter((e) => included.has(e.source) && included.has(e.target)),
  };
}
