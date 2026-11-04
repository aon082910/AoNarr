import { db } from "../db/index.js";
import { log } from "./logger.js";
import { parseQualityGroups } from "./qualityGroups.js";
import { normalizeProfileLanguage } from "./profileLanguage.js";

type TrashApp = "radarr" | "sonarr";

const PROFILE_DIR: Record<TrashApp, string> = {
  radarr: "docs/json/radarr/quality-profiles",
  sonarr: "docs/json/sonarr/quality-profiles",
};

/** One entry of a TRaSH quality profile's `items`: a quality, or a group whose `items` are quality names. */
interface TrashProfileItem {
  name: string;
  allowed?: boolean;
  items?: string[];
}

/** A TRaSH-Guides quality profile file (docs/json/<app>/quality-profiles/*.json). */
export interface TrashProfileFile {
  trash_id?: string;
  name: string;
  trash_description?: string;
  trash_score_set?: string;
  upgradeAllowed?: boolean;
  /** The name of a quality or group in `items`. */
  cutoff?: string;
  minFormatScore?: number;
  cutoffFormatScore?: number;
  minUpgradeFormatScore?: number;
  /** "Any", "Original" (Radarr: the film's own language) or a language name such as "English". */
  language?: string;
  items: TrashProfileItem[];
  /** Custom format name -> trash_id. */
  formatItems?: Record<string, string>;
}

/**
 * Quality names TRaSH uses that AoNarr keeps under another name. AoNarr's ladder has one SD tier for
 * every standard-definition source and one DVD tier for DVD and DVD-R. Raw-HD, BR-DISK and the
 * pre-release qualities (CAM, TELESYNC, ...) have no tier at all.
 */
const QUALITY_ALIASES: Record<string, string> = {
  SDTV: "SD",
  "WEBRip-480p": "SD",
  "WEBDL-480p": "SD",
  "Bluray-480p": "SD",
  "Bluray-576p": "SD",
  "DVD-R": "DVD",
};

function aonarrQuality(name: string, rankByName: Map<string, number>): string | null {
  const mapped = QUALITY_ALIASES[name] ?? name;
  return rankByName.has(mapped) ? mapped : null;
}

export interface TrashProfileScore {
  customFormatId: number;
  formatName: string;
  score: number;
}

export interface TrashProfileTranslation {
  name: string;
  allowedQualities: string[];
  unmappedQualities: string[];
  cutoff: string | null;
  qualityGroups: string[][];
  upgradeAllowed: boolean;
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  /** The fixed language the profile asks for, or null for any (see languageFromTrash). */
  language: string | null;
  /** True when TRaSH names a language AoNarr can hold: only then is an existing profile's own language replaced. */
  languageNamed: boolean;
  /** Why the profile's language is not carried over, or null. */
  languageNote: string | null;
  scoreSet: string;
  scores: TrashProfileScore[];
  /** Formats the profile lists that are not in AoNarr (never synced, or not translatable). */
  missingFormats: string[];
  /** Formats that are in AoNarr but carry no score for the chosen set (synced before scores were kept: sync again). */
  unscoredFormats: string[];
}

/**
 * TRaSH's `language` of a profile as an AoNarr profile language. "Any" is any. "Original" (the language the film was made
 * in) has no equivalent in a profile that holds one fixed language, so it is left as any, with a note. A language name
 * AoNarr knows is taken; one it does not know is left as any, with a note.
 */
export function languageFromTrash(value: unknown): { language: string | null; named: boolean; note: string | null } {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /^any$/i.test(text)) return { language: null, named: false, note: null };
  if (/^original$/i.test(text)) {
    return { language: null, named: false, note: 'TRaSH asks for the original language of each title; an AoNarr profile holds one fixed language or any, so the language is left as "any"' };
  }
  const language = normalizeProfileLanguage(text.toLowerCase());
  if (language) return { language, named: true, note: null };
  return { language: null, named: false, note: `TRaSH asks for the language "${text}", which AoNarr cannot tell from a release name; the language is left as "any"` };
}

function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

/** A format's score for a score set, falling back to the default set, or null when it has neither. */
function scoreFor(trashScores: string | null, scoreSet: string): number | null {
  if (!trashScores) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trashScores);
  } catch {
    return null;
  }
  const own = parsed[scoreSet];
  if (typeof own === "number") return own;
  const fallback = parsed.default;
  return typeof fallback === "number" ? fallback : null;
}

/**
 * Maps one TRaSH profile onto AoNarr: its allowed qualities and groups, its cutoff, its upgrade
 * settings and the score of each custom format it lists. Pure but for the format rows passed in.
 * `formats` are the synced custom formats by trash_id.
 */
export function translateTrashProfile(
  profile: TrashProfileFile,
  rankByName: Map<string, number>,
  formats: Map<string, { id: number; name: string; trash_scores: string | null }>,
  scoreSetOverride?: string
): TrashProfileTranslation {
  const allowedQualities: string[] = [];
  const unmappedQualities: string[] = [];
  const groups: string[][] = [];

  const items = Array.isArray(profile.items) ? profile.items : [];
  for (const item of items) {
    if (!item || typeof item.name !== "string") continue;
    const members = Array.isArray(item.items) ? item.items.filter((m): m is string => typeof m === "string") : [item.name];
    const mapped = [...new Set(members.map((m) => aonarrQuality(m, rankByName)).filter((m): m is string => m != null))];
    if (item.allowed) {
      allowedQualities.push(...mapped);
      for (const member of members) if (aonarrQuality(member, rankByName) == null) unmappedQualities.push(member);
      if (Array.isArray(item.items)) groups.push(mapped);
    }
  }
  const allowed = [...new Set(allowedQualities)];

  // The cutoff names a quality or a group. A group is met by any of its members, so it is the group's
  // lowest-ranked mapped member; with nothing mappable the best allowed quality stands in.
  let cutoff: string | null = null;
  const cutoffItem = items.find((i) => i?.name === profile.cutoff);
  if (cutoffItem) {
    const members = Array.isArray(cutoffItem.items) ? cutoffItem.items : [cutoffItem.name];
    const candidates = members.map((m) => aonarrQuality(m, rankByName)).filter((m): m is string => m != null && allowed.includes(m));
    if (candidates.length > 0) cutoff = candidates.reduce((low, n) => (rankByName.get(n)! < rankByName.get(low)! ? n : low));
  }
  if (!cutoff && allowed.length > 0) cutoff = allowed.reduce((best, n) => (rankByName.get(n)! > rankByName.get(best)! ? n : best));

  const wantedLanguage = languageFromTrash(profile.language);
  const scoreSet = scoreSetOverride || (typeof profile.trash_score_set === "string" && profile.trash_score_set ? profile.trash_score_set : "default");
  const scores: TrashProfileScore[] = [];
  const missingFormats: string[] = [];
  const unscoredFormats: string[] = [];
  for (const [formatName, trashId] of Object.entries(profile.formatItems ?? {})) {
    const format = formats.get(String(trashId));
    if (!format) {
      missingFormats.push(formatName);
      continue;
    }
    const score = scoreFor(format.trash_scores, scoreSet);
    if (score == null) {
      unscoredFormats.push(formatName);
      continue;
    }
    scores.push({ customFormatId: format.id, formatName: format.name, score });
  }

  return {
    name: String(profile.name ?? "").trim(),
    allowedQualities: allowed,
    unmappedQualities: [...new Set(unmappedQualities)],
    cutoff,
    qualityGroups: parseQualityGroups(groups),
    upgradeAllowed: profile.upgradeAllowed !== false,
    minFormatScore: wholeNumber(profile.minFormatScore, 0),
    cutoffFormatScore: wholeNumber(profile.cutoffFormatScore, 0),
    minUpgradeFormatScore: wholeNumber(profile.minUpgradeFormatScore, 1),
    language: wantedLanguage.language,
    languageNamed: wantedLanguage.named,
    languageNote: wantedLanguage.note,
    scoreSet,
    scores,
    missingFormats,
    unscoredFormats,
  };
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "AoNarr" } });
  if (!res.ok) throw new Error(`GitHub request failed: HTTP ${res.status}`);
  return res.json();
}

export interface TrashProfileListing {
  file: string;
  name: string;
  description: string | null;
  scoreSet: string;
}

function isTrashApp(app: unknown): app is TrashApp {
  return app === "radarr" || app === "sonarr";
}

/** The quality profiles TRaSH-Guides publishes for an app, read from its public GitHub repository. */
export async function listTrashProfiles(app: TrashApp): Promise<TrashProfileListing[]> {
  if (!isTrashApp(app)) throw new Error("app must be radarr or sonarr");
  const entries = (await fetchJson(`https://api.github.com/repos/TRaSH-Guides/Guides/contents/${PROFILE_DIR[app]}`)) as {
    name: string;
    download_url: string;
    type: string;
  }[];
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
  const listing: TrashProfileListing[] = [];
  // Eight at a time, like the format sync: polite to the host, quick enough for a dozen small files.
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      try {
        const body = (await fetchJson(file.download_url)) as TrashProfileFile;
        if (typeof body?.name !== "string" || !Array.isArray(body.items)) continue;
        listing.push({
          file: file.name,
          name: body.name,
          description: typeof body.trash_description === "string" ? body.trash_description.replace(/<br\s*\/?>/gi, " ") : null,
          scoreSet: typeof body.trash_score_set === "string" && body.trash_score_set ? body.trash_score_set : "default",
        });
      } catch (err) {
        log.warn(`[trashProfiles] could not read ${file.name}: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  return listing.sort((a, b) => a.name.localeCompare(b.name));
}

export interface TrashProfileImportResult extends Omit<TrashProfileTranslation, "scores"> {
  profileId: number;
  created: boolean;
  scoresApplied: number;
}

/**
 * Creates the AoNarr quality profile for a TRaSH profile, or updates the one with the same name, and
 * sets the score of every custom format the profile lists that has been synced. A score for a format
 * the profile does not list is left alone. `file` is a file name from `listTrashProfiles`.
 */
export async function importTrashProfile(app: TrashApp, file: string, options: { scoreSet?: string } = {}): Promise<TrashProfileImportResult> {
  if (!isTrashApp(app)) throw new Error("app must be radarr or sonarr");
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file)) throw new Error("file must be the name of a TRaSH profile file");
  const profile = (await fetchJson(`https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/${PROFILE_DIR[app]}/${file}`)) as TrashProfileFile;
  if (typeof profile?.name !== "string" || !profile.name.trim() || !Array.isArray(profile.items)) {
    throw new Error("That file is not a TRaSH-Guides quality profile");
  }

  const qualityRows = (await db.prepare("SELECT name, rank FROM qualities").all()) as { name: string; rank: number }[];
  const rankByName = new Map(qualityRows.map((q) => [q.name, Number(q.rank)]));
  const formatRows = (await db.prepare("SELECT id, name, trash_id, trash_scores FROM custom_formats WHERE trash_id IS NOT NULL").all()) as {
    id: number;
    name: string;
    trash_id: string;
    trash_scores: string | null;
  }[];
  const formats = new Map(formatRows.map((f) => [f.trash_id, f]));

  const t = translateTrashProfile(profile, rankByName, formats, options.scoreSet);
  if (t.allowedQualities.length === 0 || !t.cutoff) {
    throw new Error("None of this profile's qualities have an AoNarr equivalent");
  }

  let profileId = 0;
  let created = false;
  await db.transaction(async () => {
    const existing = (await db.prepare("SELECT id FROM quality_profiles WHERE name = ?").get(t.name)) as { id: number } | undefined;
    const values = [
      JSON.stringify(t.allowedQualities),
      t.cutoff,
      t.minFormatScore,
      t.upgradeAllowed ? 1 : 0,
      t.cutoffFormatScore,
      t.minUpgradeFormatScore,
      JSON.stringify(t.qualityGroups),
    ];
    if (existing) {
      profileId = Number(existing.id);
      await db
        .prepare(
          `UPDATE quality_profiles SET allowed_qualities = ?, cutoff = ?, min_format_score = ?, prefer_cutoff_quality = 0, upgrade_allowed = ?,
             cutoff_format_score = ?, min_upgrade_format_score = ?, quality_groups = ? WHERE id = ?`
        )
        .run(...values, profileId);
      // A language TRaSH names replaces the profile's; "Any" and "Original" leave the admin's own choice alone.
      if (t.languageNamed) await db.prepare("UPDATE quality_profiles SET language = ? WHERE id = ?").run(t.language, profileId);
    } else {
      created = true;
      // prefer_cutoff_quality is 0: the cutoff only stops upgrading, as in Radarr and Sonarr.
      const result = await db
        .prepare(
          `INSERT INTO quality_profiles (name, allowed_qualities, cutoff, min_format_score, prefer_cutoff_quality, upgrade_allowed, cutoff_format_score, min_upgrade_format_score, quality_groups, language)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
        )
        .run(t.name, ...values, t.language);
      profileId = Number(result.lastInsertRowid);
    }
    for (const s of t.scores) {
      await db
        .prepare(
          `INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, ?)
           ON CONFLICT(quality_profile_id, custom_format_id) DO UPDATE SET score = excluded.score`
        )
        .run(profileId, s.customFormatId, s.score);
    }
  });

  const { scores, ...rest } = t;
  log.info(`[trashProfiles] ${created ? "created" : "updated"} profile "${t.name}" from TRaSH ${app}/${file}: ${scores.length} score(s), ${t.missingFormats.length} format(s) not synced`);
  return { ...rest, profileId, created, scoresApplied: scores.length };
}
