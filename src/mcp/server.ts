import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { Vault } from "../vault/vault.js";
import { setQuiet } from "../util/log.js";
import {
  captureNote,
  graphStats,
  linkNotes,
  listNotes,
  logSession,
  noteForSourcePath,
  obsidianUri,
  readNote,
  recordDecision,
  relatedNotes,
  searchNotes,
  syncNow,
  type ToolContext,
} from "./tools.js";

/**
 * The MCP surface over the vault.
 *
 * This is the half of the connector that closes the loop: the mirror pushes the
 * codebase into the graph automatically, and these tools let an assistant add
 * the things a parser can never infer — why a decision was made, what a module
 * is *for*, what was tried and abandoned.
 *
 * Every handler returns both prose (for the model to read) and structured
 * content (for programmatic callers).
 */

function ok(text: string, structured?: Record<string, unknown>) {
  return structured
    ? { content: [{ type: "text" as const, text }], structuredContent: structured }
    : { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createMcpServer(config: Config): McpServer {
  const vault = new Vault(config);
  const ctx: ToolContext = { config, vault };

  const server = new McpServer({
    name: "second-brain-visualizer",
    version: "0.1.0",
  });

  server.registerTool(
    "sbv_sync",
    {
      title: "Sync codebase to Obsidian",
      description:
        "Mirror the current state of the project into the Obsidian vault. Run this after making file changes so the graph reflects them. Returns how many notes changed.",
      inputSchema: {},
    },
    async () => {
      await vault.ensure();
      const result = await syncNow(ctx);
      return ok(
        `Synced ${result.files} files (${result.lines} lines) in ${result.durationMs}ms: ` +
          `${result.created} created, ${result.updated} updated, ${result.deleted} deleted. Vault: ${result.vaultPath}`,
        result,
      );
    },
  );

  server.registerTool(
    "sbv_capture_note",
    {
      title: "Capture a note",
      description:
        "Write a concept note into the vault and link it to code files or other notes. Use this to record understanding that is not derivable from the source: what a subsystem is for, how two parts relate, an explanation worth keeping. Links may be source paths (src/foo.ts), note ids, or note names.",
      inputSchema: {
        title: z.string().min(1).describe("Note title; becomes the filename and the graph label"),
        content: z.string().min(1).describe("Markdown body of the note"),
        folder: z.string().optional().describe("Vault folder (default: Concepts)"),
        tags: z.array(z.string()).optional().describe("Tags without the leading #"),
        links: z
          .array(z.string())
          .optional()
          .describe("Notes or source paths to link to, creating graph edges"),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace the note if it exists (default: append to it)"),
      },
    },
    async (args) => {
      await vault.ensure();
      const result = await captureNote(ctx, args);
      return ok(`Note ${result.action}: ${result.noteId} (${result.links.length} links)`, result);
    },
  );

  server.registerTool(
    "sbv_log_session",
    {
      title: "Log a work session",
      description:
        "Record what was just worked on as a session note, linked to the files it touched and to today's daily note. Use at the end of a piece of work so the vault keeps a navigable history.",
      inputSchema: {
        summary: z.string().min(1).describe("One-line summary of the work"),
        details: z.string().optional().describe("Longer markdown description"),
        touched: z
          .array(z.string())
          .optional()
          .describe("Source paths or notes this work touched"),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      await vault.ensure();
      const result = await logSession(ctx, args);
      return ok(`Session logged: ${result.noteId}`, result);
    },
  );

  server.registerTool(
    "sbv_record_decision",
    {
      title: "Record a decision",
      description:
        "Write an architecture decision record into the vault, linked to the code it affects. Use when a choice is made that future readers would otherwise have to reverse-engineer.",
      inputSchema: {
        title: z.string().min(1),
        context: z.string().min(1).describe("The situation that forced a choice"),
        decision: z.string().min(1).describe("What was decided"),
        alternatives: z.string().optional().describe("What else was considered, and why not"),
        consequences: z.string().optional().describe("What this makes easier or harder"),
        status: z.string().optional().describe("accepted | superseded | proposed"),
        affects: z.array(z.string()).optional().describe("Source paths or notes affected"),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      await vault.ensure();
      const result = await recordDecision(ctx, args);
      return ok(`Decision recorded: ${result.noteId}`, result);
    },
  );

  server.registerTool(
    "sbv_search",
    {
      title: "Search the vault",
      description:
        "Full-text search across every note. Use before writing a new note to avoid duplicating one that already exists.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        folder: z.string().optional().describe("Restrict to a vault folder"),
        userContentOnly: z
          .boolean()
          .optional()
          .describe("Search only hand-written prose, skipping generated blocks"),
      },
    },
    async (args) => {
      const hits = await searchNotes(ctx, args);
      if (!hits.length) return ok(`No notes matched "${args.query}".`, { hits: [] });
      const lines = hits.map((h) => `- **${h.title}** (${h.noteId})\n  ${h.excerpt}`);
      return ok(`${hits.length} result(s):\n\n${lines.join("\n")}`, { hits });
    },
  );

  server.registerTool(
    "sbv_read_note",
    {
      title: "Read a note",
      description: "Read a note's frontmatter and full markdown content by note id.",
      inputSchema: {
        noteId: z.string().min(1).describe("Vault-relative id, e.g. Concepts/Sync pipeline"),
      },
    },
    async ({ noteId }) => {
      const note = await readNote(ctx, noteId);
      if (!note) return fail(`Note not found: ${noteId}`);
      return ok(note.content, note as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "sbv_list_notes",
    {
      title: "List notes",
      description:
        "List notes in the vault, optionally filtered by folder, kind (file, module, package, concept, session, decision, journal), or tag.",
      inputSchema: {
        folder: z.string().optional(),
        kind: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args) => {
      const notes = await listNotes(ctx, args);
      const lines = notes.map(
        (n) => `- ${n.noteId} [${n.kind}] links:${n.links} backlinks:${n.backlinks}`,
      );
      return ok(`${notes.length} note(s):\n${lines.join("\n")}`, { notes });
    },
  );

  server.registerTool(
    "sbv_graph_stats",
    {
      title: "Graph statistics",
      description:
        "Structural overview of the knowledge graph: size, connectivity, the most important notes by PageRank, and unlinked orphans. Use to find what matters or what is disconnected.",
      inputSchema: {},
    },
    async () => {
      const stats = await graphStats(ctx);
      const top = stats.topNotes.map((n) => `  - ${n.noteId} (${n.backlinks} backlinks)`).join("\n");
      const text =
        `Vault: ${stats.vaultPath}\n` +
        `${stats.nodes} notes, ${stats.edges} links, ${stats.unresolvedLinks} unresolved\n` +
        `${stats.components} component(s), largest ${stats.largestComponent}, ${stats.orphans} orphan(s)\n` +
        `Average degree ${stats.averageDegree}\n\nMost important notes:\n${top}`;
      return ok(text, stats as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "sbv_related",
    {
      title: "Find related notes",
      description:
        "Given a note or a source path, return its outgoing links, backlinks, and surrounding neighbourhood. Use to discover what a change might affect.",
      inputSchema: {
        target: z.string().min(1).describe("Note id, note name, or source path"),
        depth: z.number().int().min(1).max(3).optional().describe("Neighbourhood radius (default 1)"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      const result = await relatedNotes(ctx, args);
      if (!result) return fail(`Nothing in the vault matches: ${args.target}`);
      const text =
        `${result.title} [${result.kind}]\n` +
        `Links out (${result.outgoing.length}): ${result.outgoing.slice(0, 15).join(", ") || "none"}\n` +
        `Backlinks (${result.backlinks.length}): ${result.backlinks.slice(0, 15).join(", ") || "none"}`;
      return ok(text, result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "sbv_link_notes",
    {
      title: "Link two notes",
      description:
        "Add a wikilink from one note to another, creating an edge in the graph. Use to connect a concept to the code that implements it.",
      inputSchema: {
        from: z.string().min(1).describe("Note id to add the link to"),
        to: z.string().min(1).describe("Note id or source path to link to"),
        reason: z.string().optional().describe("Short explanation of the relationship"),
        section: z.string().optional().describe("Heading to file the link under (default: Related)"),
      },
    },
    async (args) => {
      const result = await linkNotes(ctx, args);
      if (!result.ok) return fail(result.error);
      return ok(`${result.action}: ${result.noteId} -> ${result.target ?? ""}`, result);
    },
  );

  server.registerTool(
    "sbv_note_for_file",
    {
      title: "Find the note for a source file",
      description:
        "Map a source path such as src/cli.ts to its mirrored note id, so it can be linked to or read.",
      inputSchema: {
        sourcePath: z.string().min(1).describe("Project-relative source path"),
      },
    },
    async ({ sourcePath }) => {
      const result = await noteForSourcePath(ctx, sourcePath);
      return ok(
        result.exists
          ? `${result.sourcePath} -> ${result.noteId}`
          : `No note yet for ${result.sourcePath} (run sbv_sync). Expected id: ${result.noteId}`,
        result,
      );
    },
  );

  server.registerTool(
    "sbv_open_in_obsidian",
    {
      title: "Get an Obsidian deep link",
      description:
        "Return the obsidian:// URI that opens the vault, or a specific note, in the Obsidian desktop app.",
      inputSchema: {
        noteId: z.string().optional().describe("Note to open; omit to open the vault"),
      },
    },
    async ({ noteId }) => {
      const uri = obsidianUri(vault.root, noteId);
      return ok(uri, { uri, vaultPath: vault.root });
    },
  );

  return server;
}

/** Entry point used by `sbv mcp`. */
export async function runMcpServer(config: Config): Promise<void> {
  // stdout belongs to the JSON-RPC transport; anything else corrupts it.
  setQuiet(true);
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Readiness goes straight to stderr: it is not an error, and stdout is the transport.
  process.stderr.write(`second-brain-visualizer MCP server ready (vault: ${config.vault.path})\n`);
}
