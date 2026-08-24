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

/**
 * Downloaded files never get revisited once imported — if an admin later raises a quality
 * profile's cutoff, everything already downloaded under the old (lower) cutoff just stays as-is
 * forever unless someone remembers to check. This surfaces anything currently below its current
 * profile's cutoff so it can be manually re-searched for an upgrade.
 */
export async function findUpgradeCandidates(): Promise<UpgradeCandidate[]> {
  const profiles = await loadProfiles();
  const candidates: UpgradeCandidate[] = [];

  const movies = (await db
    .prepare("SELECT id, title, quality, quality_profile_id FROM media_items WHERE has_file = 1 AND quality IS NOT NULL")
    .all()) as { id: number; title: string; quality: string; quality_profile_id: number | null }[];
  for (const m of movies) {
    const profile = m.quality_profile_id ? profiles.get(m.quality_profile_id) : undefined;
    if (!profile) continue;
    if (qualityRank(m.quality) < qualityRank(profile.cutoff)) {
      candidates.push({ mediaItemId: m.id, target: m.title, currentQuality: m.quality, cutoff: profile.cutoff, profileName: profile.name });
    }
  }

  const episodes = (await db
    .prepare(
      `SELECT e.id, e.season_number, e.episode_number, e.quality, m.id AS "mediaItemId", m.title, m.quality_profile_id
       FROM episodes e JOIN media_items m ON m.id = e.media_item_id
       WHERE e.has_file = 1 AND e.quality IS NOT NULL`
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
    if (qualityRank(e.quality) < qualityRank(profile.cutoff)) {
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
       WHERE s.has_file = 1 AND s.quality IS NOT NULL`
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
    if (qualityRank(s.quality) < qualityRank(profile.cutoff)) {
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
