export interface TrashSpecification {
  implementation: string;
  negate?: boolean;
  required?: boolean;
  /** TRaSH-Guides files (and Radarr/Sonarr's own UI "Export" JSON) use a plain object here; the
   * live `/api/v3/customformat` resource returns an array of `{ name, value, ... }` field
   * descriptors instead — both are accepted (see fieldMap). */
  fields?: { value?: string | number; min?: number; max?: number } | { name: string; value?: unknown }[];
}

export interface TrashCustomFormat {
  trash_id?: string;
  name: string;
  specifications?: TrashSpecification[];
}

const RESOLUTION_VALUES: Record<number, string> = { 2160: "2160p", 1080: "1080p", 720: "720p", 576: "576p", 480: "480p" };

/** The apps whose enum ordinals a format's Source, Release Type and Quality Modifier specs carry. The
 * ordinals are not shared (Radarr's Source 6 is TV, Sonarr's is Bluray), so a spec is only read when
 * the app it came from is known. */
export type TrashApp = "radarr" | "sonarr";

/** SourceSpecification value -> AoNarr source names. Radarr's Bluray is the source of a remux too
 * (a remux is Bluray with a modifier); Sonarr keeps BlurayRaw (7) apart as its remux. */
const SOURCE_VALUES: Record<TrashApp, Record<number, string[]>> = {
  radarr: { 1: ["Cam"], 2: ["Telesync"], 3: ["Telecine"], 4: ["Workprint"], 5: ["DVD"], 6: ["HDTV"], 7: ["WEBDL"], 8: ["WEBRip"], 9: ["Bluray", "Remux"] },
  sonarr: { 1: ["HDTV"], 2: ["HDTV"], 3: ["WEBDL"], 4: ["WEBRip"], 5: ["DVD"], 6: ["Bluray"], 7: ["Remux"] },
};
/** Radarr's QualityModifierSpecification: 5 is Remux, which AoNarr reads as a source. */
const QUALITY_MODIFIER_VALUES: Record<number, string> = { 1: "regional", 2: "screener", 3: "rawhd", 4: "brdisk" };
/** Sonarr's ReleaseTypeSpecification. */
const RELEASE_TYPE_VALUES: Record<number, string> = { 1: "single", 2: "multi", 3: "seasonPack" };
/** IndexerFlagSpecification is a bit flag in both apps; only the two they share and AoNarr scores. */
const INDEXER_FLAG_VALUES: Record<number, string> = { 1: "freeleech", 2: "halfleech" };

/** TRaSH sizes are in GiB (1024 cubed bytes); AoNarr's size conditions are in decimal megabytes. */
const MB_PER_GIB = 1073.741824;

function fieldMap(fields: TrashSpecification["fields"]): Record<string, unknown> {
  if (Array.isArray(fields)) {
    return Object.fromEntries(fields.filter((f) => f && typeof f.name === "string").map((f) => [f.name, f.value]));
  }
  return (fields as Record<string, unknown> | undefined) ?? {};
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One specification on its own, or null when its implementation (or value) has no portable,
 * non-Radarr/Sonarr-internal AoNarr equivalent. LanguageSpecification, SourceSpecification,
 * QualityModifierSpecification, IndexerFlagSpecification, ReleaseTypeSpecification, ... all carry
 * that app's own internal enum ordinals, which aren't safe to guess at. */
function translateSpec(spec: TrashSpecification, app: TrashApp | undefined): any | null {
  const f = fieldMap(spec.fields);
  const negate = !!spec.negate;
  switch (spec.implementation) {
    case "ReleaseTitleSpecification":
      return typeof f.value === "string" ? { type: "title", patterns: [f.value], negate } : null;
    case "ReleaseGroupSpecification":
      return typeof f.value === "string" ? { type: "releaseGroup", patterns: [f.value], negate } : null;
    case "EditionSpecification":
      return typeof f.value === "string" ? { type: "edition", patterns: [f.value], negate } : null;
    case "SizeSpecification": {
      const min = finiteNumber(f.min);
      const max = finiteNumber(f.max);
      // A size spec with no bounds at all would become an always-in-range group — worse than
      // skipping it, since an imported -10000 "too large" score would then hit every release.
      if (min === null && max === null) return null;
      return {
        type: "size",
        minMb: min !== null ? Math.round(min * MB_PER_GIB) : null,
        maxMb: max !== null ? Math.round(max * MB_PER_GIB) : null,
        negate,
      };
    }
    case "ResolutionSpecification": {
      const resolution = RESOLUTION_VALUES[finiteNumber(f.value) ?? -1];
      return resolution ? { type: "resolution", resolutions: [resolution], negate } : null;
    }
    case "SourceSpecification": {
      const sources = app ? SOURCE_VALUES[app][finiteNumber(f.value) ?? -1] : undefined;
      return sources ? { type: "source", sources, negate } : null;
    }
    case "QualityModifierSpecification": {
      const value = finiteNumber(f.value) ?? -1;
      // Only Radarr has this spec; 5 (Remux) is a source in AoNarr.
      if (app !== "radarr") return null;
      if (value === 5) return { type: "source", sources: ["Remux"], negate };
      const modifier = QUALITY_MODIFIER_VALUES[value];
      return modifier ? { type: "qualityModifier", qualityModifiers: [modifier], negate } : null;
    }
    case "ReleaseTypeSpecification": {
      const releaseType = app === "sonarr" ? RELEASE_TYPE_VALUES[finiteNumber(f.value) ?? -1] : undefined;
      return releaseType ? { type: "releaseType", releaseTypes: [releaseType], negate } : null;
    }
    case "IndexerFlagSpecification": {
      const flag = app ? INDEXER_FLAG_VALUES[finiteNumber(f.value) ?? -1] : undefined;
      return flag ? { type: "indexerFlag", indexerFlags: [flag], negate } : null;
    }
    default:
      return null;
  }
}

/** Several specs that only need ONE of them to match, as a single AoNarr condition group — only
 * possible when none is negated and they share a list-valued type (patterns/resolutions are OR'd
 * within a group already). Null when the OR can't be expressed that way. */
function mergeOr(groups: any[]): any | null {
  const type = groups[0].type;
  if (groups.some((g) => g.negate || g.type !== type)) return null;
  if (type === "title" || type === "releaseGroup" || type === "edition") {
    return { type, patterns: groups.flatMap((g) => g.patterns), negate: false };
  }
  if (type === "resolution") return { type, resolutions: [...new Set(groups.flatMap((g) => g.resolutions))], negate: false };
  if (type === "source") return { type, sources: [...new Set(groups.flatMap((g) => g.sources))], negate: false };
  if (type === "qualityModifier") return { type, qualityModifiers: [...new Set(groups.flatMap((g) => g.qualityModifiers))], negate: false };
  if (type === "releaseType") return { type, releaseTypes: [...new Set(groups.flatMap((g) => g.releaseTypes))], negate: false };
  if (type === "indexerFlag") return { type, indexerFlags: [...new Set(groups.flatMap((g) => g.indexerFlags))], negate: false };
  return null;
}

/**
 * Maps a TRaSH-Guides/Radarr/Sonarr custom-format JSON export (or a live instance's
 * /api/v3/customformat resource) to AoNarr's own condition-group shape, following Radarr/Sonarr's
 * actual matching rules: specifications are grouped by implementation; a group passes when every
 * `required` spec in it matches and at least one spec in it matches; the groups are AND'd. (A
 * format with ten non-required ReleaseGroupSpecifications means "any of these ten groups" — the
 * previous one-AoNarr-group-per-spec translation AND'd them, so multi-group tier formats never
 * matched anything.) Whatever can't be represented faithfully is reported back in `skipped` rather
 * than silently dropped or guessed at, and a caller must not store a format that has anything
 * skipped: it would match more releases than the author meant. `app` is the app the format came
 * from; Source, Release Type, Quality Modifier and Indexer Flag specs are read only when it is known. Shared by the paste-JSON import, the GitHub sync, and the
 * live Starr import, so none of them can drift on what they consider translatable.
 */
export function translateTrashFormat(trash: TrashCustomFormat, app?: TrashApp): { groups: any[]; skipped: string[] } {
  const groups: any[] = [];
  const skipped: string[] = [];

  const byImplementation = new Map<string, TrashSpecification[]>();
  for (const spec of trash.specifications ?? []) {
    const list = byImplementation.get(spec.implementation) ?? [];
    list.push(spec);
    byImplementation.set(spec.implementation, list);
  }

  for (const [implementation, specs] of byImplementation) {
    const required = specs.filter((s) => s.required);
    // With any required spec present, the non-required ones can't change the outcome (a passing
    // required spec already satisfies "at least one matches"), so only the required ones count —
    // each must hold on its own, i.e. its own AND'd group.
    const relevant = required.length > 0 ? required : specs;
    const translated = relevant.map((spec) => translateSpec(spec, app)).filter((g) => g !== null);
    if (translated.length < relevant.length) skipped.push(implementation);
    if (translated.length === 0) continue;

    if (required.length > 0 || translated.length === 1) {
      groups.push(...translated);
      continue;
    }
    const merged = mergeOr(translated);
    if (merged) groups.push(merged);
    else if (!skipped.includes(implementation)) skipped.push(implementation);
  }

  return { groups, skipped };
}
