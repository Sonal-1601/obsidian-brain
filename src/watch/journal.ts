import type { Config } from "../config.js";
import type { Vault } from "../vault/vault.js";
import type { SyncReport } from "../mirror/sync.js";
import { wikilink } from "../util/markdown.js";

/**
 * Daily notes recording what changed and when.
 *
 * This is the part that turns the mirror into a history: the graph shows the
 * codebase as it is now, while the journal links each day to the files touched
 * that day, so the vault answers "what was I working on last Tuesday".
 */

export function today(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function clockTime(date = new Date()): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export async function writeJournalEntry(
  vault: Vault,
  config: Config,
  report: SyncReport,
  changedPaths: string[],
): Promise<void> {
  const date = today();
  const time = clockTime();

  // Link to the notes for source files that actually changed, so the daily note
  // becomes a hub connecting the day to the parts of the codebase it touched.
  const touched = changedPaths
    .map((rel) => report.model.files.get(rel))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .slice(0, 25);

  const lines: string[] = [];
  const c = report.counts;
  const summary = [
    c.created ? `${c.created} new` : null,
    c.updated ? `${c.updated} updated` : null,
    c.deleted ? `${c.deleted} removed` : null,
  ]
    .filter(Boolean)
    .join(", ");

  lines.push(`- **${time}** — sync: ${summary || "no changes"}`);
  for (const entry of touched) {
    lines.push(`\t- ${wikilink(entry.noteId, entry.relPath)}`);
  }

  await vault.appendToNote(config.vault.journalFolder, date, lines.join("\n"), {
    frontmatter: { sbv: "journal", date, tags: ["sbv/journal"] },
    body: `# ${date}\n\nActivity in **${config.projectName}**.\n`,
  });
}
