import { db } from "../db/index.js";
import { scoreRelease } from "./customFormatScoring.js";
import { usesQualityTiers } from "./quality.js";
import type { ExistingFile } from "./upgradeRules.js";

/**
 * What a file on disk remembers of the release it came from: the release's title (its group and revision are
 * read from it later, to tell whether a REPACK is the group's own) and the custom-format score it had when
 * imported (what a format cutoff compares). Written on the media item, episode or sub-item row at import, and
 * cleared when a file arrives with no known release (a manual import).
 */

/** The title and score to store for a file just imported from `releaseTitle`. */
export async function releaseRecordFor(
  item: { id: number; type: string; qualityProfileId: number | null },
  releaseTitle: string | undefined | null,
  sizeBytes: number | null
): Promise<{ title: string | null; score: number | null }> {
  if (!releaseTitle) return { title: null, score: null };
  if (!usesQualityTiers(item.type) || !item.qualityProfileId) return { title: releaseTitle, score: null };
  try {
    const { totalScore } = await scoreRelease(releaseTitle, sizeBytes && sizeBytes > 0 ? sizeBytes : null, item.qualityProfileId, item.type, null, item.id);
    return { title: releaseTitle, score: totalScore };
  } catch {
    return { title: releaseTitle, score: null };
  }
}

/** The file a target has, in the shape the upgrade rules read; undefined when it has none. */
export async function existingFileRecord(
  item: { id: number; hasFile?: unknown; quality?: string | null },
  episodeId: number | null,
  subItemId: number | null
): Promise<ExistingFile | undefined> {
  const row = (
    episodeId
      ? await db.prepare("SELECT has_file, quality, file_release_title, file_format_score FROM episodes WHERE id = ?").get(episodeId)
      : subItemId
      ? await db.prepare("SELECT has_file, quality, file_release_title, file_format_score FROM sub_items WHERE id = ?").get(subItemId)
      : await db.prepare("SELECT has_file, quality, file_release_title, file_format_score FROM media_items WHERE id = ?").get(item.id)
  ) as { has_file: number | boolean | null; quality: string | null; file_release_title: string | null; file_format_score: number | string | null } | undefined;
  if (!row || !Number(row.has_file)) return undefined;
  return {
    quality: row.quality ?? null,
    releaseTitle: row.file_release_title ?? null,
    formatScore: row.file_format_score == null ? null : Number(row.file_format_score),
  };
}
