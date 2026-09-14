import { db } from "../db/index.js";
import { CONTENT_RATING_ORDER, contentRatingRank } from "./contentRatings.js";
import { qualityRank } from "./quality.js";

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
}

export interface MediaQuery {
  /** null means "no rows can match" (e.g. a household account with an empty allowedTypes list) —
   * callers should short-circuit rather than run a query that can only return zero rows. */
  where: string | null;
  params: unknown[];
  fromClause: string;
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
  else if (filters.status === "missing") conditions.push("m.has_file = 0");
  else if (filters.status === "downloaded") conditions.push("m.has_file = 1");
  else if (filters.status === "unmatched") {
    conditions.push("(m.external_ids IS NULL OR m.external_ids = '' OR m.external_ids = '{}')");
  } else if (filters.status === "cutoffUnmet") {
    const ids = await findCutoffUnmetIds();
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
