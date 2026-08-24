import { db } from "../db/index.js";

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface PossibleDuplicate {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

/**
 * Catches likely duplicates *before* they're created, rather than only after the fact via the
 * "repeated imports" health check — normalized-title match within the same library type, plus a
 * year match when both sides have one (so "Dune" 1984 and "Dune" 2021 aren't flagged against
 * each other, but two "Dune (2021)" adds would be).
 */
export async function findPossibleDuplicates(type: string, title: string, year: number | null): Promise<PossibleDuplicate[]> {
  const needle = normalizeTitle(title);
  if (!needle) return [];

  const candidates = (await db.prepare("SELECT id, title, year, poster_url FROM media_items WHERE type = ?").all(type)) as {
    id: number;
    title: string;
    year: number | null;
    poster_url: string | null;
  }[];

  return candidates
    .filter((c) => {
      const candidateNormalized = normalizeTitle(c.title);
      if (candidateNormalized !== needle) return false;
      if (year != null && c.year != null && year !== c.year) return false;
      return true;
    })
    .map((c) => ({ id: c.id, title: c.title, year: c.year, posterUrl: c.poster_url }));
}
