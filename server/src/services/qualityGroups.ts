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
