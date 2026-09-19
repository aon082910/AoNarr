import { db } from "../db/index.js";
import { CONTENT_RATING_ORDER, contentRatingRank } from "./contentRatings.js";
import { qualityRank } from "./quality.js";
import { typeKeysByShape } from "./mediaTypes.js";

/** Shared WHERE-clause builder for GET /api/media and GET /api/media/stats — both need the exact
 * same row-selection scope (type/tagId/groupId/status/contentRating/household restrictions), just
 * one returns paginated rows and the other returns aggregates over the same set. Building this in
 * one place keeps the two routes from silently drifting apart on what counts as "in scope". */
export interface MediaQueryFilters {
  type?: string;
  tagId?: string;
  groupId?: string;
  status?: string;
  contentRating?: string;
  allowedTypes: string[] | null;
  maxContentRating?: string | null;
  /** Free-text title search, scoped to whatever other filters already narrowed this query to. On
   * SQLite this also matches episode/child (album/book/...) titles via the library_search_fts
   * index (see schema.sql); Postgres has no FTS5, so it falls back to a plain `title ILIKE`
   * against the item's own title only. */
  q?: string;
}

export interface MediaQuery {
  /** null means "no rows can match" (e.g. a household account with an empty allowedTypes list) —
   * callers should short-circuit rather than run a query that can only return zero rows. */
  where: string | null;
  params: unknown[];
  fromClause: string;
}

/** Turns free-typed user input into an FTS5 query string: each whitespace-separated token is
 * phrase-quoted (escaping any literal `"` by doubling it, FTS5's own escape convention) so
 * special MATCH-syntax characters in the input (`-`, `*`, `AND`/`OR`/`NOT` as bare words, etc.)
 * are never interpreted as query syntax, then suffixed with `*` for prefix matching — searching
 * "aveng" finds "Avengers". Multiple tokens are implicitly AND'd (FTS5's default), same as typing
 * more words into a search box should narrow results, not broaden them. */
export function toFts5Query(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");
}

const TITLE_MATCH_STOPWORDS = new Set(["the", "and", "of", "a", "an", "in", "on", "to", "for"]);

/** Lowercased, punctuation/extension-stripped significant words (len > 2, stopwords dropped) —
 * used to compare a title against a filename with basic word overlap rather than an exact string
 * match, since real filenames carry release-group tags, resolution, year, and separators a title
 * never has. */
function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[._\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TITLE_MATCH_STOPWORDS.has(w));
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** True when fewer than half of a title's significant words show up anywhere in the file's name —
 * a rough but effective signal for "this file probably isn't actually this item" (a bad indexer
 * match, a manual import into the wrong item, a renamed/moved file that predates being tracked).
 * Titles with no significant words of their own (all stopwords, or very short) never flag — there's
 * nothing meaningful to compare. */
function filenameLooksMismatched(title: string, filePath: string): boolean {
  const titleWords = significantWords(title);
  if (titleWords.length === 0) return false;
  const fileWords = new Set(significantWords(basename(filePath)));
  const matchedCount = titleWords.filter((w) => fileWords.has(w)).length;
  return matchedCount / titleWords.length < 0.5;
}

/** Scoped to `media_items.path` only — the single file a movie (or other single-file library type)
 * owns directly. Series/music/book-style items spread their files across episodes/sub_items
 * instead, each with its own title to compare against; surfacing those would need a different UI
 * (an episode/track list, not the library grid this filter lives on), so that's left for later. */
async function findFilenameMismatchIds(): Promise<number[]> {
  const rows = (await db
    .prepare(`SELECT id, title, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL`)
    .all()) as { id: number; title: string; path: string }[];
  return rows.filter((r) => filenameLooksMismatched(r.title, r.path)).map((r) => r.id);
}

/** Radarr/Sonarr-style "cutoff unmet" — every downloaded item whose current quality ranks below
 * its own quality profile's cutoff, i.e. still eligible for an automatic upgrade search. Resolved
 * as a plain id set (rather than a SQL join + CASE expression) since quality-name-to-rank is
 * already an in-memory lookup (services/quality.ts) built for exactly this comparison — reusing it
 * here keeps this in sync with the same ranking every search/grab decision already uses. */
async function findCutoffUnmetIds(): Promise<number[]> {
  const rows = (await db
    .prepare(
      `SELECT m.id AS id, m.quality AS quality, qp.cutoff AS cutoff
       FROM media_items m JOIN quality_profiles qp ON qp.id = m.quality_profile_id
       WHERE m.has_file = 1 AND m.quality IS NOT NULL`
    )
    .all()) as { id: number; quality: string | null; cutoff: string }[];
  return rows.filter((r) => qualityRank(r.quality) < qualityRank(r.cutoff)).map((r) => r.id);
}

/** For episodic (series/anime/sports) and collection (music/books/comics/...) shapes, a media
 * item's own `has_file` only means "at least one episode/track has a file" (see
 * services/childCounts.ts) — filtering "downloaded"/"missing" on that flag alone showed a series
 * with 1 of 10 episodes under "Downloaded" and hid it from "Missing". This instead treats
 * "downloaded" as fully complete (every episode/track present) and "missing" as its exact
 * complement (nothing, or only some, present) for those two shapes, while single-file shapes
 * (movies, ROMs, ...) keep the plain has_file check they always had. */
function downloadStatusCondition(kind: "downloaded" | "missing"): { sql: string; params: unknown[] } {
  const episodicTypes = typeKeysByShape("episodic");
  const collectionTypes = typeKeysByShape("collection");
  const params: unknown[] = [];

  function inList(keys: string[]): string {
    params.push(...keys);
    return keys.map(() => "?").join(",");
  }

  const singleClause = `m.type NOT IN (${inList([...episodicTypes, ...collectionTypes])}) AND m.has_file = ${kind === "downloaded" ? 1 : 0}`;

  const episodicComplete = `NOT EXISTS (SELECT 1 FROM episodes e WHERE e.media_item_id = m.id AND e.has_file = 0) AND EXISTS (SELECT 1 FROM episodes e2 WHERE e2.media_item_id = m.id)`;
  const episodicClause =
    episodicTypes.length === 0
      ? "1=0"
      : `m.type IN (${inList(episodicTypes)}) AND ${kind === "downloaded" ? episodicComplete : `NOT (${episodicComplete})`}`;

  const collectionComplete = `NOT EXISTS (SELECT 1 FROM sub_items s WHERE s.media_item_id = m.id AND s.has_file = 0) AND EXISTS (SELECT 1 FROM sub_items s2 WHERE s2.media_item_id = m.id)`;
  const collectionClause =
    collectionTypes.length === 0
      ? "1=0"
      : `m.type IN (${inList(collectionTypes)}) AND ${kind === "downloaded" ? collectionComplete : `NOT (${collectionComplete})`}`;

  return { sql: `((${singleClause}) OR (${episodicClause}) OR (${collectionClause}))`, params };
}

export async function buildMediaQuery(filters: MediaQueryFilters): Promise<MediaQuery> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let joinTags = false;

  if (filters.tagId) {
    joinTags = true;
    conditions.push("mit.tag_id = ?");
    params.push(filters.tagId);
    if (filters.type) {
      conditions.push("m.type = ?");
      params.push(filters.type);
    }
  } else if (filters.groupId === "none" && filters.type) {
    conditions.push("m.type = ?", "m.group_id IS NULL");
    params.push(filters.type);
  } else if (filters.groupId) {
    conditions.push("m.group_id = ?");
    params.push(filters.groupId);
  } else if (filters.type) {
    conditions.push("m.type = ?");
    params.push(filters.type);
  }

  // Same blanket restriction the old row-filtering approach applied to every branch above — only
  // needed when `type` itself wasn't already given (a given `type` is validated against
  // allowedTypes by the caller before this ever runs).
  if (!filters.type && filters.allowedTypes) {
    if (filters.allowedTypes.length === 0) return { where: null, params: [], fromClause: "" };
    conditions.push(`m.type IN (${filters.allowedTypes.map(() => "?").join(",")})`);
    params.push(...filters.allowedTypes);
  }

  if (filters.status === "monitored") conditions.push("m.monitored = 1");
  else if (filters.status === "unmonitored") conditions.push("m.monitored = 0");
  else if (filters.status === "missing" || filters.status === "downloaded") {
    const { sql, params: statusParams } = downloadStatusCondition(filters.status);
    conditions.push(sql);
    params.push(...statusParams);
  } else if (filters.status === "unmatched") {
    conditions.push("(m.external_ids IS NULL OR m.external_ids = '' OR m.external_ids = '{}')");
  } else if (filters.status === "cutoffUnmet") {
    const ids = await findCutoffUnmetIds();
    if (ids.length === 0) return { where: null, params: [], fromClause: "" };
    conditions.push(`m.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  } else if (filters.status === "filenameMismatch") {
    const ids = await findFilenameMismatchIds();
    if (ids.length === 0) return { where: null, params: [], fromClause: "" };
    conditions.push(`m.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }

  if (filters.contentRating && filters.contentRating !== "all") {
    conditions.push("m.content_rating = ?");
    params.push(filters.contentRating);
  }

  const maxRank = contentRatingRank(filters.maxContentRating ?? null);
  if (maxRank !== null) {
    const blocked = CONTENT_RATING_ORDER.filter((_, idx) => idx > maxRank);
    if (blocked.length > 0) {
      conditions.push(`(m.content_rating IS NULL OR m.content_rating NOT IN (${blocked.map(() => "?").join(",")}))`);
      params.push(...blocked);
    }
  }

  if (filters.q?.trim()) {
    if (db.dialect === "postgres") {
      conditions.push("m.title ILIKE ?");
      params.push(`%${filters.q.trim()}%`);
    } else {
      const ftsQuery = toFts5Query(filters.q);
      if (ftsQuery) {
        conditions.push("m.id IN (SELECT media_item_id FROM library_search_fts WHERE library_search_fts MATCH ?)");
        params.push(ftsQuery);
      }
    }
  }

  return {
    where: conditions.length > 0 ? conditions.join(" AND ") : "1=1",
    params,
    fromClause: joinTags ? "media_items m JOIN media_item_tags mit ON mit.media_item_id = m.id" : "media_items m",
  };
}

export const MEDIA_SORT_COLUMNS: Record<string, string> = {
  title: "m.sort_title ASC",
  year: "m.year DESC",
  status: "m.has_file DESC",
  monitored: "m.monitored DESC",
  quality: "m.quality ASC",
  contentRating: "m.content_rating ASC",
  added: "m.id DESC",
  releaseDate: "m.release_date DESC",
  path: "m.path ASC",
  sizeOnDisk: "m.size_bytes DESC",
};

export function clampLimit(raw: unknown, fallback = 60, max = 500): number {
  const n = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function clampOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? 0), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
