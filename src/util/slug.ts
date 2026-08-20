/**
 * Filename and note-title derivation.
 *
 * Obsidian resolves `[[wikilinks]]` by note *title* (the basename), so every
 * generated note needs a basename that is unique across the vault, stable
 * across syncs, and legal on case-insensitive filesystems. We therefore encode
 * a source path into a single flat basename rather than nesting directories:
 * `src/mirror/scanner.ts` -> `src.mirror.scanner.ts`.
 */

const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

/** Characters Obsidian forbids in note names, plus path separators. */
export function sanitizeName(name: string): string {
  return name
    .replace(ILLEGAL, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 180);
}

/** `src/mirror/scanner.ts` -> `src.mirror.scanner.ts` (unique, readable, flat). */
export function pathToNoteName(relPath: string): string {
  const normalized = relPath.split(/[\\/]/).filter(Boolean).join(".");
  return sanitizeName(normalized) || "untitled";
}

/** `src/mirror` -> `src.mirror`; the repo root becomes a stable sentinel. */
export function dirToNoteName(relDir: string): string {
  if (!relDir || relDir === "." || relDir === "/") return "root";
  return pathToNoteName(relDir);
}

/** npm/pypi style package specifiers -> a safe note name. */
export function packageToNoteName(spec: string): string {
  return sanitizeName(spec.replace(/^@/, "").replace(/\//g, "."));
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Tag segments may not contain spaces or most punctuation in Obsidian. */
export function tagSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_\-/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
