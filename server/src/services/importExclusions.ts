import { db } from "../db/client.js";

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * "Never add this again" check for a candidate title — used before auto-adding from
 * recommendations/Trakt sync, and to annotate metadata search results so a rejected title stays
 * rejected instead of resurfacing every time. Matches by external id first (exact and reliable
 * when both sides have one), falling back to normalized-title (+ year, when both sides have one)
 * within the same media type — the same heuristic `findPossibleDuplicates` uses for the library
 * itself.
 */
export function isExcluded(
  type: string,
  title: string,
  year: number | null,
  externalId?: string | null,
  externalProvider?: string | null
): boolean {
  if (externalId && externalProvider) {
    const byExternalId = db
      .prepare("SELECT id FROM import_exclusions WHERE type = ? AND external_id = ? AND external_provider = ?")
      .get(type, externalId, externalProvider);
    if (byExternalId) return true;
  }

  const needle = normalizeTitle(title);
  if (!needle) return false;
  const candidates = db.prepare("SELECT title, year FROM import_exclusions WHERE type = ?").all(type) as {
    title: string;
    year: number | null;
  }[];
  return candidates.some((c) => {
    if (normalizeTitle(c.title) !== needle) return false;
    if (year != null && c.year != null && year !== c.year) return false;
    return true;
  });
}
