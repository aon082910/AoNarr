export interface TrashSpecification {
  implementation: string;
  negate?: boolean;
  fields?: { value?: string | number; min?: number; max?: number };
}

export interface TrashCustomFormat {
  trash_id?: string;
  name: string;
  specifications?: TrashSpecification[];
}

const RESOLUTION_VALUES: Record<number, string> = { 2160: "2160p", 1080: "1080p", 720: "720p" };

/**
 * Maps a TRaSH-Guides/Radarr/Sonarr custom-format JSON export to AoNarr's own condition-group
 * shape. Only specifications with a portable, non-Radarr/Sonarr-internal representation translate:
 * ReleaseTitleSpecification, ReleaseGroupSpecification, SizeSpecification, and
 * ResolutionSpecification (its numeric `value` is a plain pixel height, not an internal id, so it's
 * safe to map). Everything else (QualityModifierSpecification, LanguageSpecification,
 * IndexerFlagSpecification, SourceSpecification, ...) references Radarr/Sonarr's own internal
 * enums/ids that don't correspond to anything in AoNarr's model, so it's reported back as skipped
 * rather than silently dropped or guessed at — a format missing a condition would otherwise match
 * more releases than TRaSH intended. Shared by both the paste-JSON import and the GitHub sync, so
 * the two paths can never drift on what they consider translatable.
 */
export function translateTrashFormat(trash: TrashCustomFormat): { groups: any[]; skipped: string[] } {
  const groups: any[] = [];
  const skipped: string[] = [];

  for (const spec of trash.specifications ?? []) {
    if (spec.implementation === "ReleaseTitleSpecification" && typeof spec.fields?.value === "string") {
      groups.push({ type: "title", patterns: [spec.fields.value], negate: !!spec.negate });
    } else if (spec.implementation === "ReleaseGroupSpecification" && typeof spec.fields?.value === "string") {
      groups.push({ type: "releaseGroup", patterns: [spec.fields.value], negate: !!spec.negate });
    } else if (spec.implementation === "SizeSpecification") {
      groups.push({
        type: "size",
        minMb: spec.fields?.min != null ? spec.fields.min * 1000 : null,
        maxMb: spec.fields?.max != null ? spec.fields.max * 1000 : null,
        negate: !!spec.negate,
      });
    } else if (spec.implementation === "ResolutionSpecification" && typeof spec.fields?.value === "number" && RESOLUTION_VALUES[spec.fields.value]) {
      groups.push({ type: "resolution", resolutions: [RESOLUTION_VALUES[spec.fields.value]], negate: !!spec.negate });
    } else {
      skipped.push(spec.implementation);
    }
  }

  return { groups, skipped };
}
