/** Human-readable "what's happening" description for a calendar entry, by media shape/type.
 * AoNarr stores a single `release_date` per movie/collection-child (no theatrical/digital/physical
 * split — that would need TMDB's separate per-region release_dates endpoint and a schema change to
 * store more than one date per item, tracked as follow-up work, not implemented here) — so a movie
 * always reads as "Movie release" rather than "Theatrical release"/"Digital release" etc. */
const COLLECTION_RELEASE_LABELS: Record<string, string> = {
  artist: "Album release",
  author: "Book release",
  audiobook: "Audiobook release",
  comic: "Issue release",
  manga: "Chapter release",
  video: "New video",
  course: "New lesson",
};

const SINGLE_RELEASE_LABELS: Record<string, string> = {
  movie: "Movie release",
  rom: "Game release",
  adult: "Release",
};

export function describeCalendarEntry(entry: {
  kind: "media" | "event";
  type: string;
  episodeId: number | null;
  subItemId: number | null;
  label: string;
}): string {
  if (entry.kind === "event") return entry.label || "Custom event";
  if (entry.episodeId) return `New episode — ${entry.label}`;
  if (entry.subItemId) return `${COLLECTION_RELEASE_LABELS[entry.type] ?? "New release"} — ${entry.label}`;
  return SINGLE_RELEASE_LABELS[entry.type] ?? "Release";
}
