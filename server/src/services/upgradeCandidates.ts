import { db } from "../db/index.js";
import { qualityRank } from "./quality.js";

export interface UpgradeCandidate {
  mediaItemId: number;
  episodeId?: number;
  subItemId?: number;
  target: string;
  currentQuality: string;
  cutoff: string;
  profileName: string;
}

interface ProfileInfo {
  cutoff: string;
  name: string;
}

async function loadProfiles(): Promise<Map<number, ProfileInfo>> {
  const rows = (await db.prepare("SELECT id, name, cutoff FROM quality_profiles").all()) as {
    id: number;
    name: string;
    cutoff: string;
  }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, cutoff: r.cutoff }]));
}

/** Only a file whose quality this instance actually ranks can be "below cutoff". An unranked one
 * — a quality tier since deleted, or a grab recorded as ''/"Unknown" (yt-dlp, RSS, most book and
 * music releases) — used to compare as -1, i.e. below every cutoff: auto-upgrade then swapped
 * files of a deleted tier for whatever the profile now allows, and re-searched every unranked file
 * on every run forever. */
function belowCutoff(quality: string, cutoff: string): boolean {
  const current = qualityRank(quality);
  return current >= 0 && current < qualityRank(cutoff);
}

/**
 * Downloaded files never get revisited once imported — if an admin later raises a quality
 * profile's cutoff, everything already downloaded under the old (lower) cutoff just stays as-is
 * forever unless someone remembers to check. This surfaces anything currently below its current
 * profile's cutoff so it can be manually re-searched for an upgrade. Monitored rows only (a movie,
 * or an episode/sub-item AND its parent) — unmonitoring is how an admin says "leave this file
 * alone", and auto-upgrade used to replace unmonitored files anyway.
 */
export async function findUpgradeCandidates(): Promise<UpgradeCandidate[]> {
  const profiles = await loadProfiles();
  const candidates: UpgradeCandidate[] = [];

  const movies = (await db
    .prepare("SELECT id, title, quality, quality_profile_id FROM media_items WHERE has_file = 1 AND monitored = 1 AND quality IS NOT NULL")
    .all()) as { id: number; title: string; quality: string; quality_profile_id: number | null }[];
  for (const m of movies) {
    const profile = m.quality_profile_id ? profiles.get(m.quality_profile_id) : undefined;
    if (!profile) continue;
    if (belowCutoff(m.quality, profile.cutoff)) {
      candidates.push({ mediaItemId: m.id, target: m.title, currentQuality: m.quality, cutoff: profile.cutoff, profileName: profile.name });
    }
  }

  const episodes = (await db
    .prepare(
      `SELECT e.id, e.season_number, e.episode_number, e.quality, m.id AS "mediaItemId", m.title, m.quality_profile_id
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND e.monitored = 1 AND m.monitored = 1 AND e.quality IS NOT NULL`
    )
    .all()) as {
    id: number;
    season_number: number;
    episode_number: number;
    quality: string;
    mediaItemId: number;
    title: string;
    quality_profile_id: number | null;
  }[];
  for (const e of episodes) {
    const profile = e.quality_profile_id ? profiles.get(e.quality_profile_id) : undefined;
    if (!profile) continue;
    if (belowCutoff(e.quality, profile.cutoff)) {
      candidates.push({
        mediaItemId: e.mediaItemId,
        episodeId: e.id,
        target: `${e.title} S${String(e.season_number).padStart(2, "0")}E${String(e.episode_number).padStart(2, "0")}`,
        currentQuality: e.quality,
        cutoff: profile.cutoff,
        profileName: profile.name,
      });
    }
  }

  const subItems = (await db
    .prepare(
      `SELECT s.id, s.title AS "subTitle", s.quality, m.id AS "mediaItemId", m.title, m.quality_profile_id
       FROM sub_items s JOIN media_items m ON m.id = s.media_item_id
       WHERE s.has_file = 1 AND s.monitored = 1 AND m.monitored = 1 AND s.quality IS NOT NULL`
    )
    .all()) as {
    id: number;
    subTitle: string;
    quality: string;
    mediaItemId: number;
    title: string;
    quality_profile_id: number | null;
  }[];
  for (const s of subItems) {
    const profile = s.quality_profile_id ? profiles.get(s.quality_profile_id) : undefined;
    if (!profile) continue;
    if (belowCutoff(s.quality, profile.cutoff)) {
      candidates.push({
        mediaItemId: s.mediaItemId,
        subItemId: s.id,
        target: `${s.title} - ${s.subTitle}`,
        currentQuality: s.quality,
        cutoff: profile.cutoff,
        profileName: profile.name,
      });
    }
  }

  return candidates;
}
