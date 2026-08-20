import YAML from "yaml";

/**
 * Frontmatter + managed-region handling for vault notes.
 *
 * Two rules drive this module, and both exist to protect the human:
 *   1. Unknown frontmatter keys are preserved verbatim on rewrite.
 *   2. Generated body content lives between managed markers; anything outside
 *      them is authored by the user and is never touched by a sync.
 */

export const MANAGED_BEGIN = "<!-- sbv:begin -->";
export const MANAGED_END = "<!-- sbv:end -->";

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  /** Body with frontmatter stripped. */
  body: string;
  /** True when the source had a frontmatter block at all. */
  hadFrontmatter: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseNote(raw: string): ParsedNote {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: {}, body: raw, hadFrontmatter: false };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(match[1] ?? "") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML in a user-edited note: keep the body, drop the metadata
    // rather than throwing away the note or crashing the sync.
    frontmatter = {};
  }
  return { frontmatter, body: raw.slice(match[0].length), hadFrontmatter: true };
}

export function stringifyNote(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body.startsWith("\n") ? body.trimStart() : body;
  const yaml = YAML.stringify(frontmatter, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    singleQuote: false,
  }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

/**
 * Replace only the managed region of an existing body.
 *
 * If the note has no managed region yet, the generated block is prepended and
 * any pre-existing prose is kept below it under a "Notes" heading boundary the
 * user can move freely.
 */
export function applyManagedBody(existingBody: string | null, managed: string): string {
  const block = `${MANAGED_BEGIN}\n${managed.trim()}\n${MANAGED_END}`;
  if (existingBody === null) return `${block}\n`;

  const begin = existingBody.indexOf(MANAGED_BEGIN);
  const end = existingBody.indexOf(MANAGED_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existingBody.slice(0, begin);
    const after = existingBody.slice(end + MANAGED_END.length);
    return `${before}${block}${after}`;
  }
  const userContent = existingBody.trim();
  if (!userContent) return `${block}\n`;
  return `${block}\n\n${userContent}\n`;
}

/** The user-authored remainder of a note, with the managed block removed. */
export function stripManagedBody(body: string): string {
  const begin = body.indexOf(MANAGED_BEGIN);
  const end = body.indexOf(MANAGED_END);
  if (begin === -1 || end === -1 || end < begin) return body.trim();
  return `${body.slice(0, begin)}${body.slice(end + MANAGED_END.length)}`.trim();
}

/** Wikilink with an optional display alias: `[[Target|Alias]]`. */
export function wikilink(target: string, alias?: string): string {
  const safeTarget = target.replace(/[[\]|]/g, "");
  if (!alias || alias === safeTarget) return `[[${safeTarget}]]`;
  return `[[${safeTarget}|${alias.replace(/[[\]|]/g, "")}]]`;
}

const WIKILINK_RE = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EMBED_RE = /!\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export interface ExtractedLink {
  target: string;
  alias?: string;
  embed: boolean;
}

/** Pull every outgoing link out of note body text. */
export function extractLinks(body: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

  const embeds = new Set<string>();
  for (const m of withoutCode.matchAll(EMBED_RE)) {
    if (m[1]) embeds.add(m[1].trim());
  }
  for (const m of withoutCode.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (!target) continue;
    const key = `w:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, alias: m[2]?.trim(), embed: embeds.has(target) });
  }
  for (const m of withoutCode.matchAll(MD_LINK_RE)) {
    const href = m[1];
    if (!href || /^[a-z]+:/i.test(href) || href.startsWith("#")) continue;
    const target = decodeURIComponent(href).replace(/\.md$/i, "");
    const key = `m:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, embed: false });
  }
  return out;
}

/** Inline `#tags` plus frontmatter `tags:` entries. */
export function extractTags(body: string, frontmatter: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  const fmTags = frontmatter.tags ?? frontmatter.tag;
  if (typeof fmTags === "string") {
    for (const t of fmTags.split(/[,\s]+/)) if (t) tags.add(t.replace(/^#/, ""));
  } else if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === "string" && t) tags.add(t.replace(/^#/, ""));
  }
  const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of withoutCode.matchAll(/(?:^|\s)#([A-Za-z][\w\-/]*)/g)) {
    if (m[1]) tags.add(m[1]);
  }
  return [...tags];
}

export function firstHeading(body: string): string | null {
  const m = /^#{1,6}\s+(.+)$/m.exec(stripManagedBody(body));
  return m?.[1]?.trim() ?? null;
}

/** Escape a value so it is safe inside a markdown table cell. */
export function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
