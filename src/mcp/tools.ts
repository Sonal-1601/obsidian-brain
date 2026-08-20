import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../config.js";
import { Vault } from "../vault/vault.js";
import { runSync } from "../mirror/sync.js";
import { buildKnowledgeGraph, type KnowledgeGraph } from "../graph/build.js";
import { localGraph } from "../graph/metrics.js";
import { parseNote, stripManagedBody, wikilink } from "../util/markdown.js";
import { sanitizeName, slugify } from "../util/slug.js";
import { fileNoteName } from "../mirror/model.js";
import { today } from "../watch/journal.js";
import { toPosix } from "../util/fsx.js";

/**
 * The operations behind the MCP tools.
 *
 * Kept separate from the protocol wiring so each one can be tested directly and
 * reused by the CLI. Every function returns plain data; formatting for the
 * model happens at the protocol boundary.
 */

export interface ToolContext {
  config: Config;
  vault: Vault;
  /** Cached graph, rebuilt when the vault changes underneath us. */
  graph?: KnowledgeGraph;
}

export async function getGraph(ctx: ToolContext, refresh = false): Promise<KnowledgeGraph> {
  if (!ctx.graph || refresh) {
    ctx.graph = await buildKnowledgeGraph(ctx.vault);
  }
  return ctx.graph;
}

function invalidate(ctx: ToolContext): void {
  ctx.graph = undefined;
}

/** Build the `[[links]]` block shared by concept, decision, and session notes. */
function renderLinkList(links: string[]): string {
  if (!links.length) return "";
  return links.map((link) => `- ${wikilink(link)}`).join("\n");
}

/**
 * Turn a caller-supplied link into a vault target.
 *
 * Callers refer to things the way they naturally think of them — a source path
 * like `src/cli.ts`, a note id, or a bare note name — so all three are accepted
 * and normalised to something Obsidian can resolve.
 */
export function normalizeLinkTarget(ctx: ToolContext, raw: string): string {
  const value = raw.trim().replace(/^\[\[|\]\]$/g, "");
  if (!value) return value;
  // A path that looks like a source file maps to its mirrored note.
  if (/\.[a-z0-9]{1,6}$/i.test(value) && value.includes("/") && !value.startsWith(ctx.config.mirror.folder)) {
    return `${ctx.config.mirror.folder}/Files/${fileNoteName(value)}`;
  }
  return value;
}

export interface CaptureNoteInput {
  title: string;
  content: string;
  folder?: string;
  tags?: string[];
  links?: string[];
  /** Replace the whole note instead of appending to it. */
  overwrite?: boolean;
}

export async function captureNote(ctx: ToolContext, input: CaptureNoteInput) {
  const folder = input.folder?.trim() || ctx.config.vault.conceptsFolder;
  const name = sanitizeName(input.title);
  const links = (input.links ?? []).map((l) => normalizeLinkTarget(ctx, l));
  const ref = ctx.vault.refFor(folder, name);
  const existing = await ctx.vault.read(ref.id);

  const sections: string[] = [];
  if (!existing || input.overwrite) sections.push(`# ${input.title}`, "");
  sections.push(input.content.trim());
  if (links.length) {
    sections.push("", "## Related", "", renderLinkList(links));
  }
  const body = sections.join("\n");

  if (existing && !input.overwrite) {
    await ctx.vault.appendToNote(folder, name, body);
  } else {
    const frontmatter: Record<string, unknown> = {
      sbv: "concept",
      created: existing?.frontmatter.created ?? new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    const tags = ["sbv/concept", ...(input.tags ?? [])];
    frontmatter.tags = [...new Set(tags)];
    await ctx.vault.writeNote(folder, name, frontmatter, `${body}\n`);
  }

  invalidate(ctx);
  return {
    noteId: ref.id,
    path: ref.absPath,
    action: existing && !input.overwrite ? "appended" : existing ? "overwritten" : "created",
    links,
  };
}

export interface LogSessionInput {
  summary: string;
  details?: string;
  /** Source paths or note names this session touched. */
  touched?: string[];
  tags?: string[];
}

export async function logSession(ctx: ToolContext, input: LogSessionInput) {
  const date = today();
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const name = `${date} ${sanitizeName(input.summary).slice(0, 60)}`;
  const links = (input.touched ?? []).map((t) => normalizeLinkTarget(ctx, t));

  const lines = [`# ${input.summary}`, "", `**When:** ${date} ${time}`, ""];
  if (input.details?.trim()) lines.push(input.details.trim(), "");
  if (links.length) lines.push("## Touched", "", renderLinkList(links), "");
  lines.push(`Journal: ${wikilink(`${ctx.config.vault.journalFolder}/${date}`, date)}`);

  const ref = await ctx.vault.writeNote(
    ctx.config.vault.sessionsFolder,
    name,
    {
      sbv: "session",
      date,
      created: new Date().toISOString(),
      tags: [...new Set(["sbv/session", ...(input.tags ?? [])])],
    },
    `${lines.join("\n")}\n`,
  );

  // The daily note links back, so a day and its sessions are mutually reachable.
  await ctx.vault.appendToNote(
    ctx.config.vault.journalFolder,
    date,
    `- **${time}** — ${wikilink(ref.id, input.summary)}`,
    {
      frontmatter: { sbv: "journal", date, tags: ["sbv/journal"] },
      body: `# ${date}\n\nActivity in **${ctx.config.projectName}**.\n`,
    },
  );

  invalidate(ctx);
  return { noteId: ref.id, path: ref.absPath, links };
}

export interface RecordDecisionInput {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string;
  status?: string;
  affects?: string[];
  tags?: string[];
}

export async function recordDecision(ctx: ToolContext, input: RecordDecisionInput) {
  const name = sanitizeName(input.title);
  const links = (input.affects ?? []).map((t) => normalizeLinkTarget(ctx, t));
  const status = input.status?.trim() || "accepted";

  const lines = [
    `# ${input.title}`,
    "",
    `**Status:** ${status} · **Date:** ${today()}`,
    "",
    "## Context",
    "",
    input.context.trim(),
    "",
    "## Decision",
    "",
    input.decision.trim(),
    "",
  ];
  if (input.alternatives?.trim()) lines.push("## Alternatives considered", "", input.alternatives.trim(), "");
  if (input.consequences?.trim()) lines.push("## Consequences", "", input.consequences.trim(), "");
  if (links.length) lines.push("## Affects", "", renderLinkList(links), "");

  const ref = await ctx.vault.writeNote(
    ctx.config.vault.decisionsFolder,
    name,
    {
      sbv: "decision",
      status,
      date: today(),
      created: new Date().toISOString(),
      tags: [...new Set(["sbv/decision", ...(input.tags ?? [])])],
    },
    `${lines.join("\n")}\n`,
  );

  invalidate(ctx);
  return { noteId: ref.id, path: ref.absPath, links };
}

export interface SearchInput {
  query: string;
  limit?: number;
  folder?: string;
  /** Search only user-authored prose, ignoring generated blocks. */
  userContentOnly?: boolean;
}

export interface SearchHit {
  noteId: string;
  title: string;
  score: number;
  excerpt: string;
}

export async function searchNotes(ctx: ToolContext, input: SearchInput): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!terms.length) return [];

  const refs = await ctx.vault.listNotes(input.folder);
  const hits: SearchHit[] = [];

  for (const ref of refs) {
    let raw: string;
    try {
      raw = await fs.readFile(ref.absPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseNote(raw);
    const body = input.userContentOnly ? stripManagedBody(parsed.body) : parsed.body;
    const haystack = `${ref.name}\n${body}`.toLowerCase();

    let score = 0;
    for (const term of terms) {
      const nameHits = ref.name.toLowerCase().split(term).length - 1;
      const bodyHits = haystack.split(term).length - 1;
      if (bodyHits === 0) {
        score = 0;
        break;
      }
      // Title matches are worth far more than body mentions.
      score += nameHits * 10 + Math.min(bodyHits, 20);
    }
    if (score <= 0) continue;

    const firstTerm = terms[0]!;
    const index = haystack.indexOf(firstTerm);
    const start = Math.max(0, index - 80);
    const excerpt = body
      .slice(start, start + 240)
      .replace(/\s+/g, " ")
      .trim();

    hits.push({ noteId: ref.id, title: ref.name, score, excerpt });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function readNote(ctx: ToolContext, noteId: string) {
  const record = await ctx.vault.read(noteId);
  if (!record) return null;
  return {
    noteId: record.id,
    path: record.absPath,
    frontmatter: record.frontmatter,
    content: record.body,
    userContent: stripManagedBody(record.body),
  };
}

export interface ListNotesInput {
  folder?: string;
  kind?: string;
  tag?: string;
  limit?: number;
}

export async function listNotes(ctx: ToolContext, input: ListNotesInput) {
  const graph = await getGraph(ctx, true);
  let nodes = graph.nodes.filter((n) => !n.phantom);
  if (input.folder) {
    const prefix = toPosix(input.folder).replace(/\/$/, "");
    nodes = nodes.filter((n) => n.id === prefix || n.id.startsWith(`${prefix}/`));
  }
  if (input.kind) nodes = nodes.filter((n) => n.kind === input.kind);
  if (input.tag) {
    const tag = input.tag.replace(/^#/, "").toLowerCase();
    nodes = nodes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag));
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  return nodes
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((n) => ({
      noteId: n.id,
      title: n.label,
      kind: n.kind,
      tags: n.tags,
      links: n.outDegree,
      backlinks: n.inDegree,
      sourcePath: n.sourcePath,
    }));
}

export async function graphStats(ctx: ToolContext) {
  const graph = await getGraph(ctx, true);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    vaultPath: graph.vaultPath,
    nodes: graph.metrics.nodeCount,
    edges: graph.metrics.edgeCount,
    unresolvedLinks: graph.metrics.unresolvedEdges,
    orphans: graph.metrics.orphanCount,
    components: graph.metrics.componentCount,
    largestComponent: graph.metrics.largestComponent,
    averageDegree: Number(graph.metrics.averageDegree.toFixed(2)),
    topNotes: graph.metrics.hubs.slice(0, 10).map((h) => ({
      noteId: h.id,
      title: byId.get(h.id)?.label ?? h.id,
      importance: Number(h.score.toFixed(3)),
      backlinks: byId.get(h.id)?.inDegree ?? 0,
    })),
    orphanNotes: graph.metrics.orphans.slice(0, 15),
  };
}

export interface RelatedInput {
  target: string;
  depth?: number;
  limit?: number;
}

export async function relatedNotes(ctx: ToolContext, input: RelatedInput) {
  const graph = await getGraph(ctx, true);
  const wanted = normalizeLinkTarget(ctx, input.target);

  const exact = graph.nodes.find((n) => n.id === wanted);
  const byName = exact ?? graph.nodes.find((n) => n.name === wanted);
  const bySource = byName ?? graph.nodes.find((n) => n.sourcePath === input.target.trim());
  const node = bySource;
  if (!node) return null;

  const depth = Math.min(Math.max(input.depth ?? 1, 1), 3);
  const local = localGraph(graph.nodes, graph.edges, node.id, depth);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);

  const outgoing = graph.edges.filter((e) => e.source === node.id).map((e) => e.target);
  const incoming = graph.edges.filter((e) => e.target === node.id).map((e) => e.source);

  return {
    noteId: node.id,
    title: node.label,
    kind: node.kind,
    sourcePath: node.sourcePath,
    outgoing: outgoing.slice(0, limit),
    backlinks: incoming.slice(0, limit),
    neighbourhood: local.nodes
      .filter((n) => n.id !== node.id)
      .slice(0, limit)
      .map((n) => ({ noteId: n.id, title: n.label, kind: n.kind })),
  };
}

export interface LinkNotesInput {
  from: string;
  to: string;
  /** Optional sentence explaining the relationship. */
  reason?: string;
  section?: string;
}

export async function linkNotes(ctx: ToolContext, input: LinkNotesInput) {
  const fromId = normalizeLinkTarget(ctx, input.from);
  const toId = normalizeLinkTarget(ctx, input.to);
  const record = await ctx.vault.read(fromId);
  if (!record) {
    return { ok: false as const, error: `Note not found: ${fromId}` };
  }

  const section = input.section?.trim() || "Related";
  const entry = input.reason?.trim()
    ? `- ${wikilink(toId)} — ${input.reason.trim()}`
    : `- ${wikilink(toId)}`;

  if (record.body.includes(`[[${toId}]]`)) {
    return { ok: true as const, noteId: fromId, action: "already-linked" };
  }

  const heading = `## ${section}`;
  let body: string;
  if (record.body.includes(heading)) {
    // Insert directly under the existing heading to keep the section coherent.
    body = record.body.replace(heading, `${heading}\n\n${entry}`);
    await ctx.vault.writeNote(
      path.posix.dirname(fromId) === "." ? "" : path.posix.dirname(fromId),
      path.posix.basename(fromId),
      record.frontmatter,
      body,
    );
  } else {
    await ctx.vault.appendToNote(
      path.posix.dirname(fromId) === "." ? "" : path.posix.dirname(fromId),
      path.posix.basename(fromId),
      `${heading}\n\n${entry}`,
    );
  }

  invalidate(ctx);
  return { ok: true as const, noteId: fromId, action: "linked", target: toId };
}

export async function noteForSourcePath(ctx: ToolContext, sourcePath: string) {
  const rel = toPosix(sourcePath).replace(/^\.\//, "");
  const noteId = `${ctx.config.mirror.folder}/Files/${fileNoteName(rel)}`;
  const record = await ctx.vault.read(noteId);
  return {
    sourcePath: rel,
    noteId,
    exists: Boolean(record),
    path: ctx.vault.absPathFor(noteId),
  };
}

export async function syncNow(ctx: ToolContext) {
  const report = await runSync(ctx.config, { vault: ctx.vault });
  invalidate(ctx);
  return {
    created: report.counts.created,
    updated: report.counts.updated,
    unchanged: report.counts.unchanged,
    deleted: report.counts.deleted,
    durationMs: report.durationMs,
    files: report.stats.fileCount,
    lines: report.stats.totalLines,
    vaultPath: ctx.vault.root,
  };
}

/** The `obsidian://` URI that opens a note, or the vault if no note is given. */
export function obsidianUri(vaultRoot: string, noteId?: string): string {
  if (noteId) {
    // Ids never carry the extension, including ids that themselves end in .md.
    return `obsidian://open?path=${encodeURIComponent(path.join(vaultRoot, `${noteId}.md`))}`;
  }
  return `obsidian://open?path=${encodeURIComponent(vaultRoot)}`;
}

export { slugify };
