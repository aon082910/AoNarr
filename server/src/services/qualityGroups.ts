/**
 * Qualities a profile treats as one tier ("WEBDL-1080p" and "WEBRip-1080p"): none is an upgrade over another, so
 * the custom-format score and the rest of the sort decide between them. Each group names two or more qualities, and
 * a quality is in at most one group. Pure, so the row mapper can use it without pulling in the database.
 */
export type QualityGroups = string[][];

/** The groups out of a stored value (JSON text or a list), with anything malformed left out. */
export function parseQualityGroups(raw: unknown): QualityGroups {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: QualityGroups = [];
  for (const group of value) {
    if (!Array.isArray(group)) continue;
    const names = Array.from(new Set(group.filter((n): n is string => typeof n === "string" && n !== "" && !seen.has(n))));
    if (names.length < 2) continue;
    for (const n of names) seen.add(n);
    groups.push(names);
  }
  return groups;
}

/**
 * The quality names a profile ranks by, worst to best (`quality_profiles.quality_order`), out of a stored value (JSON
 * text or a list). Null when the profile has none: an absent, empty or malformed value is the global ladder order.
 * Repeated names count once, at their first place.
 */
export function parseQualityOrder(raw: unknown): string[] | null {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const names = Array.from(new Set(value.filter((n): n is string => typeof n === "string" && n !== "")));
  return names.length > 0 ? names : null;
}

/**
 * How one quality profile ranks the ladder: the qualities it treats as one tier, and the order it puts the
 * qualities in. Every comparison made for a profile (is the file under the cutoff, is the release an upgrade,
 * which of the candidates is best) goes through this and nothing else, so a profile that ranks WEB-DL over
 * Blu-ray is read the same way by the search, the RSS sync, the importer and the Cutoff Unmet page.
 *
 * `order` null is the global order of the `qualities` table: exactly what profiles ranked by before they could
 * have their own.
 */
export interface ProfileRanking {
  groups: QualityGroups;
  order: string[] | null;
}

/** The ranking of no profile at all: the global ladder and no groups. */
export const GLOBAL_RANKING: ProfileRanking = Object.freeze({ groups: [], order: null }) as ProfileRanking;

/** The ranking a quality profile row (`quality_groups`, `quality_order`) describes. The one place it is built from a row. */
export function rankingFromRow(row: { quality_groups?: unknown; quality_order?: unknown } | null | undefined): ProfileRanking {
  if (!row) return GLOBAL_RANKING;
  return { groups: parseQualityGroups(row.quality_groups), order: parseQualityOrder(row.quality_order) };
}

/** The ranking of a mapped quality profile (`qualityProfileFromRow`, or any object that carries its two fields). */
export function rankingOf(profile: { qualityGroups?: QualityGroups | null; qualityOrder?: string[] | null } | null | undefined): ProfileRanking {
  if (!profile) return GLOBAL_RANKING;
  const groups = profile.qualityGroups ?? [];
  const order = profile.qualityOrder && profile.qualityOrder.length > 0 ? profile.qualityOrder : null;
  return groups.length === 0 && order === null ? GLOBAL_RANKING : { groups, order };
}
