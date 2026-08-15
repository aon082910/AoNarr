/**
 * A single combined MPAA (movies) + TV Parental Guidelines (TV) ordering, loosest to strictest,
 * so a household account's "max content rating" can gate either kind of library with one setting
 * rather than needing two separate scales. Items with no rating set (`null`/unknown — most items,
 * since no metadata provider's *search* endpoint returns a rating, only certain detail lookups)
 * are never blocked by a restriction: there's no reliable signal to block on, and erring toward
 * "visible" avoids silently hiding library items a household member should be able to see.
 */
export const CONTENT_RATING_ORDER = [
  "G",
  "TV-Y",
  "TV-Y7",
  "TV-G",
  "PG",
  "TV-PG",
  "PG-13",
  "TV-14",
  "R",
  "TV-MA",
  "NC-17",
];

export function contentRatingRank(rating: string | null): number | null {
  if (!rating) return null;
  const idx = CONTENT_RATING_ORDER.indexOf(rating);
  return idx === -1 ? null : idx;
}

/** True if `rating` should be hidden from someone restricted to `maxRating`. Unrated content (or
 * a `maxRating` of null, meaning "no restriction") is never blocked — see module doc. */
export function isRatingBlocked(rating: string | null, maxRating: string | null): boolean {
  const maxRank = contentRatingRank(maxRating);
  if (maxRank === null) return false;
  const rank = contentRatingRank(rating);
  if (rank === null) return false;
  return rank > maxRank;
}
