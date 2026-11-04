import { log } from "./logger.js";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { decryptIfSet, mediaItemFromRow, queueItemFromRow, rootFolderFromRow } from "../db/mappers.js";
import { notifyImported, notifyManualInteractionRequired, notifyRenamed, notifyUpgraded } from "./notifications.js";
import { writeEpisodeNfoSidecar, writeNfoSidecar, writeTvShowNfoIfMissing } from "./metadataExport.js";
import { writeAudioTags } from "./audioTagWriter.js";
import { notifyQueueChanged } from "./realtime.js";
import { isDiscographyTitle, parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode } from "./releaseParser.js";
import { identityKey, identityModeFor, releaseIdentifiesTarget, type IdentityTarget } from "./releaseIdentity.js";
import { identityTargetFor } from "./releaseAliases.js";
import type { ParsedRelease, SceneIndex } from "./releaseParser.js";
import { sceneIndexFor } from "./sceneNumbering.js";
import {
  downloadSubtitleContent,
  downloadSubtitleFromUrl,
  pickBestSubtitle,
  pickBestSubtitleForLanguage,
  searchCustomSubtitles,
  searchSubtitles,
  type CustomSubtitleProviderConfig,
} from "./subtitleClient.js";
import { archiveDestinationFor, isArchiveFile, unpackDownloadedArchives } from "./archiveExtract.js";
import { markDownloadImported, removeQueueItemDownload } from "./downloadClient.js";
import { categoryForType } from "./clientCategory.js";
import { parseCategoryByType } from "../db/mappers.js";
import { queueHistoryFields } from "./queueHistory.js";
import { syncSubtitleToVideo } from "./subtitleSync.js";
import { DEFAULT_SHAPE_TEMPLATES, DEFAULT_TRACK_TEMPLATE, episodeLabel, multiEpisodeStyleOf, ownFolderDepth, providerIdVars, releaseVars, renderTemplate, titleVars } from "./naming.js";
import { rememberItemFolder, withItemFolder } from "./libraryFolder.js";
import { trackedFileInside } from "./fileDeletion.js";
import { importReserveBytes } from "./freeSpace.js";
import { findRejectedFile, probeVerdict } from "./importChecks.js";
import { applyFileDate } from "./fileDate.js";
import { copyReleaseExtras } from "./importExtras.js";
import { effectiveShape, getMediaTypeConfig, isProbeableFile, type MediaShape } from "./mediaTypes.js";
import { groupedRank, parseQualityGroups, usesQualityTiers, type QualityGroups } from "./quality.js";
import { romSetCompanions } from "./romSets.js";
import { releaseRecordFor } from "./fileRelease.js";
import { propersMode, revisionUpgrade } from "./upgradeRules.js";
import { getSetting } from "./settingsStore.js";
import { probeMediaInfo } from "./ffprobe.js";
import { recordGroupSuccess } from "./releaseGroupStats.js";
import { detectSeasonEpisode, guessTitleFromText } from "./libraryScan.js";
import { convertComicImagesBestEffort } from "./comicImageConvert.js";
import { recycleFile } from "./recycleBin.js";
import { MAX_NAME_BYTES, truncateToBytes } from "./pathNames.js";
import { finishBackgroundJob, incrementBackgroundJobDone, isBackgroundJobRunning, startBackgroundJob } from "./backgroundJobs.js";
import { FS_CALL_TIMEOUT_MS, guardedFsCall, statAsync, statfsAsync } from "./fsAsync.js";
import { rootFolderUnmountedReason } from "./rootFolderCheck.js";
import { isTitleMoving } from "./titleMoveLock.js";
import { discographyAlbumsOf, queueTargetIds } from "./discography.js";
import { matchAlbumFolders } from "./discographyMatch.js";
import { addToBlocklist } from "./blocklist.js";
import { wakeLeaf } from "./searchBackoff.js";
import type { MediaType } from "../types/index.js";

// Shared across every "single"/"episodic" video library (Movies, TV Shows, Anime) so a just-moved
// file can be recognized as subtitle-eligible without hardcoding a type list.
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"]);

/** Absolute (AniDB/TVDB-absolute-order-style) episode number for a season/episode pair, counting
 * from season 1 episode 1 (season 0 specials excluded — absolute numbering conventions don't
 * count them). Counted from the episodes table unless the row stores its own number (a sequel's rows do, anilistSeasons.ts), because
 * `episodes.absolute_episode_number` is only ever populated by one of the many code paths that can
 * insert an episode row (see /metadata/import) — every other insert path (Trakt/Plex/watchlist
 * sync, import lists, library scan, a manual add, ...) leaves it NULL. */
export async function computeAbsoluteEpisodeNumber(mediaItemId: number, seasonNumber: number, episodeNumber: number): Promise<number> {
  // The scene's running number wins where TheXEM gives one (releases are named by it, as Sonarr's scene-numbered
  // shows are); then a number stored on the row (a sequel's rows carry the show's running number, see
  // anilistSeasons.ts); an episode with neither is counted.
  const stored = (await db
    .prepare("SELECT absolute_episode_number, scene_absolute_number FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
    .get(mediaItemId, seasonNumber, episodeNumber)) as { absolute_episode_number: number | null; scene_absolute_number: number | null } | undefined;
  if (stored?.scene_absolute_number != null) return Number(stored.scene_absolute_number);
  if (stored?.absolute_episode_number != null) return Number(stored.absolute_episode_number);
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
       AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
    )
    .get(mediaItemId, seasonNumber, seasonNumber, episodeNumber)) as { c: number };
  return Number(row.c);
}

/** OpenSubtitles names languages by two-letter code ("en", "pt-BR") in both its filter and its
 * results. A provider set to the three-letter codes AoNarr's own settings default to ("eng")
 * searched a language OpenSubtitles doesn't have and never picked a result. */
const OPENSUBTITLES_LANGUAGES: Record<string, string> = {
  eng: "en", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es", ita: "it", por: "pt-PT", pt: "pt-PT",
  "pt-pt": "pt-PT", pob: "pt-BR", pb: "pt-BR", "pt-br": "pt-BR", dut: "nl", nld: "nl", swe: "sv", nor: "no",
  nob: "no", dan: "da", fin: "fi", pol: "pl", rus: "ru", ukr: "uk", cze: "cs", ces: "cs", slo: "sk", slk: "sk",
  hun: "hu", rum: "ro", ron: "ro", bul: "bg", gre: "el", ell: "el", tur: "tr", ara: "ar", heb: "he", per: "fa",
  fas: "fa", hin: "hi", jpn: "ja", kor: "ko", chi: "zh-CN", zho: "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW",
  tha: "th", vie: "vi", ind: "id", may: "ms", msa: "ms", hrv: "hr", srp: "sr", slv: "sl", est: "et", lav: "lv",
  lit: "lt", ice: "is", isl: "is", cat: "ca", baq: "eu", eus: "eu", glg: "gl", ben: "bn", tam: "ta", tel: "te",
  urd: "ur", alb: "sq", sqi: "sq", mac: "mk", mkd: "mk", bos: "bs", geo: "ka", kat: "ka", arm: "hy", hye: "hy",
};

function openSubtitlesLanguage(language: string): string {
  return OPENSUBTITLES_LANGUAGES[language.trim().toLowerCase()] ?? language;
}

/**
 * Downloads a subtitle for one specific language next to a video file — the unit both the
 * at-import path and the background rescan job (services/subtitleRescan.js) operate on.
 * `skipExisting` short-circuits before ever searching when a sidecar for this language is already
 * on disk, which is what makes the rescan job idempotent (safe to re-run against the whole
 * library on a schedule without re-fetching everything every time).
 */
export async function downloadSubtitleForLanguage(
  videoPath: string,
  mediaItemId: number,
  language: string,
  provider: { type: string; api_key: string | null; languages: string; config: string | null },
  skipExisting: boolean
): Promise<boolean> {
  const srtPath = videoPath.slice(0, -path.extname(videoPath).length) + `.${language}.srt`;
  if (skipExisting && fs.existsSync(srtPath)) return false;

  const isCustom = provider.type === "custom";
  const parsedConfig = provider.config ? JSON.parse(provider.config) : {};
  const searchLanguage = isCustom ? language : openSubtitlesLanguage(language);
  const results = isCustom
    ? await searchCustomSubtitles(parsedConfig as CustomSubtitleProviderConfig, provider.api_key, path.basename(videoPath), language)
    : await searchSubtitles(provider.api_key!, path.basename(videoPath), searchLanguage, {
        hearingImpaired: parsedConfig.hearingImpaired,
        foreignPartsOnly: parsedConfig.foreignPartsOnly,
      });
  // A custom provider with no languageField configured tags every result "unknown" (see
  // subtitleClient.ts's searchCustomSubtitles) rather than the language actually requested —
  // match on that too so such providers still work, just without real per-language distinction.
  const wantedLanguages = new Set([language.toLowerCase(), searchLanguage.toLowerCase()]);
  const best = pickBestSubtitle(results.filter((r) => wantedLanguages.has(String(r.language ?? "").toLowerCase()))) ??pickBestSubtitleForLanguage(results, "unknown");
  if (!best) return false;

  const content = isCustom ? await downloadSubtitleFromUrl(best.downloadUrl) : await downloadSubtitleContent(provider.api_key!, best.fileId!);
  fs.writeFileSync(srtPath, content, "utf-8");

  // An exact moviehash match means OpenSubtitles matched this subtitle to this precise file —
  // its timing is already trustworthy, so syncing would just spend the ffsubsync pass (30s-2min)
  // for no benefit. Anything else (a fuzzy title match, or any "custom" provider result, which
  // carries no confidence signal at all) gets synced, same as Bazarr's own "below-threshold"
  // default behavior.
  let synced = false;
  if (getSetting("subtitleSyncEnabled") !== "0" && !best.movieHashMatch) {
    synced = await syncSubtitleToVideo(videoPath, srtPath);
  }

  await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'subtitleDownloaded', ?)`).run(
    mediaItemId,
    JSON.stringify({ srtPath, language, synced })
  );
  log.info(`[subtitles] downloaded "${language}" subtitle for "${path.basename(videoPath)}"${synced ? " (synced)" : ""}`);
  return true;
}

/** Best-effort: finds and saves a subtitle in every configured language next to a just-imported
 * video file. Never throws — a subtitle miss shouldn't fail the import itself. */
async function tryDownloadSubtitle(videoPath: string, mediaItemId: number): Promise<void> {
  const provider = (await db.prepare("SELECT * FROM subtitle_providers WHERE enabled = 1 LIMIT 1").get()) as
    | { type: string; api_key: string | null; languages: string; config: string | null }
    | undefined;
  if (!provider) return;
  provider.api_key = decryptIfSet(provider.api_key);
  if (provider.type !== "custom" && !provider.api_key) return;

  const languages = provider.languages
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const language of languages) {
    try {
      await downloadSubtitleForLanguage(videoPath, mediaItemId, language, provider, false);
    } catch (err) {
      log.warn(`[importer] "${language}" subtitle download failed for "${videoPath}":`, (err as Error).message);
    }
  }
}

/** Radarr-style colon handling: "Title: Subtitle" becomes "Title - Subtitle" instead of just
 * dropping the colon outright ("TitleSubtitle"), which reads badly and is the #1 complaint about
 * naive illegal-character stripping. Every other Windows/most-filesystems-illegal character is
 * still stripped outright — none of them have as good a plain-text substitute. */
function sanitizeForPath(name: string): string {
  // `namingColonReplacement`: what a colon in a title becomes. The default is the " - " AoNarr always used.
  const colon = getSetting("namingColonReplacement");
  const colonless =
    colon === "delete"
      ? name.replace(/:/g, "")
      : colon === "dash"
        ? name.replace(/:/g, "-")
        : colon === "spaceDash"
          ? name.replace(/:/g, " -")
          : colon === "smart"
            ? name.replace(/:\s+/g, " - ").replace(/:/g, "-")
            : name.replace(/:\s*/g, " - ");
  // `namingReplaceIllegalChars` = "0": keep * ? " < > | (a Linux file system takes them); a separator never stays.
  const illegal = getSetting("namingReplaceIllegalChars") === "0" ? /[/\\]/g : /[/\\*?"<>|]/g;
  return colonless.replace(illegal, "").trim();
}

/** One path segment that can never add, remove or climb a directory level: one that sanitizes to
 * nothing, "." or ".." becomes "_" instead (an album titled "?" otherwise vanished, dropping its
 * tracks loose into the artist folder). What a template leaves behind when a value is empty is
 * cleaned up too: an empty "()" or "[]" (a movie with no year), doubled spaces, a trailing " -" or
 * "_" (an episode with no title yet), and leading dots (a ".hack" folder is hidden on Linux and
 * Samba). A trailing dot is cut from a file name only: a show folder already on disk may end in
 * one ("S.H.I.E.L.D."), and dropping it from the folder name would split the show across two. */
function safePathSegment(name: string, isFileName = false): string {
  // Never longer than a name can be, whatever built it (a track title, a disc folder): renderSegmentWithin
  // shortens the free-text values first, so the cut here only ever trims what is left.
  return placeholderIfEmpty(cleanPathSegment(truncateToBytes(cleanPathSegment(name, isFileName), MAX_NAME_BYTES - (isFileName ? DEFAULT_EXTENSION_RESERVE : 0)), isFileName));
}

/** The clean-up of safePathSegment without the length limit or the placeholder; may return "". */
function cleanPathSegment(name: string, isFileName: boolean): string {
  return sanitizeForPath(name)
    .replace(/\s*(?:\(\s*\)|\[\s*\]|\{\s*\})/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.]+/, "")
    .replace(isFileName ? /[\s.\-_]+$/ : /[\s\-_]+$/, "");
}

function placeholderIfEmpty(segment: string): string {
  return segment === "" || segment === "." || segment === ".." ? "_" : segment;
}

/** Bytes kept free for the extension when a caller doesn't say what it will be. */
const DEFAULT_EXTENSION_RESERVE = 10;
/** The free-text values a name is shortened by when it doesn't fit, the one most likely to be
 * long and least needed to identify the file first. */
const SHORTENABLE_VARS = ["episodeTitle", "trackTitle", "childTitle", "title", "parentTitle"] as const;

/** One rendered path segment that fits `maxBytes`: when it doesn't, the longest free-text value it
 * holds (an episode title before the show's title) is shortened with "..." until it does. */
function renderSegmentWithin(part: string, vars: Record<string, string | number>, maxBytes: number, isFileName: boolean): string {
  const values = { ...vars };
  let rendered = cleanPathSegment(renderTemplate(part, values), isFileName);
  for (let guard = 0; guard < 64 && Buffer.byteLength(rendered) > maxBytes; guard++) {
    const key = SHORTENABLE_VARS.find((k) => typeof values[k] === "string" && part.includes(`{${k}`) && Buffer.byteLength(values[k] as string) > 16);
    if (!key) break;
    const value = values[key] as string;
    const excess = Buffer.byteLength(rendered) - maxBytes;
    values[key] = `${truncateToBytes(value.replace(/\.{3}$/, ""), Math.max(12, Buffer.byteLength(value) - excess - 3)).trimEnd()}...`;
    if (Buffer.byteLength(values[key] as string) >= Buffer.byteLength(value)) break;
    rendered = cleanPathSegment(renderTemplate(part, values), isFileName);
  }
  // Nothing left to shorten (a long literal in the template): cut the name itself.
  return placeholderIfEmpty(Buffer.byteLength(rendered) > maxBytes ? cleanPathSegment(truncateToBytes(rendered, maxBytes), isFileName) : rendered);
}

/** Slashes inside a title are part of the name, not folder separators: "Face/Off" otherwise
 * landed in "Face/Off (1997)/" and "AC/DC" under an "AC" artist folder, and a title holding "../"
 * could climb out of the root folder. Only the template's own "/" creates folders. */
function pathSafeVars(vars: Record<string, string | number>): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vars)) safe[key] = typeof value === "string" ? value.replace(/[/\\]/g, "-") : value;
  return safe;
}

/** Renders a naming template into sanitized path segments — the template's own "/" controls
 * folder nesting; a level the template itself leaves empty ("a//b", a leading "/") is dropped. */
function renderPathSegments(template: string, vars: Record<string, string | number>, extension = ""): string[] {
  const safeVars = pathSafeVars(vars);
  const parts = template.split("/").filter((part) => part.trim() !== "");
  return parts.map((part, index) => {
    const isLast = index === parts.length - 1;
    // The last segment is the file name: the extension is added to it after rendering.
    const reserve = isLast ? (extension ? Buffer.byteLength(extension) : DEFAULT_EXTENSION_RESERVE) : 0;
    return renderSegmentWithin(part, safeVars, MAX_NAME_BYTES - reserve, isLast);
  });
}

/** The folder a season goes in the way Sonarr names it: "Season 01", "Specials" for season 0 ({seasonFolder}). */
function seasonFolderName(season: number): string {
  return season === 0 ? "Specials" : `Season ${String(season).padStart(2, "0")}`;
}

/** What a template may use for the file of one or more episodes of a season. */
function episodicNameVars(
  item: { type: string; title: string; year: number | null; externalIds: string | null },
  e: { season: number; numbers: number[]; absoluteEpisode: number; airDate: string | null; episodeTitle: string | null; quality: string | null; releaseTitle?: string | null }
): Record<string, string | number> {
  return {
    parentTitle: item.title,
    season: e.season,
    // A plain number for the (overwhelmingly common) single-episode case; for a file that covers several a
    // formatted string (`namingMultiEpisodeStyle`), which {episode:00} renders as it is.
    episode: episodeLabel(e.numbers, multiEpisodeStyleOf(getSetting("namingMultiEpisodeStyle"))),
    absoluteEpisode: e.absoluteEpisode,
    airDate: e.airDate ?? "",
    episodeTitle: e.episodeTitle ?? "",
    year: item.year ?? "",
    quality: e.quality ?? "",
    seasonFolder: seasonFolderName(e.season),
    ...titleVars("parent", item.title, item.year),
    ...releaseVars(e.releaseTitle, e.quality),
    ...providerIdVars(item),
  };
}

/**
 * An automatic import's checks of the file itself (importChecks.ts): a program or script in the download's folder, a
 * video far shorter than the title runs, or one with no audio. Throws ImportSkippedError, so the download stays for a
 * manual import. `checkFolder` is false for a pack, whose folder is judged once for all of it.
 */
async function assertFileIsWorthImporting(sourceFile: string, mediaType: string, expectedMinutes: number | null, ctx: DownloadContext, probe: boolean, checkFolder = true): Promise<void> {
  const dir = path.dirname(sourceFile);
  if (checkFolder && isOwnReleaseFolder(dir, ctx)) {
    const bad = findRejectedFile(dir, mediaType);
    if (bad) throw new ImportSkippedError(`Not importing: the download holds "${path.basename(bad)}", a file type that is rejected — left in the download for a manual import`);
  }
  if (probe && VIDEO_EXTENSIONS.has(path.extname(sourceFile).toLowerCase()) && isProbeableFile(sourceFile)) {
    const reason = probeVerdict(await probeMediaInfo(sourceFile), expectedMinutes);
    if (reason) throw new ImportSkippedError(`Not importing "${path.basename(sourceFile)}": ${reason} — left in the download for a manual import`);
  }
}

/** Last line of defence behind the segment sanitizing above: nothing is ever placed outside its root folder. */
function assertInsideRoot(rootFolderPath: string, target: string): void {
  const relative = path.relative(path.resolve(rootFolderPath), path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new ImportSkippedError(`Refusing to place "${target}" outside its root folder "${rootFolderPath}"`);
  }
  // The root folder itself must exist. Creating the whole destination path (makeLibraryDirectory) would
  // otherwise turn a typo or a share that did not mount into a real directory tree on the container's own
  // file system, where every import "succeeds" and nothing ever shows up in the media server. Sonarr and
  // Radarr refuse the same way (RootFolderNotFoundException). The download stays for a manual import.
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(rootFolderPath).isDirectory();
  } catch {
    // missing or unreachable
  }
  if (!isDirectory) {
    // Not an ImportSkippedError: that is a final decision about this file. A share that is not mounted yet (or
    // dropped for a minute) comes back, and a plain error is parked as "Couldn't place the file" and retried
    // after 15 minutes, an hour and six hours (scheduler.ts retryTransientParkedImports).
    throw new Error(`Root folder "${rootFolderPath}" does not exist or is not a folder (is the share mounted?) — kept for a manual import from Activity`);
  }
}

/** Per-type override (`naming<Type>Template` in settings) falling back to the shape's default. */
function getNamingTemplate(type: MediaType): string {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const override = getSetting(`naming${capitalized}Template`);
  if (override) return override;
  return DEFAULT_SHAPE_TEMPLATES[getMediaTypeConfig(type).shape];
}

/** A not-yet-converted legacy_shape row keeps its old shape's layout: the type's own template is
 * written for the type's current shape and its tokens ({season}, {episode}) don't apply to it. */
function namingTemplateFor(item: { type: MediaType; legacyShape?: string | null }): string {
  return item.legacyShape ? DEFAULT_SHAPE_TEMPLATES[effectiveShape(item)] : getNamingTemplate(item.type);
}

/** `namingEnabled<Type>` in settings, defaulting to enabled — unset/missing means "on" so existing
 * installations (with no such key at all) keep their current templated-renaming behavior. */
function getNamingEnabled(type: MediaType): boolean {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  return getSetting(`namingEnabled${capitalized}`) !== "0";
}

/** Builds the final destination from rendered template segments. When naming is disabled for this
 * type, the template's FOLDER structure still applies (still needed to keep episodes grouped
 * under their season, and to avoid dumping every file flat into one directory) — only the
 * filename itself is swapped for the sanitized original instead of the templated one. */
function resolveDest(
  rootFolderPath: string,
  segments: string[],
  ext: string,
  sourceFile: string,
  namingEnabled: boolean
): { destPath: string; fileLabel: string } {
  const folderSegments = segments.slice(0, -1);
  const fileLabel = namingEnabled
    ? `${segments[segments.length - 1]}${ext}`
    : `${safePathSegment(path.basename(sourceFile, path.extname(sourceFile)), true)}${ext}`;
  const destPath = path.join(rootFolderPath, ...folderSegments, fileLabel);
  assertInsideRoot(rootFolderPath, destPath);
  return { destPath, fileLabel };
}

/**
 * A music track's (or audiobook part's) file name under the track template (`namingArtistTrackTemplate`), with the
 * extension of the file it names. The import and Organize & Rename both name tracks with this one function.
 */
function trackFileNameFor(item: { title: string; [key: string]: any }, albumTitle: string, track: { track_number: unknown; title: unknown }, extension: string): string {
  const trackTemplate = getSetting("namingArtistTrackTemplate") || DEFAULT_TRACK_TEMPLATE;
  return (
    safePathSegment(
      renderTemplate(
        trackTemplate,
        pathSafeVars({
          trackNumber: track.track_number as number,
          trackTitle: track.title as string,
          parentTitle: item.title,
          childTitle: albumTitle,
          ...providerIdVars(item as any),
        })
      )
    ) + extension
  );
}

/** Refuses an import into a root folder that is an empty mount point while the library has files recorded in it. */
async function assertRootFolderMounted(rootFolder: { id: number; path: string; readOnly?: boolean }): Promise<void> {
  // A decision, not a glitch: the admin made this library read-only, so nothing is placed into it.
  if (rootFolder.readOnly) throw new ImportSkippedError(`Root folder "${rootFolder.path}" is a read-only library: nothing is imported into it`);
  const reason = await rootFolderUnmountedReason(rootFolder);
  // A plain Error, not an ImportSkippedError: the share comes back, and a plain error is parked and retried later.
  if (reason) throw new Error(`${reason} — kept for a manual import from Activity`);
}

/** Accents and apostrophes are folded away so an indexer's "Grey's"/"Pokémon" still matches the
 * "Greys"/"Pokemon" a release's own files carry. */
function normalizeTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3);
}

/** The short numbers normalizeTokens drops as too short to compare words on ("Episode 12", "#5",
 * "Vol. 03"), leading zeros removed — "Episode 12" and "Episode 13" otherwise share every token.
 * Channel layouts and codecs ("DDP5.1", "H.264") are left out: a file needn't repeat those. */
function numberTokens(text: string): Set<string> {
  const numbers = new Set<string>();
  // A decimal is a channel layout or version ("5.1", "7.1", "v2.0"): one or two digits either side
  // of the point. "2024.1080p" and "2024.10bit" in a dotted release name are a year and a tag.
  const cleaned = text.replace(/(?<!\d)\d{1,2}[.,]\d{1,2}(?!\d)/g, " ").replace(/[hx][.\s]?26[45]/gi, " ");
  // Four digits too: a year tells "Dune.2021" from "Dune.Part.Two.2024" when the words alone can't.
  for (const m of cleaned.matchAll(/(?<![a-z0-9])\d{1,4}(?![a-z0-9])/gi)) numbers.add(String(Number(m[0])));
  return numbers;
}

interface FileCandidate {
  filePath: string;
  size: number;
  score: number;
  /** Numbered as something else than the release ("Episode 12" when "Episode 13" was grabbed). */
  otherNumber: boolean;
}

/** Where one download's files are, as far as is known: its release title, the folder or file its
 * client reported (queue.download_path), and that client's category. */
interface DownloadContext {
  releaseTitle?: string;
  downloadPath?: string | null;
  category?: string | null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when `dir` is this download's own folder rather than one it shares with other downloads.
 * Its name decides (isSharedDownloadFolder), not the client having reported it: a multi-file
 * torrent saved without a subfolder of its own is reported by qBittorrent as its save path, which
 * every other download saved there shares. A folder inside a reported folder that is the download's
 * own is its own too. Neither the downloads root nor the client's category folder ever is. */
function isOwnReleaseFolder(dir: string, ctx: DownloadContext): boolean {
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(config.downloadsDir)) return false;
  // A subcategory ("tv/sonarr") is saved in a folder named for its last level.
  const category = ctx.category?.trim().toLowerCase().split(/[\\/]/).filter(Boolean).pop() || null;
  if (category && path.basename(resolved).toLowerCase() === category) return false;
  if (!isSharedDownloadFolder(resolved, ctx.releaseTitle)) return true;
  if (ctx.downloadPath) {
    const reported = path.resolve(ctx.downloadPath);
    if (resolved.startsWith(reported + path.sep) && isDirectory(reported)) return isOwnReleaseFolder(reported, ctx);
  }
  return false;
}

/** The folder holding just this download's files — the client-reported folder when the import's
 * file is inside it, else `folder` (the file's own by default) — or null when the download has none
 * of its own (a single-file torrent saved straight into a category folder, a file loose in the
 * downloads root). */
function ownReleaseFolderOf(sourceFile: string, ctx: DownloadContext, folder = path.dirname(sourceFile)): string | null {
  const src = path.resolve(sourceFile);
  if (ctx.downloadPath) {
    const reported = path.resolve(ctx.downloadPath);
    if (src.startsWith(reported + path.sep) && isDirectory(reported)) return isOwnReleaseFolder(reported, ctx) ? reported : null;
    if (src === reported) return null;
  }
  return isOwnReleaseFolder(folder, ctx) ? path.resolve(folder) : null;
}


const SAMPLE_FOLDER = /^samples?$/i;

// Scene samples put the word at either end of the name ("grp-show.s01e05-sample", "sample-show.s01e05").
const SAMPLE_AT_START = /^sample(?:[\s._-]|$)/i;
const SAMPLE_AT_END = /(?:^|[\s._-])sample$/i;

/** `files` without the release's samples: those in a Sample folder under `baseDir`, and those whose
 * file name starts or ends with the word "sample". A title that merely contains the word keeps its
 * file — an episode named "Show.S01E05.The.Sample.1080p" is real, and so is a release whose own title
 * starts with it ("Sample.People.2021"). File sizes decide nothing: samples of long episodes are
 * bigger than whole short episodes, and a shared folder's largest file is some other download. */
/** Whether `file` is one of its release's samples (see withoutSamples); `baseDir` bounds which of
 * its folders count as the release's own Sample folder. */
function isSamplePath(file: string, baseDir: string, releaseTitle?: string): boolean {
  const parts = path.relative(baseDir, file).split(path.sep);
  if (parts.slice(0, -1).some((part) => SAMPLE_FOLDER.test(part))) return true;
  const name = path.basename(file, path.extname(file)).trim();
  return SAMPLE_AT_END.test(name) || (!SAMPLE_AT_START.test((releaseTitle ?? "").trim()) && SAMPLE_AT_START.test(name));
}

function withoutSamples(files: string[], baseDir: string, releaseTitle: string | undefined): string[] {
  return files.filter((f) => !isSamplePath(f, baseDir, releaseTitle));
}

// A disc's or release's bonus material, by folder ("Extras", "Featurettes") or by file name.
const EXTRAS_FOLDER = /^(?:extras?|featurettes?|bonus(?:[\s._-]?(?:material|content|features?))?|behind[\s._-]the[\s._-]scenes|deleted[\s._-]scenes|trailers?|interviews?)$/i;
const EXTRAS_NAME = /(?:^|[\s._-])(making[\s._-]of|featurette|trailer|deleted[\s._-]scenes?|behind[\s._-]the[\s._-]scenes|bloopers?|outtakes?)(?:$|[\s._-])/i;

/** How a file looks like bonus material: by an Extras-style folder in its path, by an extras word in
 * its name, or not at all. A word that is part of the release's own title ("Trailer Park Boys",
 * "Bloopers" the show) names no extra. */
function extrasKind(file: string, baseDir: string, releaseTitle: string | undefined): "folder" | "name" | null {
  const parts = path.relative(baseDir, file).split(path.sep);
  if (parts.slice(0, -1).some((part) => EXTRAS_FOLDER.test(part))) return "folder";
  const m = EXTRAS_NAME.exec(path.basename(file, path.extname(file)));
  if (!m) return null;
  const titleTokens = new Set(normalizeTokens(releaseTitle ?? ""));
  const markerTokens = normalizeTokens(m[1]);
  return markerTokens.length > 0 && markerTokens.every((t) => titleTokens.has(t)) ? null : "name";
}

const DOWNLOAD_WORKING_FOLDER = /^_(?:UNPACK|FAILED)_/i;

/** Recursively walks the downloads directory (bounded depth) collecting files with a matching extension. */
function walk(dir: string, extensions: string[], maxDepth: number, depth = 0, includeWorkingFolders = false): string[] {
  if (depth > maxDepth) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A usenet client's working folders (SABnzbd's _UNPACK_<job>, _FAILED_<job>) hold half-unpacked
      // or failed jobs, never a finished download.
      if (!includeWorkingFolders && DOWNLOAD_WORKING_FOLDER.test(entry.name)) continue;
      found.push(...walk(full, extensions, maxDepth, depth + 1, includeWorkingFolders));
    } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

/** Tokens of the series/album title at the front of a release name ("Breaking Bad" out of
 * "Breaking.Bad.S01E05.1080p.WEB-DL", a leading "[Group]" tag skipped) — empty when every word is
 * too short to compare on. */
function releaseTitleTokens(releaseTitle: string | undefined): string[] {
  if (!releaseTitle) return [];
  const withoutGroup = releaseTitle.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "");
  // A pack named in words ("Show Name Season 1 Complete", "Show (01-12) [Batch]") would otherwise
  // keep those words as title tokens its own "Show.Name.S01E02" files never carry.
  const withoutPackWording = withoutGroup.replace(/[\s._\-([]+(?:complete\b|batch\b|seasons?[\s._-]*\d{1,2}\b|\d{1,3}\s*-\s*\d{1,3}\s*[)\]]).*$/i, "");
  return normalizeTokens(guessTitleFromText(withoutPackWording || withoutGroup));
}

// Quality, source, codec, audio and format words, as normalizeTokens/numberTokens yield them.
const QUALITY_WORDS = new Set([
  "480p", "480i", "576p", "576i", "720p", "1080p", "1080i", "2160p", "4320p", "uhd", "hdr", "hdr10", "hdr10plus", "dovi", "sdr",
  "web", "webdl", "webrip", "bluray", "blu", "bdrip", "brrip", "remux", "hdtv", "dvd", "dvdrip", "xvid", "divx",
  "x264", "x265", "h264", "h265", "264", "265", "hevc", "avc", "10bit", "8bit",
  "flac", "mp3", "aac", "ac3", "eac3", "dts", "truehd", "atmos", "320", "epub", "mobi", "azw3", "pdf", "cbz", "cbr", "m4b",
]);

// Words naming a kind of download rather than any one release.
const PACK_WORDS = new Set(["complete", "completed", "batch", "season", "seasons", "series", "pack", "collection", "discography", "full", "boxset"]);

/** True for a folder that holds other downloads besides this one. In-process downloaders (HTTP,
 * debrid) save every job's files loose in the downloads root, and a client's category folder
 * ("tv", "music") holds every download of that category — treating everything there as one
 * release swept other shows' episodes and other albums' tracks into this import. */
function isSharedDownloadFolder(dir: string, releaseTitle: string | undefined): boolean {
  if (path.resolve(dir) === path.resolve(config.downloadsDir)) return true;
  const titleTokens = releaseTitleTokens(releaseTitle);
  if (titleTokens.length === 0) return false;
  const name = path.basename(dir);
  const dirTokens = new Set(normalizeTokens(name));
  // Every one of the release's own significant title words must appear in the folder's name for
  // this to short-circuit as "this download's own folder" — sharing just one of them (e.g. a
  // multi-word show/artist title's least distinctive word) isn't enough, or a differently-named
  // release sharing that one word would pass as this download's own and sweep its unrelated files
  // into the import (or, via cleanupDownloadSourceFolder, get its folder deleted as "leftovers").
  if (titleTokens.every((t) => dirTokens.has(t))) return false;
  // A torrent folder named without the artist or show ("25 (2015) [FLAC]" for "Adele - 25 (2015)
  // [FLAC]", "1989 [FLAC]" for "Taylor Swift - 1989 [FLAC]") is still named by nothing but the
  // release's own words and numbers. One such word alone is not enough: a save folder called
  // "complete" shares it with every "...COMPLETE..." pack. Nor are quality words or pack words alone,
  // which a save or category folder ("UHD HDR", "1080p WEB", "Complete 1080p") shares with every
  // release of that quality or kind.
  const nameWords = new Set([...dirTokens, ...numberTokens(name)]);
  const identifying = [...nameWords].filter((t) => !QUALITY_WORDS.has(t) && !PACK_WORDS.has(t));
  const releaseWords = new Set([...normalizeTokens(releaseTitle!), ...numberTokens(releaseTitle!)]);
  return !(identifying.length >= 1 && nameWords.size >= 2 && [...nameWords].every((t) => releaseWords.has(t)));
}

/** A file that can't be stat'ed (a dangling symlink, e.g. a debrid link whose torrent expired, or
 * one removed mid-scan) is dropped rather than thrown — it failed every import searching the same
 * folder, blocklisting good releases. */
function scoreByTokenOverlap(filePaths: string[], releaseTitle: string, baseDir: string): FileCandidate[] {
  const wantedTokens = new Set(normalizeTokens(releaseTitle));
  const wantedNumbers = numberTokens(releaseTitle);
  // Quality words ("1080p", "x264", "flac") are shared by every other download of that quality, so
  // they weigh a quarter of a title word or a year. Without this an unrelated file sharing most of a
  // release's quality tags outscored the threshold.
  const weightOf = (t: string) => (QUALITY_WORDS.has(t) ? 0.25 : 1);
  let wantedWeight = 0;
  for (const t of wantedTokens) wantedWeight += weightOf(t);
  return filePaths.flatMap((filePath) => {
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return [];
    }
    const relative = path.relative(baseDir, filePath);
    const fileTokens = new Set(normalizeTokens(relative));
    const fileNumbers = numberTokens(relative);
    let overlap = 0;
    for (const t of wantedTokens) if (fileTokens.has(t)) overlap += weightOf(t);
    let score = wantedWeight > 0 ? overlap / wantedWeight : 0;
    // A title of nothing but short words ("Ep 5", "#12") is matched on its numbers instead.
    if (wantedTokens.size === 0 && wantedNumbers.size > 0) score = [...wantedNumbers].filter((n) => fileNumbers.has(n)).length / wantedNumbers.size;
    const otherNumber = wantedNumbers.size > 0 && fileNumbers.size > 0 && ![...wantedNumbers].some((n) => fileNumbers.has(n));
    return [{ filePath, size, score, otherNumber }];
  });
}

/**
 * Finds the file in the shared downloads directory that best matches a release. This mirrors
 * how Sonarr/Radarr resolve a completed download to a file without needing direct
 * download-client filesystem APIs — it just needs the downloads folder to be visible to AoNarr.
 *
 * For episodic libraries, a season-pack download puts multiple episode files in one shared
 * folder, so several queue rows (one per grabbed episode) all resolve to files under the same
 * directory. When a target season/episode is given, candidates are first narrowed to files whose
 * own relative path parses to that specific episode (e.g. "...S01E05..." in the filename) so each
 * queue row picks its own file instead of racing the others for the top token-overlap score.
 * Falls back to plain token overlap when nothing parses that precisely (e.g. non-standard
 * per-episode release naming).
 *
 * `searchRoot`, when given, is this specific download's own location — either the remote-path-
 * mapping-translated queue.download_path (see services/downloadClient.ts's applyRemotePathMapping)
 * or an already-local path a caller resolved some other way. A single matching file there (the
 * common case for a non-season-pack torrent, where the client reports the file itself) is returned
 * immediately with no scoring needed at all — the client already told us exactly which download
 * this is, which is both more accurate and cheaper than fuzzy-matching against the whole downloads
 * directory. A directory is walked and scored the same way the full downloadsDir normally is, just
 * scoped to that one release's own files (so a season pack's several episodes don't have to
 * compete against every other in-flight download for top score). Paths inside it are matched with
 * the folder's own name in front, so an obfuscated file in a properly named release folder still
 * parses. A search root that no longer exists (a stale mapping) falls through to the normal
 * downloadsDir-wide search; for an episode target, one that does exist but holds no match does not,
 * nor does the release's own folder holding nothing but its sample.
 *
 * `options.childTitle` is the wanted book/issue/video's own title when the download may hold several
 * (a trilogy, a run of issues): every file of such a pack scores the same against the release title,
 * so the one named for the child is preferred over simply the largest. `options.category` is the
 * download client's category — see isOwnReleaseFolder.
 */
export function findDownloadedFile(
  releaseTitle: string,
  mediaType: MediaType,
  target?: EpisodeTarget,
  searchRoot?: string | null,
  options: { childTitle?: string | null; category?: string | null } = {}
): string | null {
  return locateDownloadedFile(releaseTitle, mediaType, target, searchRoot, options).file;
}

/** Why locateDownloadedFile found nothing where the client said the download is. A reported file
 * of another type (a disc image), or a folder holding only one, is left for a manual import; a
 * reported folder with nothing importable fails the release like any other, without a
 * downloads-wide search standing in. */
export type LocateReason = "unsupported-extension" | "nothing-in-reported-folder";

// Media the library can't import as files but a download may legitimately consist of.
const DISC_IMAGE_EXTENSIONS = [".iso", ".img"];

/**
 * findDownloadedFile, with the reason when a client-reported location yields nothing. Sonarr/Radarr
 * never search beyond what the download client reported: a download whose folder holds no media is
 * waiting for manual import, not one whose file is somewhere else in the downloads directory. The
 * downloads-wide search is kept for a download the client reported no path for, and for a reported
 * path that does not exist (a remote-path mapping that is stale or not yet written). The legacy
 * widening after an existing-but-empty reported folder is behind the `importDownloadsWideSearch`
 * setting ("1" restores it).
 */
export function locateDownloadedFile(
  releaseTitle: string,
  mediaType: MediaType,
  target?: EpisodeTarget,
  searchRoot?: string | null,
  options: { childTitle?: string | null; category?: string | null } = {}
): { file: string | null; reason?: LocateReason } {
  const extensions = getMediaTypeConfig(mediaType).extensions;
  const ctx: DownloadContext = { releaseTitle, downloadPath: searchRoot, category: options.category };

  if (searchRoot) {
    // Only the existence check may fail over to the downloads-wide search: a mapped path that doesn't
    // exist (stale mapping, or the client hasn't written there yet) is treated as no path given.
    const statOf = (p: string): fs.Stats | null => {
      try {
        return fs.statSync(p);
      } catch {
        return null;
      }
    };
    let root = searchRoot;
    let stat = statOf(root);
    if (stat?.isFile() && !extensions.includes(path.extname(root).toLowerCase()) && isArchiveFile(root)) {
      // The client reported the archive itself (a single-file .rar torrent): its contents, once
      // unpacked, are in the sibling folder named after it.
      const unpacked = archiveDestinationFor(root);
      if (isDirectory(unpacked)) {
        root = unpacked;
        stat = statOf(root);
      }
    }
    if (stat) {
      if (stat.isFile()) {
        if (extensions.includes(path.extname(root).toLowerCase())) return { file: root };
        // The client reported THE file (a disc image, an archive the unpacker left alone): it is the
        // download, and nothing elsewhere in the downloads directory is.
        log.info(`[importer] "${path.basename(root)}" is not a ${mediaType} file type; left for a manual import`);
        return { file: null, reason: "unsupported-extension" };
      } else if (stat.isDirectory()) {
        const scoped = findDownloadedFileIn(root, path.dirname(root), releaseTitle, extensions, target, ctx, options.childTitle);
        if (scoped.file) return { file: scoped.file };
        // A folder whose only media is a disc image is the same case as a reported disc image.
        if (walk(root, DISC_IMAGE_EXTENSIONS, 4).length > 0 && walk(root, extensions, 4).length === 0) {
          log.info(`[importer] "${releaseTitle}" holds only a disc image, not a ${mediaType} file type; left for a manual import`);
          return { file: null, reason: "unsupported-extension" };
        }
        // The downloads-wide search could only turn up some other download of the same episode
        // number (another show's, or an older grab of this one still seeding) — not this one. Nor,
        // when the release's own folder holds only its sample, anything but another grab of the
        // same title, whose files would be moved out from under its seeding.
        if (target || (scoped.droppedSamples && isOwnReleaseFolder(root, ctx)) || getSetting("importDownloadsWideSearch") !== "1") {
          log.info(`[importer] nothing importable for "${releaseTitle}" in its reported folder "${root}"; not searching the rest of the downloads directory`);
          return { file: null, reason: "nothing-in-reported-folder" };
        }
      }
    }
  }

  return { file: findDownloadedFileIn(config.downloadsDir, config.downloadsDir, releaseTitle, extensions, target, ctx, options.childTitle).file };
}

/** `labelBase` is what candidate paths are made relative to before parsing/scoring — baseDir
 * itself, or its parent so baseDir's own (release-named) folder name counts too. `droppedSamples`
 * tells whether any file there was passed over as a sample. */
function findDownloadedFileIn(
  baseDir: string,
  labelBase: string,
  releaseTitle: string,
  extensions: string[],
  target?: EpisodeTarget,
  ctx: DownloadContext = { releaseTitle },
  childTitle?: string | null
): { file: string | null; droppedSamples: boolean } {
  const walked = walk(baseDir, extensions, 4);
  // A sample scores as well as the release's own file and was imported whenever that file was still
  // packed in an archive.
  const withoutSampleFiles = withoutSamples(walked, baseDir, releaseTitle);
  const droppedSamples = withoutSampleFiles.length < walked.length;
  return { file: pickDownloadedFile(withoutSampleFiles, baseDir, labelBase, releaseTitle, target, ctx, childTitle), droppedSamples };
}

/** A book, comic or audio release often ships one work in several formats ("Dune.epub", "Dune.mobi", "Dune.pdf"):
 * the reader's preferred one wins before size does (a PDF is the largest, and the least wanted). Video and other
 * extensions all rank alike, leaving their order to the score and size. */
const FORMAT_PREFERENCE = [".epub", ".azw3", ".azw", ".mobi", ".cbz", ".cbr", ".m4b", ".flac", ".m4a", ".mp3", ".pdf"];
function formatRank(filePath: string): number {
  // An extension not listed (video, a ROM) ranks best, so a course's lecture still beats its pdf slides.
  const at = FORMAT_PREFERENCE.indexOf(path.extname(filePath).toLowerCase());
  return at < 0 ? 0 : at + 1;
}

function pickDownloadedFile(
  candidates: string[],
  baseDir: string,
  labelBase: string,
  releaseTitle: string,
  target: EpisodeTarget | undefined,
  ctx: DownloadContext,
  childTitle: string | null | undefined
): string | null {
  // A release's extras (featurettes, trailers, deleted scenes) are never the feature or an episode.
  // Files in an Extras-style folder are passed over while anything else is there to take, so a
  // download that is nothing but a folder named "Extras" still imports. A file merely NAMED with an
  // extras word is passed over only when another candidate plausibly is the release — named for the
  // target episode, or with the release's own title — or "Show.S01E05.The.Trailer.mkv" would lose to
  // the "RARBG.mp4" promo beside it.
  const releaseKey = identityKey(parseReleaseTitle(releaseTitle).title);
  const ownTitleKey = (filePath: string) => identityKey(parseReleaseTitle(withoutVersionTag(path.basename(filePath, path.extname(filePath)))).title);
  const plausiblyRelease = (filePath: string) => {
    if (target && parsedMatchesTarget(parseReleaseTitle(withoutVersionTag(path.basename(filePath, path.extname(filePath)))), target)) return true;
    const own = ownTitleKey(filePath);
    return !!releaseKey && !!own && (own === releaseKey || ` ${own} `.includes(` ${releaseKey} `));
  };
  const kinds = new Map(candidates.map((f) => [f, extrasKind(f, baseDir, releaseTitle)] as const));
  const outsideExtrasFolders = candidates.filter((f) => kinds.get(f) !== "folder");
  if (outsideExtrasFolders.length > 0) candidates = outsideExtrasFolders;
  const unnamedAsExtras = candidates.filter((f) => kinds.get(f) !== "name");
  if (unnamedAsExtras.length > 0 && unnamedAsExtras.length < candidates.length && unnamedAsExtras.some(plausiblyRelease)) candidates = unnamedAsExtras;

  if (target && !isOwnReleaseFolder(baseDir, ctx)) {
    const seriesTokens = releaseTitleTokens(releaseTitle);
    if (seriesTokens.length > 0) {
      // An SxxEyy or air date alone doesn't identify a show, and a folder shared with other downloads
      // routinely holds other shows' files carrying the same numbers, so the series' own title must be
      // in the path too. A release's own folder holds only its own files and needs no such check.
      candidates = candidates.filter((filePath) => {
        const pathTokens = new Set(normalizeTokens(path.relative(labelBase, filePath)));
        return seriesTokens.every((t) => pathTokens.has(t));
      });
    } else if (releaseKey) {
      // A title too short to have tokens ("24", "ER", "Up") can't be required in the path; a file in
      // the shared folder plainly named AND numbered for another show is still not it. A name without
      // its own numbering ("Day 1 - 2.00 AM") is left to the episode/folder matching below, and a file
      // whose own folder names this release is this release's.
      const squash = (s: string) => s.replace(/ /g, "");
      candidates = candidates.filter((filePath) => {
        const own = parseReleaseTitle(withoutGroupPrefix(withoutVersionTag(path.basename(filePath, path.extname(filePath))), releaseTitle));
        const numbered = own.seasonNumber != null || !!own.episodeNumbers?.length || own.absoluteEpisode != null || !!own.airDate;
        const ownKey = identityKey(own.title);
        if (!numbered || ownKey.split(" ").filter(Boolean).length < 2) return true;
        if (ownKey === releaseKey || squash(ownKey) === squash(releaseKey) || ` ${ownKey} `.includes(` ${releaseKey} `)) return true;
        const folderKey = identityKey(parseReleaseTitle(path.basename(path.dirname(filePath))).title);
        return !!folderKey && (folderKey === releaseKey || squash(folderKey) === squash(releaseKey));
      });
    }
  }
  if (candidates.length === 0) return null;

  if (target) {
    // A file's own name is parsed first (minus the extension, which hides the number in "Show - 05.mkv"):
    // parsed behind its folder's name, a pack's "S02E01-E04" or bare "S01" matched every file in it and
    // the largest was imported as the target. The folder's name only helps when no file's own name matches.
    const parseRelative = (base: string, filePath: string) => {
      const relative = path.relative(base, filePath);
      return parseReleaseTitle(relative.slice(0, relative.length - path.extname(relative).length));
    };
    const matchesTarget = (base: string, filePath: string) => parsedMatchesTarget(parseRelative(base, filePath), target);
    let episodeMatches = candidates.filter((filePath) => matchesTarget(baseDir, filePath));
    if (episodeMatches.length === 0) {
      // Nothing matched on its own name, so the folder name and token overlap get a say — but only
      // for files with no numbering of their own, or numbered exactly as the grabbed release is (a
      // release numbered differently from this library). A file named for some other episode of a
      // pack is never the target, however well its folder or title matches.
      const release = parseReleaseTitle(releaseTitle);
      const sameEpisodes = (a: number[] | null, b: number[] | null) => !!a?.length && a.length === b?.length && a.every((n, i) => n === b[i]);
      candidates = candidates.filter((filePath) => {
        const own = parseReleaseTitle(path.basename(filePath, path.extname(filePath)));
        // An empty list is a numbered special ("S2 - 12.5"), not a file without a number.
        const unnumbered = own.episodeNumbers == null && !own.isFullSeason && own.absoluteEpisode == null && !own.airDate;
        const numberedAsRelease =
          (own.seasonNumber === release.seasonNumber && sameEpisodes(own.episodeNumbers, release.episodeNumbers)) ||
          (own.absoluteEpisode != null && own.absoluteEpisode === release.absoluteEpisode) ||
          (!!own.airDate && own.airDate === release.airDate);
        return unnumbered || numberedAsRelease;
      });
      if (candidates.length === 0) return null;
      if (labelBase !== baseDir) episodeMatches = candidates.filter((filePath) => matchesTarget(labelBase, filePath));
    }
    if (episodeMatches.length > 0) {
      const scored = scoreByTokenOverlap(episodeMatches, releaseTitle, labelBase);
      scored.sort((a, b) => b.score - a.score || b.size - a.size);
      return scored[0]?.filePath ?? null;
    }
  }

  const scored = scoreByTokenOverlap(candidates, releaseTitle, labelBase).filter((c) => !c.otherNumber);
  scored.sort((a, b) => b.score - a.score || formatRank(a.filePath) - formatRank(b.filePath) || b.size - a.size);
  const passing = scored.filter((c) => c.score >= 0.4);
  const childTokens = childTitle ? new Set([...normalizeTokens(childTitle), ...numberTokens(childTitle)]) : new Set<string>();
  if (childTokens.size > 0 && passing.length > 1) {
    // Scored on the file's own name only: every file of a pack shares its folder's name.
    const childScore = (filePath: string) => {
      const own = path.basename(filePath, path.extname(filePath));
      const ownTokens = new Set([...normalizeTokens(own), ...numberTokens(own)]);
      return [...childTokens].filter((t) => ownTokens.has(t)).length / childTokens.size;
    };
    const ranked = passing.map((c) => ({ c, child: childScore(c.filePath) }));
    ranked.sort((a, b) => b.child - a.child || b.c.score - a.c.score || formatRank(a.c.filePath) - formatRank(b.c.filePath) || b.c.size - a.c.size);
    return ranked[0].c.filePath;
  }
  return passing[0]?.filePath ?? null;
}

/**
 * Lists every file under the downloads directory whose extension matches the given media type,
 * newest-first, for the Activity page's manual-import picker — the same universe of files
 * `findDownloadedFile` searches, just without the fuzzy title match/score threshold, since a
 * manual pick means the admin is choosing by eye instead.
 */
export function listDownloadedFileCandidates(mediaType: MediaType): { path: string; size: number; mtimeMs: number }[] {
  const extensions = getMediaTypeConfig(mediaType).extensions;
  // The admin picking a file by hand may want one from a failed job's working folder: shown here.
  const candidates = walk(config.downloadsDir, extensions, 4, 0, true);
  return candidates
    .flatMap((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return [{ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return []; // a dangling symlink or a file removed mid-listing — see scoreByTokenOverlap
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Applies the configured chmod (and, only when running as root, chown) to a just-created file or
 * folder — Sonarr/Radarr's "File Management > Permissions" setting, which AoNarr had no equivalent
 * of: every imported file previously landed with whatever the container's default umask gave it,
 * which is wrong the moment another app (Plex, Jellyfin) reads the library under a different
 * uid/gid. Best-effort and silent on failure (e.g. a bind mount that doesn't support chmod, or a
 * non-root container missing permission to chown) — a permissions tweak failing shouldn't fail the
 * import itself.
 */
function applyConfiguredPermissions(targetPath: string, isDirectory: boolean): void {
  if (getSetting("setPermissionsEnabled") !== "1") return;
  const mode = getSetting(isDirectory ? "folderChmod" : "fileChmod");
  if (mode && /^[0-7]{3,4}$/.test(mode)) {
    try {
      fs.chmodSync(targetPath, parseInt(mode, 8));
    } catch (err) {
      log.warn(`[importer] chmod ${mode} failed for ${targetPath}:`, (err as Error).message);
    }
  }

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const uid = getSetting("chownUid");
    const gid = getSetting("chownGid");
    if (uid && gid) {
      try {
        fs.chownSync(targetPath, Number(uid), Number(gid));
      } catch (err) {
        log.warn(`[importer] chown ${uid}:${gid} failed for ${targetPath}:`, (err as Error).message);
      }
    }
  }
}

/**
 * Places a downloaded source file at its library destination using the configured import
 * strategy — "move" (default, unchanged behavior: rename, or copy+delete across filesystems),
 * "hardlink" (Sonarr/Radarr's real "Use Hard links instead of Copy" option: the library file and
 * the still-seeding torrent file share the same disk data, no duplicate space, falls back to a
 * non-deleting copy if src/dest are on different filesystems since a cross-device hardlink is
 * impossible and deleting a still-seeding source would break seeding), or "symlink" (what makes a
 * debrid/rclone-mounted setup — Zurg, Decypharr, Riven-style — actually usable: the "download" is
 * really a remote-mounted virtual file, and the library entry needs to just point at it rather
 * than physically copy a multi-GB file that was never local to begin with).
 */
/** Async (fs.promises-based, libuv thread pool) rather than the fs.*Sync calls this used to make —
 * a cross-device "move" (EXDEV: src/dest on different Docker mounts, e.g. /downloads vs /media)
 * falls back to a full copy, and fs.copyFileSync blocks Node's single-threaded event loop for the
 * *entire* copy. For a multi-GB video file that's many seconds to minutes during which the whole
 * server stops responding to every request from every user — the same bug already fixed in
 * recycleBin.ts's recycleFile (see that file's comments), just in the normal import/Organize &
 * Rename path instead of the recycle-bin one. mkdir/exists/chmod/chown are cheap metadata
 * operations regardless of file size, so those are left as-is; only the actual file-content copy
 * needed to move off the sync API. */
/** `forceMove` ignores the hardlink/symlink import strategy — that setting is about how a
 * download's bytes enter the library; a rename of a file already inside the library must always
 * be a real move, or the old file is left behind (hardlink) / the DB ends up pointing at a
 * symlink to a symlink (symlink). */
export async function moveFile(src: string, dest: string, forceMove = false): Promise<void> {
  const destDir = path.dirname(dest);
  makeLibraryDirectory(destDir);
  const strategy = forceMove ? "move" : currentImportStrategy();

  if (strategy === "symlink") {
    // Importing the library file onto its own path: replacing it with a link would unlink the only
    // copy and leave a link to itself.
    if (isSameFile(src, dest)) return;
    // Created under a temporary name and renamed over dest, which also replaces a dangling link —
    // existsSync() follows links, so it missed one and symlink() then failed with EEXIST on every
    // re-import. Symlinks don't get chmod'd/chown'd — that would touch the pointed-to file
    // (usually a read-only remote mount this container has no business modifying), not the link.
    const tmp = tempPathNextTo(dest);
    fs.symlinkSync(path.resolve(src), tmp);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      removeQuietly(tmp);
      throw err;
    }
    return;
  }

  applyConfiguredPermissions(destDir, true);

  if (strategy === "hardlink") {
    // Linked under a temporary name and renamed over dest: link(2) itself refuses an existing
    // dest (EEXIST), which failed every upgrade landing on the same templated path — the good
    // release was blocklisted and the next one grabbed, failing the same way each time.
    const tmp = tempPathNextTo(dest);
    try {
      fs.linkSync(src, tmp);
      fs.renameSync(tmp, dest);
      // rename() is a no-op (leaving tmp behind) when tmp and dest are already the same inode.
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (err: any) {
      removeQuietly(tmp);
      if (err.code !== "EXDEV") throw err;
      await copyIntoPlace(src, dest);
    }
    applyConfiguredPermissions(dest, false);
    return;
  }

  if (strategy === "copy") {
    // A manual import of files the admin wants to keep where they are: a copy, the source untouched.
    await copyIntoPlace(src, dest);
    applyConfiguredPermissions(dest, false);
    return;
  }

  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err.code !== "EXDEV") throw err;
    await copyIntoPlace(src, dest);
    fs.unlinkSync(src);
  }
  applyConfiguredPermissions(dest, false);
}

/** What the history rows of one queue row's import say about its download (see queueHistory.ts). */
const importHistoryContext = new AsyncLocalStorage<Record<string, unknown>>();

/** The JSON of an `imported` history row: the import's own facts, with the download's. */
function importedHistoryData(facts: Record<string, unknown>): string {
  return JSON.stringify({ ...(importHistoryContext.getStore() ?? {}), ...facts });
}

const IMPORT_STRATEGIES = ["move", "copy", "hardlink", "symlink"] as const;
const strategyOverride = new AsyncLocalStorage<string>();

/** The import strategy for the work running now: the one a manual import asked for, else the setting. */
function currentImportStrategy(): string {
  const strategy = strategyOverride.getStore() ?? getSetting("importStrategy") ?? "move";
  // "auto" is decided per download (see autoStrategyFor); work that is not one download's import moves, as the default does.
  return strategy === "auto" ? "move" : strategy;
}

/**
 * The "auto" import strategy (Sonarr's Auto mode, Round 27): a torrent is hardlinked (a copy where a hardlink is
 * not possible) so it keeps seeding, and everything else is moved. Undefined when the setting is not "auto".
 */
export function autoStrategyFor(protocol: string | null | undefined, clientType?: string | null): "hardlink" | "move" | undefined {
  if (getSetting("importStrategy") !== "auto") return undefined;
  // Only a client that seeds from the downloads folder has anything to gain: a debrid account or a watch folder's output
  // would sit in the folder for ever once hardlinked, so those are moved like usenet.
  return protocol === "torrent" && !!clientType && SEEDING_CLIENT_TYPES.has(clientType) ? "hardlink" : "move";
}

/** Clients that download torrents into the folder AoNarr imports from and go on seeding them there. */
const SEEDING_CLIENT_TYPES: ReadonlySet<string> = new Set(["qbittorrent", "transmission", "deluge"]);

/**
 * Runs `work` with a strategy of its own (Sonarr's manual import asks for Move or Copy per import). An unknown or
 * empty strategy leaves the setting in force.
 */
export function withImportStrategy<T>(strategy: unknown, work: () => Promise<T>): Promise<T> {
  return typeof strategy === "string" && (IMPORT_STRATEGIES as readonly string[]).includes(strategy) ? strategyOverride.run(strategy, work) : work();
}

const TEMP_PREFIX = ".aonarr-tmp-";
const STALE_TEMP_MS = 60 * 60 * 1000;
/** Temps this process is still copying into — never stale, whatever their mtime says. */
const activeTemps = new Set<string>();

/** A short name in dest's own folder, whatever dest's length: a name derived from dest overran
 * NAME_MAX (ENAMETOOLONG) for long titles that fit on their own. */
function tempPathNextTo(dest: string): string {
  return path.join(path.dirname(dest), `${tempPrefixFor(dest)}${crypto.randomBytes(6).toString("hex")}`);
}

/** Ties a temp to its destination's name, so the next import to that file knows it for its own. */
function tempPrefixFor(dest: string): string {
  return `${TEMP_PREFIX}${crypto.createHash("sha1").update(path.basename(dest)).digest("hex").slice(0, 8)}-`;
}

/** Deletes the partial copies a restart mid-import left in `dir`: no cleanup code runs when the
 * process is killed, so each one stayed forever as a hidden, often multi-GB file that also kept the
 * folder from ever being removed as empty. A leftover of an earlier copy to `forDest` is taken at
 * once — the retry after a restart comes within minutes, long before an age limit would pass. Any
 * other temp only once untouched for an hour, which spares a copy another process sharing the
 * library is still writing. */
export async function removeStaleImportTemps(dir: string, forDest?: string): Promise<void> {
  let names: string[];
  try {
    names = await guardedFsCall("readdir", dir, FS_CALL_TIMEOUT_MS, () => fsp.readdir(dir));
  } catch {
    return;
  }
  const ownPrefix = forDest ? tempPrefixFor(forDest) : null;
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const name of names) {
    const full = path.join(dir, name);
    if (!name.startsWith(TEMP_PREFIX) || activeTemps.has(path.resolve(full))) continue;
    try {
      const st = await fsp.lstat(full);
      if (st.isDirectory()) continue;
      if ((ownPrefix && name.startsWith(ownPrefix)) || st.mtimeMs < cutoff) await fsp.rm(full, { force: true });
    } catch {
      // gone already, or not removable — best effort
    }
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // best effort
  }
}

/** Cross-device copy that leaves dest untouched until the new file is complete: copied under a
 * temporary name beside it, flushed, then renamed over it. Copying straight onto dest truncated an
 * upgrade's existing library file first, so a failed or interrupted copy destroyed it. */
async function copyIntoPlace(src: string, dest: string, tempNameFor = dest): Promise<void> {
  // `tempNameFor`: the library file this copy is on its way to, when `dest` is only a staging name
  // beside it (placeOverRecycledFile) — a retry then knows the temp of a killed attempt for its own.
  await removeStaleImportTemps(path.dirname(dest), tempNameFor);
  const tmp = tempPathNextTo(tempNameFor);
  activeTemps.add(path.resolve(tmp));
  try {
    await fsp.copyFile(src, tmp);
    // Read-only: the copy keeps the source's mode, which may not allow writing (a read-only mount).
    const handle = await fsp.open(tmp, "r");
    try {
      await handle.sync();
    } catch (err: any) {
      // Only a failed write-back matters; a handle or filesystem that can't fsync still gets the rename.
      if (err.code === "EIO" || err.code === "ENOSPC" || err.code === "EDQUOT") throw err;
    } finally {
      await handle.close();
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  } finally {
    activeTemps.delete(path.resolve(tmp));
  }
}

/** Puts `src` at `dest` in place of the library file already there, which goes to the recycle bin.
 * The new file is complete beside dest before the old one is recycled, and the "move" strategy gives
 * up the source only once the swap is done: a failed copy, a recycle bin that can't take the old
 * file, or a restart part-way leaves both the download and the library file where they were. */
async function placeOverRecycledFile(src: string, dest: string, item: { id: number; type: MediaType; title: string }): Promise<void> {
  const strategy = currentImportStrategy();
  // What an earlier attempt at this file left beside it when it was killed mid-copy.
  await removeStaleImportTemps(path.dirname(dest), dest);
  const staged = tempPathNextTo(dest);
  activeTemps.add(path.resolve(staged));
  try {
    if (strategy === "symlink") {
      await moveFile(src, staged);
    } else {
      let linked = false;
      if (strategy !== "copy") {
        try {
          fs.linkSync(src, staged);
          linked = true;
        } catch {
          // another filesystem: copied below
        }
      }
      if (!linked) await copyIntoPlace(src, staged, dest);
      applyConfiguredPermissions(staged, false);
    }
    if (!(await recycleFile(dest, item.type, item.title, item.id))) {
      throw new ImportSkippedError(`"${dest}" already exists and couldn't be moved to the recycle bin — not replacing it`);
    }
    fs.renameSync(staged, dest);
  } catch (err) {
    removeQuietly(staged);
    throw err;
  } finally {
    activeTemps.delete(path.resolve(staged));
  }
  log.info(`[importer] recycled "${dest}" to replace it with a newer file for "${item.title}"`);
  if (strategyDeletesSourceData()) {
    try {
      fs.unlinkSync(src);
    } catch (err) {
      log.warn(`[importer] placed "${dest}" but couldn't remove its source "${src}":`, (err as Error).message);
    }
  }
}

/** The topmost folder on the way to `dir` that doesn't exist yet (what creating `dir` will add). */
function firstMissingAncestor(dir: string): string | null {
  let missing: string | null = null;
  for (let current = path.resolve(dir); !fs.existsSync(current); ) {
    missing = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

/** Removes the folders an import that then failed created, deepest first, as far as they are empty. */
function removeCreatedFolders(dir: string, firstCreated: string | null): void {
  if (!firstCreated) return;
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    try {
      fs.rmdirSync(current);
    } catch {
      return; // not empty, or not there
    }
    if (current === firstCreated || path.dirname(current) === current) return;
  }
}

/**
 * Puts `src` at `dest` without ever destroying what is already there. Nothing there: the plain move.
 * The library file one of this import's own rows points at (`ownPaths`: an upgrade onto the same path),
 * or a leftover copy of this very file (same size, from an import a restart cut off before the row was
 * written): the new file is staged beside it and the old one goes to the recycle bin first
 * (placeOverRecycledFile), so nothing is lost if the bin can't take it. Anything else, a file no row
 * tracks: refused, left for the admin. The folders a refused or failed placement created are removed
 * again, so it doesn't leave an empty season folder behind.
 */
async function placeAtDestination(
  src: string,
  dest: string,
  item: { id: number; type: MediaType; title: string },
  ownPaths: (string | null | undefined)[]
): Promise<void> {
  const destDir = path.dirname(dest);
  const createdFrom = firstMissingAncestor(destDir);
  try {
    const verdict = destinationVerdict(src, dest, ownPaths);
    if (verdict === "refuse") throw new ImportSkippedError(destinationRefusedMessage(dest));
    if (verdict === "replace") await placeOverRecycledFile(src, dest, item);
    else await moveFile(src, dest);
  } catch (err) {
    removeCreatedFolders(destDir, createdFrom);
    throw err;
  }
}

/** What placing `src` at `dest` would do to what is there: "free" (nothing there, the very same
 * file, or a link whose target is gone, an expired debrid mount: nothing to lose, and the plain move
 * replaces a dangling link as it always did), "replace" (the library file one of the import's own rows
 * points at, or a same-size leftover copy of this very file: it goes through the recycle bin), or
 * "refuse" (a file no row tracks). A multi-file import asks for every file before it moves any. */
function destinationVerdict(src: string, dest: string, ownPaths: (string | null | undefined)[]): "free" | "replace" | "refuse" {
  let existing: fs.Stats;
  try {
    existing = fs.lstatSync(dest);
  } catch {
    return "free";
  }
  if (isSameFile(src, dest) || (existing.isSymbolicLink() && !fs.existsSync(dest))) return "free";
  if (ownPaths.some((p) => !!p && isSameFile(p, dest))) return "replace";
  if (existing.isFile()) {
    try {
      if (fs.statSync(src).size === existing.size) return "replace";
    } catch {
      // the source is gone: nothing to compare
    }
  }
  return "refuse";
}

function destinationRefusedMessage(dest: string): string {
  return `"${dest}" already exists and no library entry tracks it — not overwriting it. Scan the library to link it, or move it away, then retry the import.`;
}

function isSameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** mkdir -p that gives every folder it creates the configured permissions, not just the deepest
 * one — a new show's own folder above "Season 01" otherwise kept the umask default, and other apps
 * in the shared group couldn't write artwork or NFOs into it. */
export function makeLibraryDirectory(dir: string): void {
  const firstCreated = fs.mkdirSync(dir, { recursive: true });
  if (!firstCreated) return;
  const stopAt = path.resolve(firstCreated);
  const created: string[] = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    created.unshift(current);
    if (current === stopAt || path.dirname(current) === current) break;
  }
  for (const folder of created) applyConfiguredPermissions(folder, true);
}

/**
 * Recycles the library files an import just superseded. An upgrade whose destination differs from
 * the old file's path (an episode title filled in, .mp4 replaced by .mkv, naming disabled) otherwise
 * leaves the old file behind, untracked, next to the new one. `keepPaths` are this import's own
 * sources and destinations; a path still referenced by any row (the other half of a multi-episode
 * file) or that is the same file as one of them (a case-insensitive filesystem) is left alone.
 * Never throws — the import itself has already succeeded.
 */
async function recycleReplacedFiles(
  oldPaths: (string | null | undefined)[],
  keepPaths: string[],
  item: { id: number; type: MediaType; title: string }
): Promise<void> {
  const keep = new Set(keepPaths.map((p) => path.resolve(p)));
  const keepInodes = new Set<string>();
  for (const p of keepPaths) {
    try {
      const st = fs.lstatSync(p);
      keepInodes.add(`${st.dev}:${st.ino}`);
    } catch {
      // moved away already
    }
  }
  for (const oldPath of new Set(oldPaths)) {
    if (!oldPath || keep.has(path.resolve(oldPath))) continue;
    try {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(oldPath);
      } catch {
        continue; // already gone
      }
      if (st.isDirectory() || keepInodes.has(`${st.dev}:${st.ino}`)) continue;
      const refs = (await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM media_items WHERE path = ?) + (SELECT COUNT(*) FROM episodes WHERE file_path = ?)
                + (SELECT COUNT(*) FROM sub_items WHERE file_path = ?) + (SELECT COUNT(*) FROM tracks WHERE file_path = ?) AS c`
        )
        .get(oldPath, oldPath, oldPath, oldPath)) as { c: number | string };
      if (Number(refs.c) > 0) continue;
      if (await recycleFile(oldPath, item.type, item.title, item.id)) {
        log.info(`[importer] recycled replaced file "${oldPath}" for "${item.title}"`);
      } else {
        // The bin could not take it (full or unwritable): the old file stays beside the new one, untracked.
        log.warn(`[importer] couldn't move the replaced file "${oldPath}" to the recycle bin; it was left beside the new one for "${item.title}"`);
      }
    } catch (err) {
      log.warn(`[importer] failed to recycle replaced file "${oldPath}":`, (err as Error).message);
    }
  }
}

/** True when `filePath` is the current file of a library row other than the ones an import is
 * writing — two items or children whose names render the same path (duplicate video titles, one
 * ROM's two platforms) otherwise overwrote each other, leaving both rows on one file. The
 * sub-item's own tracks count as its own rows (an album re-import). */
async function isFileOfAnotherRow(filePath: string, itemId: number, ownEpisodeIds: number[], ownSubItemId: number | null): Promise<boolean> {
  const episodeIds = ownEpisodeIds.length > 0 ? ownEpisodeIds : [-1];
  const row = (await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM media_items WHERE path = ? AND has_file = 1 AND id <> ?)
            + (SELECT COUNT(*) FROM episodes WHERE file_path = ? AND has_file = 1 AND id NOT IN (${episodeIds.map(() => "?").join(",")}))
            + (SELECT COUNT(*) FROM sub_items WHERE file_path = ? AND has_file = 1 AND id <> ?)
            + (SELECT COUNT(*) FROM tracks WHERE file_path = ? AND has_file = 1 AND sub_item_id <> ?) AS c`
    )
    .get(filePath, itemId, filePath, ...episodeIds, filePath, ownSubItemId ?? -1, filePath, ownSubItemId ?? -1)) as { c: number | string };
  return Number(row.c) > 0;
}

function anotherEntrysFileMessage(destPath: string): string {
  return `"${destPath}" is already another library entry's file — not overwriting it; rename one of them so their file names differ.`;
}

/** Where a single-file collection child's file may go, most preferred first: its rendered path,
 * then — same-titled children (a podcast's bonus episodes, a channel's trailers) render one path,
 * and a collection template has no token to tell them apart — that path with the child's date,
 * then with its id. */
function collectionChildDestinations(
  rootFolderPath: string,
  template: string,
  parentTitle: string,
  child: { id: number; title: string; release_date?: string | null },
  quality: string | null,
  ext: string,
  sourceFile: string,
  namingEnabled: boolean,
  providerVars: Record<string, string> = {}
): { destPath: string; fileLabel: string }[] {
  const render = (suffix: string) =>
    resolveDest(
      rootFolderPath,
      renderPathSegments(template, { parentTitle, childTitle: `${child.title}${suffix}`, quality: quality ?? "", ...providerVars }, ext),
      ext,
      sourceFile,
      namingEnabled
    );
  const plain = render("");
  const date = /^\d{4}(?:-\d{2}(?:-\d{2})?)?/.exec(String(child.release_date ?? "").trim())?.[0];
  const fallbacks = [...(date ? [` (${date})`] : []), ` [${child.id}]`].map((suffix) => {
    const candidate = render(suffix);
    if (path.resolve(candidate.destPath) !== path.resolve(plain.destPath)) return candidate;
    // Naming disabled, or a template without {childTitle}: the title never reaches the path, so the
    // suffix goes on the file's own name instead.
    const fileLabel = `${safePathSegment(path.basename(plain.fileLabel, ext) + suffix, true)}${ext}`;
    return { destPath: path.join(path.dirname(plain.destPath), fileLabel), fileLabel };
  });
  return [plain, ...fallbacks];
}

/** True when `folder` is the stored folder of another multi-file child (an album, an audiobook). */
async function isFolderOfAnotherChild(folder: string, ownSubItemId: number): Promise<boolean> {
  const row = (await db
    .prepare("SELECT COUNT(*) AS c FROM sub_items WHERE file_path = ? AND has_file = 1 AND id <> ?")
    .get(folder, ownSubItemId)) as { c: number | string };
  return Number(row.c) > 0;
}

/** A show/artist/author has a file once any of its children does. Left to the daily library scan,
 * a show whose episodes all downloaded today still read as having no file — listed by Cleanup's
 * "unmonitored with no file" (whose Delete all removes it) and missing from stats until 05:00. */
async function markParentHasFile(itemId: number): Promise<void> {
  await db.prepare("UPDATE media_items SET has_file = 1 WHERE id = ? AND has_file = 0").run(itemId);
}

/** Whether a file of `quality` may replace a child's existing file of `existingQuality`: only a
 * strictly better-ranked quality, the same bar the search side holds an upgrade grab to, and never
 * for a type with no quality tiers to upgrade by. */
function isQualityUpgrade(
  type: MediaType,
  quality: string | null,
  existingQuality: string | null,
  newTitle?: string | null,
  existingTitle?: string | null,
  groups?: QualityGroups
): boolean {
  if (!usesQualityTiers(type)) return false;
  // Qualities the profile treats as one tier rank alike.
  if (groupedRank(quality, groups) > groupedRank(existingQuality, groups)) return true;
  // The same quality: a later revision of the file's own release (a REPACK of its group, a PROPER) replaces it.
  return groupedRank(quality, groups) === groupedRank(existingQuality, groups) && !!newTitle && revisionUpgrade(propersMode(), existingTitle ?? null, newTitle);
}

/** The groups of qualities the item's profile treats as one tier. */
async function qualityGroupsOfProfile(profileId: number | null | undefined): Promise<QualityGroups> {
  if (!profileId) return [];
  const row = (await db.prepare("SELECT quality_groups FROM quality_profiles WHERE id = ?").get(profileId)) as { quality_groups: string | null } | undefined;
  return parseQualityGroups(row?.quality_groups);
}

export class ImportSkippedError extends Error {}

/** The release itself is at fault: nothing importable in the folder the client reported, or no file of
 * it found at all. The only import failure that fails the download, blocklists the release and grabs
 * another (scheduler.ts importCompletedDownload); every other error leaves the completed download for a
 * manual import. */
export class ReleaseFaultError extends Error {}

/** Whether the downloads folder shows anything at all: false for an unmounted share or an unreadable folder. */
export function downloadsFolderHasEntries(): boolean {
  try {
    return fs.readdirSync(config.downloadsDir).length > 0;
  } catch {
    return false;
  }
}

/** Whether there is any file under `dir` (a few levels down): false for a missing, empty or unreadable folder. */
function folderHasAnyFile(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const visit = (d: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) return true;
      if (depth < 4 && visit(path.join(d, entry.name), depth + 1)) return true;
    }
    return false;
  };
  try {
    return fs.statSync(dir).isFile() || visit(dir, 0);
  } catch {
    return false;
  }
}

/** The resolution tier (480, 720, 1080, 2160) a quality name stands for, or null for a name that gives none. */
export function resolutionOfQualityName(name: string | null): number | null {
  if (!name) return null;
  const match = /(\d{3,4})p/i.exec(name);
  if (match) {
    const lines = Number(match[1]);
    return lines >= 2000 ? 2160 : lines >= 1000 ? 1080 : lines >= 700 ? 720 : 480;
  }
  return /\b(dvd|sdtv)\b/i.test(name) ? 480 : null;
}

/** The resolution tier a video's frame size stands for (a widescreen 1080p film is 1920x800, so the width counts too). */
export function resolutionOfFrame(width: number | null, height: number | null): number | null {
  if (!width && !height) return null;
  if ((width ?? 0) >= 3000 || (height ?? 0) >= 2000) return 2160;
  if ((width ?? 0) >= 1800 || (height ?? 0) >= 1000) return 1080;
  if ((width ?? 0) >= 1200 || (height ?? 0) >= 700) return 720;
  return 480;
}

/** Whether the file's own frame size is a higher resolution than the quality `existing` names. False when either is unknown. */
async function probedResolutionBeats(sourceFile: string, existingQuality: string | null): Promise<boolean> {
  const have = resolutionOfQualityName(existingQuality);
  if (have === null || !isProbeableFile(sourceFile)) return false;
  try {
    const info = await probeMediaInfo(sourceFile);
    const found = info ? resolutionOfFrame(info.width, info.height) : null;
    return found !== null && found > have;
  } catch {
    return false;
  }
}

/**
 * Sonarr/Radarr's import-time "not an upgrade" check, as far as a downgrade goes: an automatic import
 * must not put a file of a worse quality over a better one the library already has. The grab-time
 * rules are the first line, but a second grab in flight for the same target, a profile edited since,
 * or a slow older download finishing last would otherwise replace a Remux with a 720p copy. The same
 * quality is allowed (a repair, a repack, a retry); so is a file the library no longer has on disk.
 * A type without quality tiers compares the file format instead (an epub over a pdf, flac over mp3).
 */
async function assertNotADowngrade(
  type: MediaType,
  quality: string | null,
  sourceFile: string,
  existing: { quality: string | null; filePath: string | null }[],
  groups: QualityGroups
): Promise<void> {
  for (const file of existing) {
    if (!file.filePath || !fs.existsSync(file.filePath)) continue;
    if (usesQualityTiers(type)) {
      const have = groupedRank(file.quality, groups);
      if (have >= 0 && groupedRank(quality, groups) < have) {
        // A release name with no quality in it (rank below every tier) is refused over a known one, unless the file
        // itself shows a higher resolution than the library's: that much is an upgrade whatever the source was.
        if (groupedRank(quality, groups) < 0 && (await probedResolutionBeats(sourceFile, file.quality))) continue;
        throw new ImportSkippedError(
          `Not an upgrade: the library already has a "${file.quality}" file here and this download is "${quality ?? "unknown"}" — left in the download for a manual import`
        );
      }
    } else {
      const have = formatRank(file.filePath);
      if (have > 0 && formatRank(sourceFile) > have) {
        throw new ImportSkippedError(
          `Not an upgrade: this download is a "${path.extname(sourceFile)}" file and the library already has the better "${path.extname(file.filePath)}" — left in the download for a manual import`
        );
      }
    }
  }
}

/** The file found for a download plainly belongs to another title (or another year of this one):
 * left in the download for a manual import, never placed under the item. A subclass of
 * ImportSkippedError so every caller's "left for manual import" handling applies unchanged. */
export class ImportIdentityMismatchError extends ImportSkippedError {}

function identityTargetOf(item: { type: string; title: string; year: number | null; externalIds: string | null }): IdentityTarget {
  let externalIds: Record<string, string> = {};
  try {
    externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
  } catch {
    externalIds = {};
  }
  return { type: item.type, title: item.title, year: item.year, externalIds };
}

/** The gate's target for a file downloaded for this very item. The grab already applied the rule that
 * a name with no year belongs to the older of two shows of one title, so a yearless file name is not
 * refused again here; a wrong year still is. */
async function importTargetFor(item: { id: number; type: string; title: string; year: number | null; externalIds: string | null }): Promise<IdentityTarget> {
  return { ...(await identityTargetFor(item)), hasEarlierSameTitle: false };
}

/**
 * Whether a file about to be placed under `item` is evidently another title's (MATCHING_ACCURACY_
 * PLAN.md, Round 2): the file's own name, or its release folder's when the name says nothing, is
 * parsed like a release and put through the identity gate. Only positive evidence counts — a title of
 * two or more words that doesn't name the item, or a title that does with a year more than one off —
 * so an obfuscated name ("a8f7d6c1.mkv") or a bare "Show.S01E05" passes. Respects the type's
 * `strictReleaseIdentity` mode: null for `off`, logged but null for `log`, the reason for `enforce`.
 * Quality-tiered (video) types only, like the grab-time gate.
 */
export function fileContradictsTarget(sourceFile: string, ctx: DownloadContext, item: IdentityTarget): string | null {
  if (!usesQualityTiers(item.type)) return null;
  const mode = identityModeFor(item.type);
  if (mode === "off") return null;

  const base = withoutGroupPrefix(withoutVersionTag(path.basename(sourceFile, path.extname(sourceFile))), ctx.releaseTitle);
  // Only a name shaped like a release (numbering or a year) says which title it is; "Episode 2 -
  // Cat's in the Bag" or "Pilot" says nothing, and is judged by its folder instead.
  const releaseShaped = (parsed: ParsedRelease) =>
    parsed.seasonNumber != null || !!parsed.episodeNumbers?.length || parsed.absoluteEpisode != null || !!parsed.airDate || parsed.titleYear != null;
  let matched = false;
  const judge = (name: string, what: string): string | null => {
    const parsed = parseReleaseTitle(name);
    const words = identityKey(parsed.title).split(" ").filter(Boolean).length;
    const verdict = releaseIdentifiesTarget({ title: name }, parsed, item);
    if (verdict.ok) {
      matched = true;
      return null;
    }
    // A short or unreadable title is no evidence; a wrong year on a matching title is.
    if (verdict.reason === "title" && words < 2) return null;
    return `${what} "${name}" ${verdict.detail}`;
  };
  const fileParsed = parseReleaseTitle(base);
  const fileSaysSomething = releaseShaped(fileParsed);
  let reason = fileSaysSomething ? judge(base, "file") : null;
  if (reason === null && !matched && (!fileSaysSomething || identityKey(fileParsed.title).split(" ").filter(Boolean).length < 2)) {
    // The file name says little ("a8f7d6c1", "E05", an episode title alone); the folder it came in
    // may say more — the client-reported folder when the file is inside it, else the file's own.
    // Only a folder named like a release is read: a save or category folder ("tv", "UHD HDR",
    // "Complete 1080p") names no title, and a "Season 1" folder is looked past to its parent.
    const src = path.resolve(sourceFile);
    const reported = ctx.downloadPath ? path.resolve(ctx.downloadPath) : null;
    let folder = reported && src.startsWith(reported + path.sep) && isDirectory(reported) ? reported : path.dirname(src);
    const category = ctx.category?.trim().toLowerCase().split(/[\\/]/).filter(Boolean).pop() || null;
    const stop = (dir: string) => dir === path.resolve(config.downloadsDir) || path.basename(dir).toLowerCase() === category || path.dirname(dir) === dir;
    const seasonOnly = (dir: string) => {
      const parsed = parseReleaseTitle(path.basename(dir));
      return parsed.isFullSeason && identityKey(parsed.title).split(" ").filter((t) => t && !/^(?:season|seasons|s|complete|\d+)$/.test(t)).length === 0;
    };
    if (!stop(folder) && seasonOnly(folder) && !stop(path.dirname(folder))) folder = path.dirname(folder);
    if (!stop(folder) && releaseShaped(parseReleaseTitle(path.basename(folder)))) reason = judge(path.basename(folder), "folder");
  }
  if (reason === null) return null;
  if (mode === "log") {
    log.info(`[importer] identity gate (log-only) would refuse ${reason} for "${item.title}"`);
    return null;
  }
  return reason;
}

/** Radarr's "Create empty series folders" — opt-in, creates just the item's own top-level library
 * folder (not any season/episode subfolders, which only make sense once real files start arriving)
 * as soon as it's added, instead of the folder only coming into existence on first import. Never
 * throws — a failed mkdir here (permissions, a stale mount) shouldn't fail adding the item itself,
 * the same "best effort, log and move on" contract every other filesystem side-effect in this file
 * follows. */
export function createLibraryFolderSkeleton(
  item: { type: MediaType; title: string; year: number | null; externalIds?: string | null },
  rootFolderPath: string
): void {
  try {
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      title: item.title,
      parentTitle: item.title,
      year: item.year ?? "",
      quality: "",
      ...titleVars("", item.title, item.year),
      ...titleVars("parent", item.title, item.year),
      ...providerIdVars({ type: item.type, externalIds: item.externalIds ?? null }),
    });
    if (segments.length === 0) return;
    const folder = path.join(rootFolderPath, segments[0]);
    assertInsideRoot(rootFolderPath, folder);
    makeLibraryDirectory(folder);
  } catch (err) {
    log.warn(`[importer] failed to create a library folder for "${item.title}":`, (err as Error).message);
  }
}

type EpisodeTarget =
  | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null; sceneIndex?: SceneIndex }
  | { airDate: string };

function parsedMatchesTarget(parsed: ReturnType<typeof parseReleaseTitle>, target: EpisodeTarget): boolean {
  return "airDate" in target
    ? releaseMatchesAirDate(parsed, target.airDate)
    : releaseMatchesEpisode(parsed, target.season, target.episode, target.sceneSeason, target.sceneEpisode, target.absoluteEpisode, target.sceneIndex);
}

/** Whether a file's own name (no folder, no extension) names this episode — not merely its season,
 * which every file of a season pack named "Show.S01" would pass. */
function nameIdentifiesEpisode(name: string, target: EpisodeTarget): boolean {
  const parsed = parseReleaseTitle(withoutVersionTag(name));
  return !parsed.isFullSeason && parsedMatchesTarget(parsed, target);
}

// A fansub re-release's version tag ("Show - 01v2", "01v2") hides its episode number from the parser.
const VERSION_TAG = /(^|[\s._\-e])(\d{1,4})v\d(?=$|[\s._\-()[\]])/i;

function withoutVersionTag(name: string): string {
  return name.replace(VERSION_TAG, "$1$2");
}

/** A scene file is often named "<group>-<title>" ("sparks-heat.1080p", "grp-24.s01e03"): with the
 * release's own group in front, the rest is the file's real name. */
function withoutGroupPrefix(name: string, releaseTitle: string | undefined): string {
  const group = releaseTitle ? parseReleaseTitle(releaseTitle).releaseGroup?.toLowerCase() : null;
  const m = /^([a-z0-9]+)-(.+)$/i.exec(name);
  return group && m && m[1].toLowerCase() === group ? m[2] : name;
}

/**
 * Moves a source file into the right root-folder location for a media item (and, for episodic/
 * collection types, its specific episode/sub-item), updates the DB, and notifies. Shared by both
 * the automatic post-download importer and the manual import endpoint. Handles "single" shape
 * (whole item is one file) and "collection" shape with a single file per child (Books, Comics,
 * Online Videos, Courses). A file for a child of a multi-file type (a Music album, an audiobook) is
 * placed into that child's folder by `placeAlbumFiles`, as that one file alone. The shape is the
 * row's effective one: a not-yet-converted legacy_shape row is still placed the way it's stored.
 */
export async function placeFile(params: {
  itemId: number;
  episodeId: number | null;
  subItemId: number | null;
  sourceFile: string;
  quality: string | null;
  /** Shared by every placeFile call of one multi-file import, which records the rows each placed
   * file went to. A later file for a row an earlier one already filled is refused: the row is its
   * own, so nothing else stops a same-episode "*.sample.mkv" checked alongside the real file from
   * replacing it moments after it landed. */
  batchClaims?: Set<string>;
  /** The download this file came from, when the import is automatic: the file is checked against
   * the item's identity before it is placed (fileContradictsTarget). A manual import, where the
   * admin chose the file, passes nothing and is never refused on identity. */
  verify?: DownloadContext;
  /** The release the file came from, kept on the row for the upgrade rules (fileRelease.ts); absent for a manual import. */
  releaseTitle?: string;
  /** An automatic import (not a manual one, nor a release the admin picked from the interactive search):
   * a file of a worse quality is refused rather than put over a better one the library already has. */
  refuseDowngrade?: boolean;
  /** Works out where the file would go and refuses what the import would refuse, but places nothing and writes nothing. */
  dryRun?: boolean;
}): Promise<{ destPath: string; fileLabel: string }> {
  const { itemId, episodeId, subItemId, sourceFile, quality, batchClaims, verify, releaseTitle, refuseDowngrade, dryRun } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);

  if (shape === "collection" && typeConfig.multiFilePerChild && subItemId) {
    if (dryRun) throw new Error("The destination of a track is decided when its album is imported");
    const placed = await placeAlbumFiles({ itemId, subItemId, anchorFile: sourceFile, quality, onlyAnchor: true, batchClaims });
    if (!placed.anchorDest) throw new ImportSkippedError(`"${path.basename(sourceFile)}" could not be placed`);
    return { destPath: placed.anchorDest, fileLabel: path.basename(placed.anchorDest) };
  }

  if (!item.rootFolderId) {
    throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  }
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);
  await assertRootFolderMounted(rootFolder);
  const template = namingTemplateFor(item);

  const ext = path.extname(sourceFile);
  let destPath: string;
  let fileLabel: string;
  // Distinguishes a first-time import from a replace of a file the item already had, so the
  // right notification event fires (notifyImported vs. Radarr/Sonarr's "On Upgrade").
  let hadFileBefore = shape === "single" && !!item.hasFile;
  // Populated only for the episodic branch below when the real filename covers more than the one
  // episode this import was queued against (e.g. a multi-episode release) — every row here gets
  // the same file info written and its own history entry, not just the originally-queued episode.
  let episodicRows: { id: number }[] | null = null;
  // Library files the rows being written pointed at before this import (an upgrade's old file).
  let replacedPaths: (string | null)[] = [];
  // Set once a branch below has already checked its destination against other rows' files.
  let destChecked = false;
  // The files this import would replace, for the downgrade check (refuseDowngrade).
  let existingFiles: { quality: string | null; filePath: string | null }[] = [];
  // The rendered path of an episodic file: its first segment is the show's folder, remembered once the file is in.
  let folderSegments: string[] | null = null;
  // The day the file is dated by when `fileDate` is set: the episode's air date, or a film's release date.
  let fileDay: string | null = null;

  if (shape === "single") {
    if (item.hasFile) {
      replacedPaths = [item.path];
      existingFiles = [{ quality: item.quality ?? null, filePath: item.path ?? null }];
    }
    fileDay = item.releaseDate ?? null;
    const segments = renderPathSegments(
      template,
      { title: item.title, year: item.year ?? "", quality: quality ?? "", ...titleVars("", item.title, item.year), ...releaseVars(releaseTitle, quality), ...providerIdVars(item) },
      ext
    );
    ({ destPath, fileLabel } = resolveDest(rootFolder.path, segments, ext, sourceFile, getNamingEnabled(item.type)));
  } else if (shape === "episodic" && episodeId) {
    const epRow = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
    if (!epRow) throw new Error(`Episode ${episodeId} not found`);
    hadFileBefore = !!epRow.has_file;

    // The file that actually landed may legitimately cover more than the one episode this import
    // was searched for (e.g. a multi-episode release like "S01E01-E02.mkv") — detect any
    // additional same-season episodes the real filename covers so they get marked Downloaded too,
    // not just the episode this import was originally queued against.
    const detected = detectSeasonEpisode(path.basename(path.dirname(sourceFile)), path.basename(sourceFile, ext));
    // A scene-numbered (TheXEM) release is imported for its TVDB episode under the scene number, so
    // the filename's numbers are TVDB numbers only when they include the target's own; when they
    // include its scene number instead, the extra ones are scene numbers too. Treating a scene
    // "S01E14" as a sibling of TVDB E13 marked TVDB E14 downloaded with E13's file.
    let siblingEpRows: any[] = [];
    if (detected.season === epRow.season_number && detected.episodes.includes(epRow.episode_number)) {
      const others = detected.episodes.filter((n) => n !== epRow.episode_number);
      if (others.length > 0) {
        siblingEpRows = (await db
          .prepare(
            `SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number IN (${others.map(() => "?").join(",")})`
          )
          .all(epRow.media_item_id, epRow.season_number, ...others)) as any[];
      }
    } else if (
      epRow.scene_season_number != null &&
      detected.season === epRow.scene_season_number &&
      detected.episodes.includes(epRow.scene_episode_number)
    ) {
      const others = detected.episodes.filter((n) => n !== epRow.scene_episode_number);
      if (others.length > 0) {
        siblingEpRows = (await db
          .prepare(
            `SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ? AND scene_season_number = ?
             AND scene_episode_number IN (${others.map(() => "?").join(",")})`
          )
          .all(epRow.media_item_id, epRow.season_number, epRow.scene_season_number, ...others)) as any[];
      }
    }
    // An episode an earlier file of the same import already filled keeps that file: a file mapped to
    // it is refused, and one only also covering it is placed for its other episodes alone — those on
    // its own side of the filled one, since the name renders them as one unbroken range.
    if (batchClaims) {
      if (batchClaims.has(`episode:${epRow.id}`)) {
        const code = `S${String(epRow.season_number).padStart(2, "0")}E${String(epRow.episode_number).padStart(2, "0")}`;
        throw new ImportSkippedError(`${code} already got a file from this import — not replacing it with "${path.basename(sourceFile)}"`);
      }
      const claimed = siblingEpRows.filter((e) => batchClaims.has(`episode:${e.id}`)).map((e) => Number(e.episode_number));
      const target = Number(epRow.episode_number);
      const claimedBelow = Math.max(-Infinity, ...claimed.filter((n) => n < target));
      const claimedAbove = Math.min(Infinity, ...claimed.filter((n) => n > target));
      siblingEpRows = siblingEpRows.filter((e) => Number(e.episode_number) > claimedBelow && Number(e.episode_number) < claimedAbove);
    }
    const allEpRows = [epRow, ...siblingEpRows];
    if (allEpRows.length > 1) episodicRows = allEpRows.map((e) => ({ id: e.id }));
    replacedPaths = allEpRows.filter((e: any) => e.has_file).map((e: any) => e.file_path);
    existingFiles = allEpRows.filter((e: any) => e.has_file).map((e: any) => ({ quality: e.quality ?? null, filePath: e.file_path ?? null }));
    const primaryEpisodeNumber = Math.min(...allEpRows.map((e: any) => e.episode_number));
    const primaryEpRow = allEpRows.find((e: any) => e.episode_number === primaryEpisodeNumber);

    // Running count across every season up to and including this episode — what anime naming
    // conventions call "absolute" numbering (e.g. episode 26 instead of S02E01), as an
    // alternative to {season}/{episode} in a custom naming template.
    // Season 0 (specials) is excluded from the running count — absolute numbering conventions
    // (AniDB, TVDB's absolute order, most anime release groups) start from season 1's episode 1,
    // not from whatever specials happen to sort before it.
    const absoluteEpisode = Number(
      (
        (await db
          .prepare(
            `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
           AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
          )
          .get(epRow.media_item_id, epRow.season_number, epRow.season_number, primaryEpisodeNumber)) as { c: number }
      ).c
    );
    // An existing file that covers more episodes than this one is not replaced by it (Sonarr's SameEpisodesImportSpecification):
    // a two-parter would end up shared between a single-episode file and a stale row. Left for a manual import.
    if (refuseDowngrade) {
      const ownIds = new Set(allEpRows.map((e: any) => Number(e.id)));
      for (const existingPath of new Set(replacedPaths.filter((p): p is string => !!p))) {
        const sharers = (await db.prepare("SELECT id FROM episodes WHERE media_item_id = ? AND file_path = ?").all(item.id, existingPath)) as { id: number }[];
        if (sharers.some((s) => !ownIds.has(Number(s.id)))) {
          throw new ImportSkippedError(
            `The file already on disk ("${path.basename(existingPath)}") covers more episodes than this download — left in the download for a manual import`
          );
        }
      }
    }
    const placedFolder = await withItemFolder(
      item,
      rootFolder.path,
      renderPathSegments(
        template,
        episodicNameVars(item, {
          season: epRow.season_number,
          numbers: allEpRows.map((e: any) => Number(e.episode_number)),
          absoluteEpisode,
          airDate: primaryEpRow.air_date ?? null,
          episodeTitle: primaryEpRow.title ?? null,
          quality,
          releaseTitle,
        }),
        ext
      ),
      template
    );
    const segments = placedFolder.segments;
    ({ destPath, fileLabel } = resolveDest(rootFolder.path, segments, ext, sourceFile, getNamingEnabled(item.type)));
    folderSegments = segments.slice(0, placedFolder.folderLength);
    fileDay = primaryEpRow.air_date ?? null;
  } else if (shape === "collection" && subItemId) {
    const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
    if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);
    hadFileBefore = !!subRow.has_file;
    if (subRow.has_file) {
      replacedPaths = [subRow.file_path];
      existingFiles = [{ quality: subRow.quality ?? null, filePath: subRow.file_path ?? null }];
    }
    const candidates = collectionChildDestinations(
      rootFolder.path,
      template,
      item.title,
      subRow,
      quality,
      ext,
      sourceFile,
      getNamingEnabled(item.type),
      { ...titleVars("parent", item.title, item.year), ...providerIdVars(item) }
    );
    let free: { destPath: string; fileLabel: string } | null = null;
    for (const candidate of candidates) {
      if (!(await isFileOfAnotherRow(candidate.destPath, item.id, [], subItemId))) {
        free = candidate;
        break;
      }
    }
    if (!free) throw new ImportSkippedError(anotherEntrysFileMessage(candidates[0].destPath));
    ({ destPath, fileLabel } = free);
    destChecked = true;
  } else {
    throw new ImportSkippedError(
      `Don't know how to place a file for media type "${item.type}" without a linked episode/sub-item`
    );
  }

  const ownEpisodeIds = episodeId ? (episodicRows ?? [{ id: episodeId }]).map((r) => r.id) : [];
  if (!destChecked && (await isFileOfAnotherRow(destPath, item.id, ownEpisodeIds, subItemId))) {
    throw new ImportSkippedError(anotherEntrysFileMessage(destPath));
  }
  if (verify) {
    const mismatch = fileContradictsTarget(sourceFile, verify, await importTargetFor(item));
    if (mismatch) throw new ImportIdentityMismatchError(`Not importing: ${mismatch} — left in the download for a manual import`);
    await assertFileIsWorthImporting(sourceFile, item.type, mediaRow.runtime_minutes, verify, shape === "single" || shape === "episodic");
  }
  if (refuseDowngrade) await assertNotADowngrade(item.type, quality, sourceFile, existingFiles, await qualityGroupsOfProfile(item.qualityProfileId));
  const claimKeys =
    shape === "single" ? [`item:${item.id}`] : episodeId ? ownEpisodeIds.map((id) => `episode:${id}`) : [`sub:${subItemId}`];
  if (batchClaims && claimKeys.some((key) => batchClaims.has(key))) {
    throw new ImportSkippedError(`Another file in this import was already placed for "${fileLabel}" — not replacing it with "${path.basename(sourceFile)}"`);
  }

  if (dryRun) return { destPath, fileLabel };

  // Radarr's "Skip Free Space Check" — on by default (i.e. the check runs), refuses an import that
  // would leave the destination filesystem with less free space than the file being placed, rather
  // than silently filling a small library drive to zero. `move` frees the source file's own space
  // back as part of the same operation on same-filesystem moves, but that can't be assumed here
  // (cross-filesystem move falls back to copy+delete, and hardlink/symlink never free anything) so
  // this stays conservative and checks against the file's full size either way.
  if (getSetting("skipFreeSpaceCheck") !== "1") {
    try {
      const sourceSize = (await statAsync(sourceFile)).size;
      const stat = await statfsAsync(rootFolder.path);
      if (!stat) throw new Error("the destination did not report its free space");
      // bavail, not bfree: the server runs unprivileged and can't write into root-reserved blocks.
      const freeBytes = stat.bavail * stat.bsize;
      // Plus the reserve (Sonarr's MinimumFreeSpaceWhenImporting, or the root folder's own minimum).
      const reserve = importReserveBytes(rootFolder.minFreeSpaceGb);
      if (freeBytes < sourceSize + reserve) {
        throw new ImportSkippedError(
          `Not enough free space at "${rootFolder.path}" (${Math.round(freeBytes / 1e9)}GB free, file is ${Math.round(sourceSize / 1e9)}GB${reserve > 0 ? `, ${Math.round(reserve / 1e6)}MB kept free` : ""}) — kept for a manual import from Activity`
        );
      }
    } catch (err) {
      if (err instanceof ImportSkippedError) throw err;
      // Can't stat the source/destination filesystem — don't block the import over that; the
      // move itself will surface a clearer filesystem error if something's actually wrong.
    }
  }

  // A disc game's sheet brings the tracks it names, under their own names (the sheet refers to them by name).
  const romTracks = item.type === "rom" ? romSetCompanions(sourceFile) : [];
  // The tracks keep their names, so one that is already there (another game's, in a shared folder) is never overwritten.
  for (const track of romTracks) {
    const target = path.join(path.dirname(destPath), path.basename(track));
    if (fs.existsSync(target)) {
      throw new ImportSkippedError(`"${target}" already exists — not overwriting it with a track of "${path.basename(sourceFile)}"`);
    }
  }
  await placeAtDestination(sourceFile, destPath, item, replacedPaths);
  for (const track of romTracks) await moveFile(track, path.join(path.dirname(destPath), path.basename(track)));
  for (const key of claimKeys) batchClaims?.add(key);

  // The row is written as soon as the file is in place. The slow, best-effort steps (a subtitle
  // provider, ffprobe, a comic conversion) used to run first, so a stalled provider or a restart
  // left a file in the library that its row did not know about; the retry then found no source file
  // and failed, blocklisting a good release. They run after the row, below.
  const sizeBytes = await fsp.stat(destPath).then((s) => s.size).catch(() => null);

  // The release and its score go on the row with the file: a later REPACK is judged against them.
  const record = await releaseRecordFor(item, releaseTitle, sizeBytes);
  if (shape === "single") {
    await db
      .prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = NULL, size_bytes = ?, file_release_title = ?, file_format_score = ? WHERE id = ?")
      .run(destPath, quality, sizeBytes, record.title, record.score, item.id);
  } else if (episodeId) {
    const rows = episodicRows ?? [{ id: episodeId }];
    for (const row of rows) {
      await db
        .prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = NULL, size_bytes = ?, file_release_title = ?, file_format_score = ? WHERE id = ?")
        .run(destPath, quality, sizeBytes, record.title, record.score, row.id);
    }
  } else if (subItemId) {
    await db
      .prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = ?, media_info = NULL, size_bytes = ?, file_release_title = ?, file_format_score = ? WHERE id = ?")
      .run(destPath, quality, sizeBytes, record.title, record.score, subItemId);
  }
  if (shape !== "single") await markParentHasFile(item.id);
  // The show's folder is the one its first file went to: a later title change keeps using it.
  if (folderSegments) await rememberItemFolder(item.id, folderSegments);
  // Not on a hardlink or symlink: the date would land on the seeding source too.
  if (currentImportStrategy() !== "hardlink" && currentImportStrategy() !== "symlink") await applyFileDate(destPath, fileDay);
  // The subtitles that came with the release (`importExtraFiles`), named for the file, before the release folder goes.
  if (VIDEO_EXTENSIONS.has(ext.toLowerCase()) && (shape === "single" || shape === "episodic")) {
    await copyReleaseExtras(sourceFile, destPath).catch((err) =>
      log.warn(`[importer] could not copy the extra files of "${path.basename(sourceFile)}":`, (err as Error).message)
    );
  }
  await recycleReplacedFiles(replacedPaths, [destPath, sourceFile], item);

  // episodeId/subItemId/quality are what duplicates.ts's repeated-import check groups on. One
  // history row per covered episode when a single file spans more than one (multi-episode release).
  const historyEpisodeIds = episodicRows ? episodicRows.map((r) => r.id) : [episodeId ?? null];
  for (const historyEpisodeId of historyEpisodeIds) {
    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
      item.id,
      importedHistoryData({ fileLabel, destPath, episodeId: historyEpisodeId, subItemId: subItemId ?? null, quality: quality ?? null })
    );
  }

  // Radarr's "Kodi (XBMC)/Emby" metadata consumer, off by default there too — an admin who wants
  // AoNarr to keep a Kodi/Jellyfin/Emby-readable .nfo sidecar next to every imported file opts in
  // explicitly. Only for "single" (Movies/ROMs/Adult) and single-file "collection" (Books/Comics/
  // Manga/Online Videos/Courses) shapes, which map onto one media-item-worth of metadata per file;
  // episodic and multi-file-per-child (Music) shapes need per-episode/per-track metadata this
  // function doesn't have on hand, so they're left to the existing on-edit sidecar write in
  // routes/media.ts instead of guessing at incomplete per-file metadata here.
  if (getSetting("writeNfoOnImport") === "1" && (shape === "single" || shape === "collection")) {
    let externalIds: Record<string, string> = {};
    try {
      externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
    } catch {
      // malformed external_ids on an old row — write the sidecar without unique ids rather than skip it
    }
    // keepRicher: a better copy replacing the file must not wipe an NFO another tool wrote beside it.
    writeNfoSidecar(destPath, { type: item.type, title: item.title, year: item.year, overview: item.overview, posterUrl: item.posterUrl, externalIds }, { keepRicher: true });
  }
  // The same opt-in for a show: Kodi's <episodedetails> beside the file, and the show's tvshow.nfo once.
  if (getSetting("writeNfoOnImport") === "1" && shape === "episodic" && episodeId) {
    const ids = (episodicRows ?? [{ id: episodeId }]).map((r) => r.id);
    const covered = (await db
      .prepare(`SELECT season_number, episode_number, title, air_date, overview FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY episode_number`)
      .all(...ids)) as { season_number: number; episode_number: number; title: string | null; air_date: string | null; overview: string | null }[];
    writeEpisodeNfoSidecar(
      destPath,
      covered.map((e) => ({ showTitle: item.title, title: e.title, season: Number(e.season_number), episode: Number(e.episode_number), aired: e.air_date, overview: e.overview }))
    );
    if (folderSegments && folderSegments.length >= 1) {
      let externalIds: Record<string, string> = {};
      try {
        externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
      } catch {
        // malformed external_ids on an old row — write the show's NFO without unique ids
      }
      writeTvShowNfoIfMissing(path.join(rootFolder.path, ...folderSegments), { type: item.type, title: item.title, year: item.year, overview: item.overview, posterUrl: item.posterUrl, externalIds });
    }
  }

  log.info(`[importer] imported "${fileLabel}" for "${item.title}"`);

  // Best effort from here: the import is recorded, and none of this can fail it. The notification (and the
  // media-server refresh it triggers) waits for it, so the server finds the subtitle and the converted file.
  try {
    if (VIDEO_EXTENSIONS.has(ext.toLowerCase()) && (shape === "single" || shape === "episodic")) {
      await withinTimeout(tryDownloadSubtitle(destPath, item.id), POST_IMPORT_STEP_TIMEOUT_MS, `subtitle download for "${destPath}"`);
    }
    if ((item.type === "comic" || item.type === "manga") && ext.toLowerCase() === ".cbz" && getSetting("comicImageConvertEnabled") === "1") {
      const format = getSetting("comicImageFormat") === "jpeg" ? "jpeg" : "webp";
      const imageQuality = Number(getSetting("comicImageQuality") ?? "82") || 82;
      await convertComicImagesBestEffort(destPath, format, imageQuality);
    }
    const mediaInfo = isProbeableFile(destPath) ? await probeMediaInfo(destPath) : null;
    const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;
    const finalSize = await fsp.stat(destPath).then((s) => s.size).catch(() => sizeBytes);
    // Matched on the path too: a later import may have replaced the file on this row meanwhile.
    if (shape === "single") {
      await db.prepare("UPDATE media_items SET media_info = ?, size_bytes = ? WHERE id = ? AND path = ?").run(mediaInfoJson, finalSize, item.id, destPath);
    } else if (episodeId) {
      for (const row of episodicRows ?? [{ id: episodeId }]) {
        await db.prepare("UPDATE episodes SET media_info = ?, size_bytes = ? WHERE id = ? AND file_path = ?").run(mediaInfoJson, finalSize, row.id, destPath);
      }
    } else if (subItemId) {
      await db.prepare("UPDATE sub_items SET media_info = ?, size_bytes = ? WHERE id = ? AND file_path = ?").run(mediaInfoJson, finalSize, subItemId, destPath);
    }
  } catch (err) {
    log.warn(`[importer] finishing "${destPath}" after its import failed:`, (err as Error).message);
  }
  const importContext = {
    mediaItemId: item.id,
    episodeIds: episodicRows ? episodicRows.map((r) => r.id) : episodeId ? [episodeId] : undefined,
    file: { path: destPath, size: sizeBytes, quality: quality ?? null, releaseGroup: releaseTitle ? parseReleaseTitle(releaseTitle).releaseGroup : null, sceneName: releaseTitle },
    release: { title: releaseTitle },
  };
  if (hadFileBefore) await notifyUpgraded(item.title, fileLabel, destPath, importContext);
  else await notifyImported(item.title, fileLabel, destPath, importContext);
  return { destPath, fileLabel };
}

/**
 * What a manual import of `sourceFile` onto this target would run into, as readable warnings, without placing anything:
 * the file names another title, would replace a better file, holds a rejected file type, or looks like a sample.
 * An automatic import refuses on these; a manual one goes ahead, so the admin is told first (Sonarr's manual import
 * lists each file's rejections).
 */
export async function manualImportWarnings(params: {
  itemId: number;
  episodeId?: number | null;
  subItemId?: number | null;
  sourceFile: string;
  quality: string | null;
}): Promise<string[]> {
  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(params.itemId);
  if (!mediaRow) throw new Error(`Media item ${params.itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const shape = effectiveShape(item);
  const warnings: string[] = [];
  const mismatch = fileContradictsTarget(params.sourceFile, {}, await importTargetFor(item));
  if (mismatch) warnings.push(mismatch);

  let existing: { quality: string | null; filePath: string | null }[] = [];
  if (shape === "single" && item.hasFile) existing = [{ quality: item.quality ?? null, filePath: item.path ?? null }];
  else if (params.episodeId) {
    const row = (await db.prepare("SELECT quality, file_path, has_file FROM episodes WHERE id = ?").get(params.episodeId)) as any;
    if (row?.has_file) existing = [{ quality: row.quality ?? null, filePath: row.file_path ?? null }];
  } else if (params.subItemId) {
    const row = (await db.prepare("SELECT quality, file_path, has_file FROM sub_items WHERE id = ?").get(params.subItemId)) as any;
    if (row?.has_file) existing = [{ quality: row.quality ?? null, filePath: row.file_path ?? null }];
  }
  try {
    await assertNotADowngrade(item.type, params.quality, params.sourceFile, existing, await qualityGroupsOfProfile(item.qualityProfileId));
  } catch (err) {
    if (err instanceof ImportSkippedError) warnings.push(err.message.replace(/ — left in the download for a manual import$/, ""));
    else throw err;
  }
  // The downloads folder itself holds every download's files: only a folder of its own says something about this file.
  const sourceDir = path.resolve(path.dirname(params.sourceFile));
  const bad = sourceDir === path.resolve(config.downloadsDir) ? null : findRejectedFile(sourceDir, item.type);
  if (bad) warnings.push(`The folder holds "${path.basename(bad)}", a file type that is rejected for automatic imports`);
  if ((shape === "single" || shape === "episodic") && VIDEO_EXTENSIONS.has(path.extname(params.sourceFile).toLowerCase()) && isProbeableFile(params.sourceFile)) {
    const reason = probeVerdict(await probeMediaInfo(params.sourceFile), mediaRow.runtime_minutes);
    if (reason) warnings.push(`This file: ${reason}`);
  }
  return warnings;
}

export interface QueueManualImportPreview {
  sourceFile: string;
  /** The strategy the import would use: move, copy, hardlink or symlink. */
  mode: string;
  /** Where the file would be put; null when the importer decides that while it runs (an album, a season pack, a discography). */
  destPath: string | null;
  fileLabel: string | null;
  /** Whether the file stays where it is in the download (every mode but move). */
  sourceKept: boolean;
  warnings: string[];
  /** Why the import would be refused, when it would. */
  error?: string;
  note?: string;
}

/**
 * What Activity's manual import of `sourceFile` for a queue row would do, without doing it: the strategy, where the file
 * would land, and the warnings the other manual import preview gives. The same checks as the import itself decide the
 * source file (inside the downloads folder, there) and the destination (the importer's own dry run).
 */
export async function previewQueueManualImport(queueItemId: number, sourceFile: string, overrideQuality?: string): Promise<QueueManualImportPreview> {
  const queueRow = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueItemId)) as any;
  if (!queueRow) throw new Error(`Queue item ${queueItemId} not found`);
  const queueItem = queueItemFromRow(queueRow);
  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(queueItem.mediaItemId);
  if (!mediaRow) throw new Error(`Media item ${queueItem.mediaItemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);

  const downloadsDir = path.resolve(config.downloadsDir);
  const resolved = path.resolve(sourceFile);
  if (resolved !== downloadsDir && !resolved.startsWith(downloadsDir + path.sep)) throw new Error("Selected file must be inside the downloads directory");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("Selected file no longer exists");

  // What the strategy would be: the one asked for, else the setting, with "auto" decided by this download's protocol.
  let mode = strategyOverride.getStore() ?? getSetting("importStrategy") ?? "move";
  if (mode === "auto") {
    const client = queueRow.download_client_id
      ? ((await db.prepare("SELECT type FROM download_clients WHERE id = ?").get(queueRow.download_client_id)) as { type: string } | undefined)
      : undefined;
    mode = autoStrategyFor(queueRow.protocol, client?.type) ?? "move";
  }
  const quality = overrideQuality ?? queueItem.quality;
  const preview: QueueManualImportPreview = { sourceFile: resolved, mode, destPath: null, fileLabel: null, sourceKept: mode !== "move", warnings: [] };
  preview.warnings = await manualImportWarnings({ itemId: item.id, episodeId: queueItem.episodeId, subItemId: queueItem.subItemId, sourceFile: resolved, quality });

  const isAlbum = shape === "collection" && typeConfig.multiFilePerChild;
  if (isAlbum && !queueItem.episodeId) {
    preview.note = queueItem.subItemId
      ? "The album's files are filed together when it is imported; where they go is decided then"
      : "The albums this download holds are filed when it is imported; where they go is decided then";
    return preview;
  }
  if (shape === "episodic" && queueItem.seasonNumber != null && !queueItem.episodeId) {
    preview.note = "The files of the season are filed when it is imported; where they go is decided then";
    return preview;
  }
  try {
    const placed = await placeFile({ itemId: item.id, episodeId: queueItem.episodeId, subItemId: queueItem.subItemId, sourceFile: resolved, quality, dryRun: true });
    preview.destPath = placed.destPath;
    preview.fileLabel = placed.fileLabel;
  } catch (err) {
    preview.error = err instanceof Error ? err.message : String(err);
  }
  return preview;
}

/** How long a post-import step (a subtitle provider's search and download) may hold the import open. */
const POST_IMPORT_STEP_TIMEOUT_MS = 90_000;

/** Waits for `work`, but not longer than `ms`: a provider that never answers is moved on from, with a
 * warning. The work itself is not cancelled; whatever it finishes later is simply not waited for. */
async function withinTimeout(work: Promise<unknown>, ms: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn(`[importer] ${label} is taking longer than ${Math.round(ms / 1000)}s — moving on without waiting for it`);
          resolve();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For "collection" libraries where a child's download normally contains many files rather than
 * one (currently just Music: an album download has one file per track) — moves every sibling
 * file next to the best-matched anchor file, not just that one file. Each moved file is matched
 * to a track (if the track list has been fetched) by the number its filename starts with: "04 -
 * Song.mp3", or a multi-disc "2-04 Song.mp3" / "204 Song.mp3" (disc 2, track 4). `onlyAnchor`
 * places the anchor alone — a manual import of chosen files — while still reading the rest of its
 * folder for the disc layout. `anchorDest` is where the anchor landed; `sourceFolder` the album's
 * own download folder, or null when it sat in a folder shared with other downloads.
 */
export async function placeAlbumFiles(params: {
  itemId: number;
  subItemId: number;
  anchorFile: string;
  quality: string | null;
  /** The grabbed release's title — how a client's category folder is told apart from the album's own. */
  releaseTitle?: string;
  /** The client-reported download folder and the client's category — see isOwnReleaseFolder. */
  downloadPath?: string | null;
  category?: string | null;
  onlyAnchor?: boolean;
  /** See placeFile: a track or destination an earlier file of the same manual import took is refused. */
  batchClaims?: Set<string>;
  /** See placeFile: an automatic import of an album in a less preferred format (mp3 over flac) is refused. */
  refuseDowngrade?: boolean;
  /** The anchor's folder is known to hold this album and no other download's files (a folder of a discography the
   * caller matched to the album): it is not judged by its name. */
  ownFolder?: boolean;
}): Promise<{ destFolder: string; fileCount: number; leftInPlace: number; anchorDest: string | null; sourceFolder: string | null }> {
  const { itemId, subItemId, anchorFile, quality, releaseTitle, downloadPath, category, onlyAnchor = false, batchClaims, refuseDowngrade, ownFolder = false } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);
  await assertRootFolderMounted(rootFolder);

  const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
  if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);

  const sourceDir = path.dirname(anchorFile);
  // A multi-disc download often lays each disc out as its own subfolder (e.g. "Album [2CD]/CD1",
  // "Album [2CD]/CD2") — if the anchor file resolves inside one of those, sourceDir alone is just
  // that one disc. Detect that shape and treat the disc folder's parent (the actual album folder)
  // as the real source instead, so every disc's tracks get collected below and, when naming is
  // disabled, the destination folder keeps the album's own name rather than "CD1".
  const DISC_SUBFOLDER_RE = /^(cd|disc|disk)\s*[-_]?\s*\d+$/i;
  const albumSourceDir = DISC_SUBFOLDER_RE.test(path.basename(sourceDir)) ? path.dirname(sourceDir) : sourceDir;
  const isDiscFolderFile = (file: string): boolean => {
    const dir = path.dirname(file);
    return path.resolve(dir) !== path.resolve(albumSourceDir) && DISC_SUBFOLDER_RE.test(path.basename(dir));
  };
  // A hand-picked file comes with no release title; without one to check against, a category folder
  // ("music") counted as the album's own and every other album's "01 - ..." there competed for its tracks.
  const releaseYear = /^\d{4}/.exec(String(subRow.release_date ?? ""))?.[0];
  const folderIdentity = releaseTitle ?? (onlyAnchor ? `${item.title} - ${subRow.title}${releaseYear ? ` (${releaseYear})` : ""}` : undefined);
  // Loose tracks there can't be told apart from other albums' "01 - x.flac" by number alone. A
  // hand-picked file's disc folder is in its album's own folder, though, whatever that folder's
  // name carries besides the artist and album ("AM (2013) [2CD]").
  const sharedSourceDir = ownFolder
    ? false
    : onlyAnchor && isDiscFolderFile(anchorFile)
    ? path.resolve(albumSourceDir) === path.resolve(config.downloadsDir)
    : !isOwnReleaseFolder(albumSourceDir, { releaseTitle: folderIdentity, downloadPath, category });
  // Music's individual track filenames are always kept as-downloaded (see the per-file loop
  // below) — there's no separate "filename" to bypass independently the way single/episodic have,
  // so for this shape the album FOLDER is the naming toggle's equivalent of a filename: the
  // artist folder from the template still applies (avoids dumping every album flat), but the
  // album folder itself reverts to the source download's own folder name when disabled.
  const templatedSegments = renderPathSegments(getNamingTemplate(item.type), {
    parentTitle: item.title,
    childTitle: subRow.title,
    quality: quality ?? "",
    ...titleVars("parent", item.title, item.year),
    ...providerIdVars(item),
  });
  const parentFolderSegments = templatedSegments.slice(0, -1);
  const albumFolderName =
    getNamingEnabled(item.type) || sharedSourceDir
      ? templatedSegments[templatedSegments.length - 1]
      : safePathSegment(path.basename(albumSourceDir));
  let destFolder = path.join(rootFolder.path, ...parentFolderSegments, albumFolderName);
  // One artist's same-titled albums (self-titled records, several "Greatest Hits") render one
  // folder, where the later import renamed its tracks over the earlier album's same-named ones.
  // The release year tells them apart; with none to use, the import is refused instead.
  if (await isFolderOfAnotherChild(destFolder, subItemId)) {
    const year = /^\d{4}/.exec(String(subRow.release_date ?? ""))?.[0];
    const withYear = year ? path.join(path.dirname(destFolder), `${albumFolderName} (${year})`) : null;
    if (!withYear || (await isFolderOfAnotherChild(withYear, subItemId))) {
      const childLabel = (typeConfig.childLabel ?? "album").toLowerCase();
      throw new ImportSkippedError(
        `"${destFolder}" is already another ${childLabel}'s folder${year ? ", and so is the one with its year" : ""} — not importing "${subRow.title}" into it`
      );
    }
    destFolder = withYear;
  }
  assertInsideRoot(rootFolder.path, destFolder);
  function collectAudioFiles(dir: string): string[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && typeConfig.extensions.includes(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
  }
  // A disc subfolder's own filenames typically restart at "01" per disc, but fetchAlbumTracksFor's
  // MusicBrainz fetch (metadata.ts) numbers tracks continuously across media — disc 2's DB
  // track_number picks up after disc 1's count, not from 1 again. Without an offset, disc 2's
  // "01 - Song.mp3" would match disc 1's own track 1 by leading number alone. Offsets are inferred
  // from file counts per disc folder (sorted by the number embedded in the folder name), which only
  // lines up correctly if the download's own file count per disc matches the medium's real track
  // count — if it doesn't, the fallback is simply no match (original filename kept), same as when
  // no track list has been fetched yet, not a wrong one.
  const trackNumberOffsetForFile = new Map<string, number>();
  let siblings: string[];
  // Audio files left next to the anchor in a shared folder — possibly more of this album's tracks.
  let leftInPlace = 0;
  if (sharedSourceDir) {
    // Only tracks named for exactly this artist and album ("Artist - Album - 02 - Track.flac") are
    // told apart from other albums' there: the words before the track number must be the artist's
    // and album's and nothing else, so "Artist - Red - 01" never joins "Artist - 1989" and
    // "Album (Deluxe)" never joins "Album". An album title with no comparable word ("21") takes
    // only the anchor.
    const albumTokens = normalizeTokens(String(subRow.title ?? ""));
    const expected = new Set([...normalizeTokens(item.title), ...albumTokens]);
    const others = collectAudioFiles(sourceDir).filter((f) => path.resolve(f) !== path.resolve(anchorFile));
    const named =
      albumTokens.length > 0
        ? others.filter((f) => {
            const base = path.basename(f, path.extname(f));
            const prefix = base.split(/(?:^|[\s._-])\d{1,3}(?=[\s._-]|$)/)[0];
            const prefixTokens = new Set(normalizeTokens(prefix).filter((t) => expected.has(t) || !/^(?:19|20)\d{2}$/.test(t)));
            return prefixTokens.size === expected.size && [...expected].every((t) => prefixTokens.has(t));
          })
        : [];
    siblings = [anchorFile, ...named];
    leftInPlace = others.length - named.length;
  } else if (albumSourceDir === sourceDir) {
    siblings = collectAudioFiles(sourceDir);
  } else {
    // A hand-picked file only needs the discs around it.
    const discNumberOf = (name: string): number => Number(name.match(/(\d+)/)?.[1]) || 0;
    const discFolderNames = fs
      .readdirSync(albumSourceDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (!onlyAnchor || DISC_SUBFOLDER_RE.test(e.name)))
      .map((e) => e.name)
      .sort((a, b) => discNumberOf(a) - discNumberOf(b));
    siblings = onlyAnchor ? [] : collectAudioFiles(albumSourceDir);
    // Picked one folder at a time, an earlier pick may already have moved a disc's files out:
    // counted from what was left, disc 2's "01" landed on disc 1's track 1, over its file. Discs
    // after one whose files no longer run from "01" unbroken aren't counted from at all.
    const numberedFromOne = (files: string[]): boolean => {
      const numbers = files.map((f) => Number(/^(\d{1,3})(?!\d)/.exec(path.basename(f))?.[1])).sort((a, b) => a - b);
      return numbers.length > 0 && numbers.every((n, i) => n === i + 1);
    };
    // Keyed by each folder's OWN disc number (parsed above), not by position in a listing that
    // may no longer hold every earlier disc — a disc folder deleted outright from disk (as
    // opposed to merely emptied by an earlier pick) is simply absent here, rather than shifting
    // the disc after it into the gap.
    const fileCountByDisc = new Map<number, number>();
    const filesByDisc = new Map<number, string[]>();
    for (const discName of discFolderNames) {
      const discFiles = collectAudioFiles(path.join(albumSourceDir, discName));
      const discNumber = discNumberOf(discName);
      filesByDisc.set(discNumber, discFiles);
      siblings.push(...discFiles);
      if (!onlyAnchor || numberedFromOne(discFiles)) fileCountByDisc.set(discNumber, discFiles.length);
    }
    // Mirrors discOffset below: a disc's offset is the sum of every earlier disc's own file
    // count, and — same as that function — refuses to guess (returns null) when an earlier disc
    // isn't in fileCountByDisc, whether its folder is missing from the listing entirely or its
    // files failed numberedFromOne.
    const subfolderOffset = (disc: number): number | null => {
      let offset = 0;
      for (let d = 1; d < disc; d++) {
        const count = fileCountByDisc.get(d);
        if (count === undefined) return null;
        offset += count;
      }
      return offset;
    };
    for (const [discNumber, discFiles] of filesByDisc) {
      const offset = subfolderOffset(discNumber);
      if (offset !== null) for (const f of discFiles) trackNumberOffsetForFile.set(f, offset);
    }
  }

  const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(subItemId)) as any[];
  // A folder holding far more audio files than the album has tracks (a deluxe edition or a second disc is
  // allowed for) is several albums, a discography grabbed for one of them: moving it all in would file other
  // albums' tracks under this one.
  if (!onlyAnchor && tracks.length >= 3 && siblings.length > tracks.length * 3 + 5) {
    throw new ImportSkippedError(
      `"${path.basename(albumSourceDir)}" holds ${siblings.length} audio files for "${subRow.title}", which has ${tracks.length} tracks: it looks like several albums, so it is left for a manual import`
    );
  }
  const namingEnabled = getNamingEnabled(item.type);
  const trackByNumber = new Map<number, any>(tracks.map((t) => [Number(t.track_number), t]));

  // Picard and iTunes name a multi-disc album's files "1-01 Title", "2-01 Title" (or "101 Title")
  // in one folder. Read as a bare leading number, every disc-1 file was track 1 and every disc-2
  // file track 2, all renamed to one name and moved over each other. The track list is numbered
  // straight through, so a disc's tracks follow the highest track number of each earlier disc;
  // with an earlier disc missing from the download there's nothing to count from, and its files
  // stay unmatched rather than land on another disc's tracks.
  const threeDigitDiscs =
    siblings.length > 0 && tracks.every((t) => Number(t.track_number) < 100) && siblings.every((src) => /^[1-9]\d{2}(?!\d)/.test(path.basename(src)));
  // Scene naming puts digits after the track number too ("01-50_cent-intro", "01-311-amber"), so
  // the "D-TT" form counts only as Picard and iTunes write it, and only when every numbered file of
  // the album is named that way.
  const discTrackNames =
    siblings.some((src) => DISC_TRACK.test(path.basename(src))) &&
    siblings.every((src) => !/^\d/.test(path.basename(src)) || DISC_TRACK.test(path.basename(src)));
  const numbering = siblings.map((src) => parseTrackNumbering(path.basename(src), discTrackNames, threeDigitDiscs));
  const lastTrackOfDisc = new Map<number, number>();
  for (const n of numbering) if (n?.disc != null) lastTrackOfDisc.set(n.disc, Math.max(lastTrackOfDisc.get(n.disc) ?? 0, n.track));
  const discOffset = (disc: number): number | null => {
    let offset = 0;
    for (let d = 1; d < disc; d++) {
      const last = lastTrackOfDisc.get(d);
      if (last === undefined) return null;
      offset += last;
    }
    return offset;
  };
  const outsideLaterDiscFolder = (src: string): boolean =>
    !isDiscFolderFile(src) || Number(/(\d+)/.exec(path.basename(path.dirname(src)))?.[1]) === 1;
  // A disc folder's files with no disc count before them to go by (the earlier discs not in view)
  // match only when it's disc 1.
  const discFolderOffset = (src: string): number | null => trackNumberOffsetForFile.get(src) ?? (outsideLaterDiscFolder(src) ? 0 : null);
  const matchOffsets = siblings.map((src, i) => {
    const n = numbering[i];
    if (!n) return null;
    return n.disc != null ? discOffset(n.disc) : discFolderOffset(src);
  });
  const wantedTracks = siblings.map((_, i) => {
    const n = numbering[i];
    const offset = matchOffsets[i];
    return n && offset !== null ? trackByNumber.get(n.track + offset) : undefined;
  });
  // A track two files lay claim to goes to neither: each keeps its own name rather than one being
  // renamed onto the other.
  const claimsPerTrack = new Map<number, number>();
  for (const t of wantedTracks) if (t) claimsPerTrack.set(t.id, (claimsPerTrack.get(t.id) ?? 0) + 1);

  const planned: { src: string; track: any; dest: string; byOwnNumber: boolean }[] = siblings.map((src, i) => {
    const wanted = wantedTracks[i];
    const track = wanted && claimsPerTrack.get(wanted.id) === 1 ? wanted : undefined;
    // Matched on the number in its own name alone, with no count of earlier discs added to it.
    const byOwnNumber = !!track && matchOffsets[i] === 0 && outsideLaterDiscFolder(src);

    // A matched track gets its filename templated the same way every other shape's filename
    // already is; an unmatched file (no leading track number, or no track list fetched yet) has
    // nothing to template against, so it keeps its original name — same as naming-disabled.
    const fileName =
      track && namingEnabled ? trackFileNameFor(item, subRow.title, track, path.extname(src)) : sanitizeForPath(path.basename(src));
    // Picked one at a time, an unmatched disc file can't see the other discs' same-named ones
    // ("CD1/Intro.flac", "CD2/Intro.flac") below, so it keeps its disc folder from the start.
    if (onlyAnchor && !track && isDiscFolderFile(src)) {
      return { src, track, byOwnNumber, dest: path.join(destFolder, safePathSegment(path.basename(path.dirname(src))), fileName) };
    }
    return { src, track, byOwnNumber, dest: path.join(destFolder, fileName) };
  });
  // Same-named files of different disc folders ("CD1/01 - Intro.flac", "CD2/01 - Intro.flac") keep
  // their disc folder; any other two files bound for one name refuse the import before anything moves.
  const destKey = (p: string) => path.resolve(p).toLowerCase();
  const byDest = new Map<string, typeof planned>();
  for (const p of planned) byDest.set(destKey(p.dest), [...(byDest.get(destKey(p.dest)) ?? []), p]);
  for (const group of byDest.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      const discDir = path.dirname(p.src);
      if (path.resolve(discDir) !== path.resolve(albumSourceDir) && DISC_SUBFOLDER_RE.test(path.basename(discDir))) {
        p.dest = path.join(destFolder, safePathSegment(path.basename(discDir)), path.basename(p.dest));
      }
    }
  }
  const toPlace = onlyAnchor ? planned.filter((p) => path.resolve(p.src) === path.resolve(anchorFile)) : planned;
  if (onlyAnchor && toPlace.length === 0) {
    throw new ImportSkippedError(`"${path.basename(anchorFile)}" is not a ${(typeConfig.childLabel ?? "album").toLowerCase()} file this library can import`);
  }
  const destinations = new Set<string>();
  for (const { dest } of toPlace) {
    if (destinations.has(destKey(dest))) {
      throw new ImportSkippedError(`Two files of "${subRow.title}" would both be placed at "${dest}" — not importing it`);
    }
    destinations.add(destKey(dest));
  }
  // A manual import places just the files it was given; the rest of the folder isn't left over from it.
  if (onlyAnchor) leftInPlace = 0;

  await assertEnoughFreeSpaceForImport(toPlace.map((p) => p.src), rootFolder.path, rootFolder.minFreeSpaceGb);

  // Checked before anything moves, so a refusal never leaves the album half imported.
  for (const { dest } of toPlace) {
    if (await isFileOfAnotherRow(dest, item.id, [], subItemId)) {
      throw new ImportSkippedError(`"${dest}" is already another library entry's file — not importing "${subRow.title}" over it`);
    }
  }
  // An album that already has its files is replaced only by a release that holds all of them: a smaller one would leave
  // the tracks it lacks in the old format beside the new ones, with the album marked complete.
  if (!onlyAnchor && subRow.has_file) {
    const hadTracks = tracks.filter((t) => Number(t.has_file)).length;
    const matched = new Set(toPlace.filter((p) => p.track).map((p) => p.track.id)).size;
    if (hadTracks > 1 && matched < hadTracks) {
      throw new ImportSkippedError(
        `"${subRow.title}" already has ${hadTracks} track file(s) and this download matches only ${matched} of them — not replacing the album with part of it`
      );
    }
  }
  const claimKeysOf = (p: { track: any; dest: string }) => [`dest:${destKey(p.dest)}`, ...(p.track ? [`track:${p.track.id}`] : [])];
  for (const p of toPlace) {
    if (batchClaims && claimKeysOf(p).some((key) => batchClaims.has(key))) {
      throw new ImportSkippedError(`Another file in this import was already placed as "${path.basename(p.dest)}" — not replacing it with "${path.basename(p.src)}"`);
    }
  }
  // A hand-pick replaces a file already at its destination, recycling it, only when that file is
  // plainly the same entry's: the file of the track it matched by its own track number, or — matched
  // to no track and not in a disc folder — a file no other track has, or a single-track entry's one
  // file (an audiobook's "Dune.m4b"). Taken for a track through a count of earlier discs, by a title
  // that merely starts with a number, or named like another track's file, it would destroy that
  // file, so it's refused.
  const replaceExisting = new Set<string>();
  if (onlyAnchor) {
    const isFileAt = (file: unknown, dest: string) => typeof file === "string" && file !== "" && isSameFile(file, dest);
    for (const { src, dest, track, byOwnNumber } of toPlace) {
      if (isSameFile(src, dest) || !isOtherExistingEntry(src, dest)) continue;
      const tracksThere = tracks.filter((t) => isFileAt(t.file_path, dest));
      const ownFile = track
        ? byOwnNumber && namedAsTrackNumber(src, track.title, tracks.length) && isFileAt(track.file_path, dest)
        : !isDiscFolderFile(src) && (tracksThere.length === 0 || (tracks.length === 1 && tracksThere.length === 1) || isFileAt(subRow.file_path, dest));
      if (!ownFile) throw new ImportSkippedError(`"${dest}" already exists — not replacing it with "${path.basename(src)}"`);
      replaceExisting.add(destKey(dest));
    }
  }

  // Every destination is judged before anything moves: a file nothing tracks refuses the whole album
  // here, so a refusal never leaves it half imported with the rest of the download stranded.
  const albumOwnPaths = [...tracks.map((t) => t.file_path), subRow.file_path];
  for (const { src, dest } of toPlace) {
    if (!replaceExisting.has(destKey(dest)) && destinationVerdict(src, dest, albumOwnPaths) === "refuse") {
      throw new ImportSkippedError(destinationRefusedMessage(dest));
    }
  }
  // An automatic import must not swap the files an album has for a less preferred format (mp3 for flac).
  if (refuseDowngrade && !onlyAnchor) {
    const haveRanks = tracks
      .filter((t) => Number(t.has_file) && t.file_path && fs.existsSync(t.file_path))
      .map((t) => formatRank(String(t.file_path)))
      .filter((rank) => rank > 0);
    if (haveRanks.length > 0 && Math.min(...toPlace.map((p) => formatRank(p.src))) > Math.min(...haveRanks)) {
      throw new ImportSkippedError(
        `Not an upgrade: the library already has this album in a better format than this download's "${path.extname(anchorFile)}" — left in the download for a manual import`
      );
    }
  }

  let movedCount = 0;
  let totalMovedBytes = 0;
  let anchorDest: string | null = null;
  const replacedPaths: (string | null)[] = [];
  const placedPaths: string[] = [];
  for (const p of toPlace) {
    const { src, track, dest } = p;
    if (replaceExisting.has(destKey(dest))) await placeOverRecycledFile(src, dest, item);
    else await placeAtDestination(src, dest, item, albumOwnPaths);
    for (const key of claimKeysOf(p)) batchClaims?.add(key);
    placedPaths.push(src, dest);
    if (path.resolve(src) === path.resolve(anchorFile)) anchorDest = dest;
    movedCount++;
    totalMovedBytes += await fsp.stat(dest).then((s) => s.size).catch(() => 0);

    if (track) {
      if (track.has_file) replacedPaths.push(track.file_path);
      await db.prepare("UPDATE tracks SET has_file = 1, file_path = ? WHERE id = ?").run(dest, track.id);
    }

    if (track && getSetting("writeAudioTagsOnImport") === "1") {
      await writeAudioTags(dest, {
        title: track.title,
        artist: item.title,
        album: subRow.title,
        trackNumber: track.track_number,
        year: subRow.release_date ? String(subRow.release_date).slice(0, 4) : null,
      });
    }
  }

  // A single-file book found loose in the root folder has that file, not a folder, as its file_path.
  // The files now in its own folder replace it, and a track row still on it follows the new file.
  const looseFile =
    Number(subRow.has_file) && subRow.file_path && !isDirectory(subRow.file_path) && typeConfig.extensions.includes(path.extname(subRow.file_path).toLowerCase())
      ? String(subRow.file_path)
      : null;
  if (looseFile && movedCount > 0) {
    replacedPaths.push(looseFile);
    const placedTrackIds = new Set(toPlace.flatMap((p) => (p.track ? [p.track.id] : [])));
    const anchorHasTrack = toPlace.some((p) => p.track && path.resolve(p.src) === path.resolve(anchorFile));
    for (const t of tracks) {
      if (placedTrackIds.has(t.id) || !t.file_path || path.resolve(t.file_path) !== path.resolve(looseFile)) continue;
      if (tracks.length === 1 && anchorDest && !anchorHasTrack) {
        await db.prepare("UPDATE tracks SET has_file = 1, file_path = ? WHERE id = ?").run(anchorDest, t.id);
      } else {
        await db.prepare("UPDATE tracks SET has_file = 0, file_path = NULL WHERE id = ?").run(t.id);
      }
    }
  }

  // Probe the anchor at wherever it actually landed (the track template may have renamed it).
  const mediaInfo = anchorDest && isProbeableFile(anchorDest) ? await probeMediaInfo(anchorDest) : null;
  // One file added to an album is not the album's size: the whole folder's is.
  const sizeBytes = movedCount === 0 ? null : onlyAnchor ? mediaBytesUnder(destFolder, typeConfig.extensions) : totalMovedBytes;

  // The release the files came from goes on the album with them (a later format upgrade is judged against it); a
  // hand-picked file is of no known release.
  await db
    .prepare("UPDATE sub_items SET has_file = ?, file_path = ?, quality = ?, media_info = ?, size_bytes = ?, file_release_title = ? WHERE id = ?")
    .run(movedCount > 0 ? 1 : 0, destFolder, quality, mediaInfo ? JSON.stringify(mediaInfo) : null, sizeBytes, onlyAnchor ? null : releaseTitle ?? null, subItemId);
  if (movedCount > 0) await markParentHasFile(item.id);
  // After the row updates: a file any row still points at is never recycled.
  await recycleReplacedFiles(replacedPaths, placedPaths, item);
  // A manual import places an album one track per call. A history row and notification per track
  // listed a 12-track album as imported 12 times in the repeated-imports report, so only the first
  // file of a batch — or, with no batch to go by, a track that isn't simply joining the album's
  // files at the quality they already have — records the album's import.
  const albumClaim = `album:${subItemId}`;
  const recordsImport =
    !onlyAnchor || (!batchClaims?.has(albumClaim) && !(Number(subRow.has_file) && (subRow.quality ?? null) === (quality ?? null)));
  if (onlyAnchor) batchClaims?.add(albumClaim);
  if (recordsImport) {
    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
      item.id,
      importedHistoryData({ destFolder, fileCount: movedCount, subItemId, quality: quality ?? null })
    );
    await notifyImported(item.title, `${movedCount} file(s) into ${path.basename(destFolder)}`, destFolder, { mediaItemId: item.id });
  }
  log.info(`[importer] imported ${movedCount} file(s) into "${path.basename(destFolder)}" for "${item.title}"`);
  if (leftInPlace > 0) {
    const reason = `${leftInPlace} other audio file(s) were left in ${sourceDir} after importing "${subRow.title}"; import any that belong to it manually`;
    log.warn(`[importer] ${reason}`);
    await notifyManualInteractionRequired(item.title, reason, { mediaItemId: item.id });
  }
  return { destFolder, fileCount: movedCount, leftInPlace, anchorDest, sourceFolder: sharedSourceDir ? null : albumSourceDir };
}

/** A disc folder of a multi-disc album ("CD1", "Disc 2"): not an album of its own. */
const DISC_FOLDER = /^(cd|disc|disk)\s*[-_]?\s*\d+$/i;

/** The folder an audio file's album is in: its own, or the folder above when it is a disc folder. */
function albumFolderOfFile(file: string, releaseDir: string): string {
  let dir = path.resolve(path.dirname(file));
  const root = path.resolve(releaseDir);
  while (dir !== root && DISC_FOLDER.test(path.basename(dir))) dir = path.dirname(dir);
  return dir;
}

/**
 * The folder that is the whole discography download: the one the client reported, or, with none reported, the
 * nearest folder above the file that is named for the release. Null when neither can be told (the albums of a
 * folder shared with other downloads cannot be told apart from theirs).
 */
function discographyRootOf(sourceFile: string, downloadPath: string | null | undefined, releaseTitle: string, category: string | null | undefined): string | null {
  const file = path.resolve(sourceFile);
  if (downloadPath) {
    const reported = path.resolve(downloadPath);
    if (file.startsWith(reported + path.sep) && isDirectory(reported)) return reported;
    return null;
  }
  // No folder reported: the folders above the file, up to the downloads directory. The one named a discography is
  // the release's; failing that the outermost one named for the release (an album folder is named for the artist too).
  const downloads = path.resolve(config.downloadsDir);
  const ancestors: string[] = [];
  for (let dir = path.dirname(file); dir !== downloads && dir.startsWith(downloads + path.sep); dir = path.dirname(dir)) ancestors.push(dir);
  const named = ancestors.find((dir) => isDiscographyTitle(path.basename(dir)));
  if (named) return named;
  const own = ancestors.filter((dir) => isOwnReleaseFolder(dir, { releaseTitle, category }) && !isSharedDownloadFolder(dir, releaseTitle));
  return own.length > 0 ? own[own.length - 1] : null;
}

export interface DiscographyImport {
  imported: { subItemId: number; title: string; destFolder: string; fileCount: number }[];
  /** Albums the grab was for that no folder of the release held. */
  notFound: number[];
  /** Albums the grab was for whose folder was found and could not be placed, and why. */
  failed: { subItemId: number; title: string; reason: string }[];
  /** Albums the grab was for that have their files by now, and were left as they are. */
  alreadyHad: number[];
  /** Folders and albums left unplaced, and why. */
  skipped: { folder: string; reason: string }[];
  /** Whether audio of the download is still where it was (a folder not imported, a file left behind). */
  leftBehind: boolean;
}

/**
 * Imports a downloaded discography: each of its album folders is told which album it holds
 * (discographyMatch.ts) and an album the grab was for is placed as any album download is. Folders of albums
 * that were not wanted (already in the library, or not monitored) stay in the download. With `onlyFolder` just
 * that album folder is imported (a manual import of one file the admin picked).
 */
export async function placeDiscographyFiles(params: {
  itemId: number;
  targetSubItemIds: number[];
  releaseDir: string;
  quality: string | null;
  releaseTitle?: string;
  category?: string | null;
  refuseDowngrade?: boolean;
  onlyFolder?: string;
  /** The admin picked the file, so the folder it is in is the download's own whatever it is called (the downloads
   * folder itself and the client's category folder never are). */
  trustFolder?: boolean;
}): Promise<DiscographyImport> {
  const { itemId, targetSubItemIds, releaseDir, quality, releaseTitle, category, refuseDowngrade, onlyFolder, trustFolder } = params;
  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const extensions = getMediaTypeConfig(item.type).extensions;
  const ctx: DownloadContext = { releaseTitle, downloadPath: releaseDir, category };
  // Album folders are taken from a folder that is this download's alone; in a folder shared with other downloads
  // another album's tracks would be filed as this one's. A torrent's folder is often not named like its release, so
  // the admin's own choice of a file in it settles that.
  const categoryFolder = category?.trim().toLowerCase().split(/[\\/]/).filter(Boolean).pop() || null;
  const sharedByName = trustFolder
    ? path.resolve(releaseDir) === path.resolve(config.downloadsDir) || (!!categoryFolder && path.basename(releaseDir).toLowerCase() === categoryFolder)
    : !isOwnReleaseFolder(releaseDir, ctx);
  if (sharedByName) {
    throw new ImportSkippedError(`"${releaseDir}" is shared with other downloads, so the albums of "${releaseTitle ?? "the discography"}" cannot be told apart in it — left for a manual import`);
  }

  const files = withoutSamples(walk(releaseDir, extensions, 6), releaseDir, releaseTitle);
  const byFolder = new Map<string, string[]>();
  for (const file of files) {
    const folder = albumFolderOfFile(file, releaseDir);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  const folders = Array.from(byFolder, ([folder, list]) => ({ path: folder, name: path.basename(folder), files: list.length }));
  const albumRows = await discographyAlbumsOf(itemId);
  // An album that gained its files while the discography downloaded is no longer wanted from it (unless the admin
  // picked its folder): replacing it is a decision for the admin.
  const albums = albumRows.map((album) => ({
    id: album.id,
    title: album.title,
    releaseDate: album.releaseDate,
    target: targetSubItemIds.includes(album.id) && (!album.hasFile || !!onlyFolder),
  }));
  const hasFileNow = new Set(albumRows.filter((album) => album.hasFile).map((album) => album.id));
  const matches = matchAlbumFolders(folders, item.title, albums);

  const result: DiscographyImport = {
    imported: [],
    notFound: [],
    failed: [],
    alreadyHad: onlyFolder ? [] : targetSubItemIds.filter((id) => hasFileNow.has(id)),
    skipped: [],
    leftBehind: false,
  };
  const placed = new Set<number>();
  for (const folder of folders) {
    const match = matches.get(folder.path)!;
    if (onlyFolder && path.resolve(folder.path) !== path.resolve(onlyFolder)) {
      result.leftBehind = true;
      continue;
    }
    if (match.kind !== "album") {
      result.skipped.push({ folder: folder.name, reason: match.reason });
      result.leftBehind = true;
      continue;
    }
    // An album that was not wanted stays in the download: it may be in the library already, or deliberately not monitored.
    if (!match.target) {
      result.leftBehind = true;
      continue;
    }
    const album = albums.find((a) => a.id === match.albumId)!;
    const anchorFile = [...byFolder.get(folder.path)!].sort()[0];
    try {
      const placedAlbum = await placeAlbumFiles({
        itemId,
        subItemId: album.id,
        anchorFile,
        quality,
        releaseTitle,
        downloadPath: releaseDir,
        category,
        refuseDowngrade,
        // The folder was told to hold this album and only it: it is the album's own, whatever it is called.
        ownFolder: true,
      });
      result.imported.push({ subItemId: album.id, title: album.title, destFolder: placedAlbum.destFolder, fileCount: placedAlbum.fileCount });
      placed.add(album.id);
      if (placedAlbum.leftInPlace > 0) result.leftBehind = true;
    } catch (err) {
      const reason = (err as Error).message;
      result.skipped.push({ folder: folder.name, reason: `"${album.title}": ${reason}` });
      result.failed.push({ subItemId: album.id, title: album.title, reason });
      result.leftBehind = true;
    }
  }
  // The albums the grab was for that no folder held; a manual import of one folder says nothing of the others.
  if (!onlyFolder) {
    const matchedTargets = new Set(Array.from(matches.values()).flatMap((m) => (m.kind === "album" && m.target ? [m.albumId] : [])));
    result.notFound = targetSubItemIds.filter((id) => !matchedTargets.has(id) && !hasFileNow.has(id));
  }
  if (result.imported.length === 0 && result.alreadyHad.length === 0) {
    const why = result.skipped.map((s) => s.reason).join("; ") || "none of its folders is an album that was wanted";
    throw new ImportSkippedError(`No album of "${releaseTitle ?? "the discography"}" could be imported: ${why}`);
  }
  log.info(`[importer] imported ${result.imported.length} album(s) of "${releaseTitle ?? "a discography"}" for "${item.title}"; ${result.skipped.length} folder(s) skipped, ${result.notFound.length} album(s) not in it`);
  return result;
}

// Picard's and iTunes' multi-disc naming: an unpadded disc, a separator, the track, then a space ("2-04 Song").
const DISC_TRACK = /^([1-9]\d?)[-.](\d{2,3})(?=\.?\s)/;

/** The disc (when the name carries one) and track number a track file's name starts with: "04 -
 * Song" is track 4; with `discTrackNames`, "2-04 Song" (Picard, iTunes) and, with `threeDigitDiscs`,
 * "204 Song" are disc 2's track 4. */
function parseTrackNumbering(fileName: string, discTrackNames: boolean, threeDigitDiscs: boolean): { disc: number | null; track: number } | null {
  const discTrack = discTrackNames ? DISC_TRACK.exec(fileName) : null;
  if (discTrack) return { disc: Number(discTrack[1]), track: Number(discTrack[2]) };
  const leading = /^(\d{1,3})(?!\d)/.exec(fileName);
  if (!leading) return null;
  if (threeDigitDiscs && leading[1].length === 3) return { disc: Number(leading[1][0]), track: Number(leading[1].slice(1)) };
  return { disc: null, track: Number(leading[1]) };
}

/** Whether a file's leading number reads as its track number rather than as the start of a title
 * ("7 rings"): the name is only the number, the number is followed by a separator ("07 - ", "07.",
 * "07_", "1-04"), padded to two digits or the album's width ("07 Song"), or the rest of the name
 * shares a word with the track's own title. */
function namedAsTrackNumber(fileName: string, trackTitle: unknown, trackCount: number): boolean {
  const m = /^(\d{1,3})(?!\d)\s*(.*)$/.exec(path.basename(fileName, path.extname(fileName)));
  if (!m) return false;
  const [, digits, rest] = m;
  if (rest === "" || /^[-._]/.test(rest)) return true;
  if (digits.length >= Math.max(2, String(trackCount).length)) return true;
  const titleTokens = new Set(normalizeTokens(String(trackTitle ?? "")));
  return normalizeTokens(rest).some((t) => titleTokens.has(t));
}

function mediaBytesUnder(dir: string, extensions: string[]): number {
  return walk(dir, extensions, 1).reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
}

/**
 * Every video file belonging to a season-pack download. The pack's own folder is the client-reported
 * download folder when that holds the anchor, otherwise the highest folder above the anchor still
 * named for this season — scene packs put each episode in a folder of its own and archive extraction
 * adds another level, so listing only the anchor's folder imported one episode and reported success.
 * With no folder of its own the pack sits loose among other downloads, where only files whose own
 * title is the release's can be told apart as part of it; `leftInPlace` counts the other files there.
 * `packDir` is the pack's own folder, null for a loose pack.
 */
function collectSeasonPackFiles(
  anchorFile: string,
  seasonNumber: number,
  extensions: string[],
  ctx: DownloadContext
): { files: string[]; leftInPlace: number; packDir: string | null } {
  const { releaseTitle, downloadPath } = ctx;
  const downloadsRoot = path.resolve(config.downloadsDir);
  const anchorDir = path.resolve(path.dirname(anchorFile));
  const namesSeason = (dir: string) => parseReleaseTitle(path.basename(dir)).seasonNumber === seasonNumber;

  let packDir: string | null = null;
  if (downloadPath) {
    const reported = path.resolve(downloadPath);
    if ((anchorDir === reported || anchorDir.startsWith(reported + path.sep)) && isOwnReleaseFolder(reported, ctx)) {
      packDir = reported;
    }
  }
  if (!packDir && anchorDir !== downloadsRoot && (namesSeason(anchorDir) || isOwnReleaseFolder(anchorDir, ctx))) {
    let dir = anchorDir;
    let parent = path.dirname(dir);
    while (parent !== dir && parent !== downloadsRoot && namesSeason(parent)) {
      dir = parent;
      parent = path.dirname(dir);
    }
    packDir = dir;
  }
  if (packDir) {
    return { files: withoutSamples(walk(packDir, extensions, 3), packDir, releaseTitle), leftInPlace: 0, packDir };
  }

  // The same title exactly, not just a subset of it: "Star.Trek.S01E03" is not part of "Star.Trek.Discovery.S01".
  const releaseTokens = new Set(releaseTitleTokens(releaseTitle));
  const others = fs
    .readdirSync(anchorDir, { withFileTypes: true })
    .filter((e) => e.isFile() && extensions.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(anchorDir, e.name))
    .filter((f) => path.resolve(f) !== path.resolve(anchorFile));
  const notSamples = new Set(withoutSamples([anchorFile, ...others], anchorDir, releaseTitle));
  const loose = others.filter((f) => {
    if (!notSamples.has(f)) return false;
    const fileTitle = new Set(releaseTitleTokens(path.basename(f, path.extname(f))));
    return fileTitle.size > 0 && fileTitle.size === releaseTokens.size && [...fileTitle].every((t) => releaseTokens.has(t));
  });
  return { files: [anchorFile, ...loose], leftInPlace: others.length - loose.length, packDir: null };
}

/** A season pack none of whose files maps to one of the season's episodes at all. */
class NoPackFileMatchedError extends ImportSkippedError {}

// A name that is only an episode number: "01.mkv", "E01.mkv", "Ep 01 - Title.mkv", "Episode 1.mkv".
const BARE_EPISODE = /^(?:e(?:p(?:isode)?)?[\s._-]*)?0*(\d{1,3})(?=$|[\s._\-)\]])/i;

/**
 * Maps each file of a season pack to this season's episode rows. A file's own SxxEyy / 1x01 (or an
 * E-marker under a "Season NN" folder) comes first, read in the scene's numbering where the show has one
 * (TheXEM: the pack's "S02E01" is the aired S01E05) and in the aired numbering otherwise; then an air date (a daily show's
 * "Show.2024.01.15"); then an anime batch's "Show - 13" — absolute numbering when every such file of
 * the pack falls in this season's absolute range, the season's own numbering when every one fits
 * that instead; then, directly inside a folder named for this season ("Show.S01.1080p"), a name
 * that is only an episode number. Matching on SxxEyy alone left every file of such packs unmatched,
 * so the pack never imported and its season stayed blocked. An episode two files map to goes to the
 * one matched the earlier way (then the first); the other stays in the download and counts as unmatched.
 */
export async function planSeasonPackFiles(
  files: string[],
  episodes: any[],
  itemId: number,
  seasonNumber: number,
  itemTitle: string
): Promise<{ plans: { src: string; episodes: any[] }[]; unmatchedCount: number }> {
  const byNumber = new Map<number, any>(episodes.map((e) => [Number(e.episode_number), e]));
  // The season's episodes by the scene's numbers, for a show TheXEM maps: scene numbering comes first.
  const bySceneKey = new Map<string, any>();
  for (const e of episodes) {
    if (e.scene_season_number != null && e.scene_episode_number != null) bySceneKey.set(`${e.scene_season_number}:${e.scene_episode_number}`, e);
  }
  // Numbered the way computeAbsoluteEpisodeNumber counts: every episode of the earlier seasons, specials excluded.
  const byAbsolute = new Map<number, any>();
  if (seasonNumber > 0) {
    const before = Number(
      (
        (await db
          .prepare("SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0 AND season_number < ?")
          .get(itemId, seasonNumber)) as { c: number | string }
      ).c
    );
    [...episodes].sort((a, b) => Number(a.episode_number) - Number(b.episode_number)).forEach((e, i) => byAbsolute.set(before + i + 1, e));
    // Rows that carry their own numbers (a sequel's: 25..36) are found by them instead.
    if (episodes.length > 0 && episodes.every((e) => e.absolute_episode_number != null)) {
      byAbsolute.clear();
      for (const e of episodes) byAbsolute.set(Number(e.absolute_episode_number), e);
    }
  }

  type ParsedFile = { src: string; rank: number; numbers?: number[]; season?: number | null; otherSeason?: boolean; airDate?: string; absolute?: number; bare?: number };
  const parsedFiles: ParsedFile[] = files.map((src) => {
    const base = withoutVersionTag(path.basename(src, path.extname(src)));
    const folder = path.basename(path.dirname(src));
    const detected = detectSeasonEpisode(folder, base);
    // Another season's file (the next season's opener in a multi-season pack) is not placed, but it
    // is an episode file the download still holds, so it counts as unmatched and keeps the data.
    if (detected.episodes.length > 0) {
      // A season that is the scene's name for some of this season's episodes is not another season's.
      const sceneNamed = detected.season !== null && detected.episodes.some((n) => bySceneKey.has(`${detected.season}:${n}`));
      const foreignSeason = detected.season !== null && detected.season !== seasonNumber && !sceneNamed;
      // Specials (S00) bundled into a pack are left in place without keeping the data, as before.
      return { src, rank: 1, numbers: foreignSeason ? [] : detected.episodes, season: detected.season, otherSeason: foreignSeason && detected.season! > 0 };
    }
    const own = parseReleaseTitle(base);
    if (own.airDate) return { src, rank: 2, airDate: own.airDate };
    if (own.absoluteEpisode != null) return { src, rank: 2, absolute: own.absoluteEpisode };
    const folderRelease = parseReleaseTitle(folder);
    const bare = folderRelease.isFullSeason && folderRelease.seasonNumber === seasonNumber ? BARE_EPISODE.exec(base) : null;
    if (bare) return { src, rank: 3, bare: Number(bare[1]) };
    return { src, rank: 0 };
  });

  const absolutes = parsedFiles.filter((p) => p.absolute != null).map((p) => p.absolute!);
  const seasonNumbering = absolutes.length > 0 && !absolutes.every((n) => byAbsolute.has(n)) && absolutes.every((n) => byNumber.has(n));

  let unmatchedCount = 0;
  const candidates: { src: string; rank: number; episodes: any[] }[] = [];
  for (const p of parsedFiles) {
    let targets: any[] = [];
    let isEpisodeFile = true;
    if (p.numbers) {
      targets = p.numbers
        .map((n) => (p.season != null ? bySceneKey.get(`${p.season}:${n}`) : undefined) ?? (p.season == null || p.season === seasonNumber ? byNumber.get(n) : undefined))
        .filter((e) => !!e);
      isEpisodeFile = p.numbers.length > 0 || !!p.otherSeason;
    } else if (p.airDate) {
      const sameDay = episodes.filter((e) => String(e.air_date ?? "").slice(0, 10) === p.airDate);
      targets = sameDay.length === 1 ? sameDay : [];
    } else if (p.absolute != null) {
      const e = seasonNumbering ? byNumber.get(p.absolute) : byAbsolute.get(p.absolute);
      targets = e ? [e] : [];
    } else if (p.bare != null) {
      const e = byNumber.get(p.bare);
      targets = e ? [e] : [];
    } else {
      isEpisodeFile = false;
    }
    if (targets.length === 0) {
      log.warn(`[importer] couldn't match "${path.basename(p.src)}" to a known episode of season ${seasonNumber} for "${itemTitle}" — left in place`);
      // An episode file (of this season or another) keeps the download's data; extras, NCOP/NCED and
      // menus don't, or nearly every pack's data would have stayed with no queue row left to clean it.
      if (isEpisodeFile) unmatchedCount++;
      continue;
    }
    candidates.push({ src: p.src, rank: p.rank, episodes: targets });
  }

  const claimed = new Set<number>();
  const accepted = new Set<string>();
  for (const c of [...candidates].sort((a, b) => a.rank - b.rank)) {
    if (c.episodes.some((e) => claimed.has(e.id))) {
      log.warn(`[importer] "${path.basename(c.src)}" maps to an episode another file of this pack already fills — left in place`);
      unmatchedCount++;
      continue;
    }
    for (const e of c.episodes) claimed.add(e.id);
    accepted.add(c.src);
  }
  return { plans: candidates.filter((c) => accepted.has(c.src)).map(({ src, episodes: eps }) => ({ src, episodes: eps })), unmatchedCount };
}

/**
 * Imports a full-season pack download — a folder with one video file per episode, no single
 * episodeId to place against. Same "walk every sibling file next to the anchor" shape as
 * placeAlbumFiles, but maps each file to an episode (see planSeasonPackFiles). A file whose parsed
 * episode doesn't match any known episode of the target season is left in place rather than moved
 * blind — better to leave one file for manual handling than silently misplace it; `unmatchedCount`
 * reports how many episode files of this season were, and `leftInPlace` how many other files a shared
 * folder still holds, so the caller keeps the download's data around for them.
 *
 * An episode that already has a file only gets the pack's when that is a quality upgrade for it —
 * the same strictly-better rule an upgrade grab is held to. A pack grabbed for one missing or
 * below-cutoff episode otherwise replaced every other episode's file with its own, Remux and Bluray
 * files with a WEB-DL, and recycled them. `notUpgradedCount` counts the files left in the download
 * for that reason, whose data the caller keeps too.
 */
export async function placeSeasonPackFiles(params: {
  itemId: number;
  seasonNumber: number;
  anchorFile: string;
  quality: string | null;
  /** The grabbed release's title, client-reported folder and client category — see collectSeasonPackFiles. */
  releaseTitle?: string;
  downloadPath?: string | null;
  category?: string | null;
  /** Automatic import: each file is checked against the series' identity before it is placed
   * (fileContradictsTarget); a file that fails stays in the download and counts as unmatched. */
  verify?: boolean;
}): Promise<{
  destFolder: string;
  episodeCount: number;
  unmatchedCount: number;
  leftInPlace: number;
  notUpgradedCount: number;
  packDir: string | null;
}> {
  const { itemId, seasonNumber, anchorFile, quality, releaseTitle, downloadPath, category, verify } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);
  await assertRootFolderMounted(rootFolder);

  const ctx: DownloadContext = { releaseTitle, downloadPath, category };
  const { files: siblings, leftInPlace, packDir } = collectSeasonPackFiles(anchorFile, seasonNumber, typeConfig.extensions, ctx);

  // A file evidently of another show (a shared folder's, a mislabeled pack's) stays in the download.
  // Judged before the files are mapped to episodes, so a foreign file never claims an episode the
  // show's own file of it would have taken.
  let identityRejected = 0;
  const identityTarget = verify ? await importTargetFor(item) : identityTargetOf(item);
  let unworthy = 0;
  let ownFiles = siblings.filter((src) => {
    const mismatch = verify ? fileContradictsTarget(src, ctx, identityTarget) : null;
    if (!mismatch) return true;
    log.warn(`[importer] left "${path.basename(src)}" in the download: ${mismatch}`);
    identityRejected++;
    return false;
  });
  // A dangerous file in the pack refuses all of it; a sample or a silent file is only left out.
  if (verify && packDir) {
    const bad = findRejectedFile(packDir, item.type);
    if (bad) throw new ImportSkippedError(`Not importing: the download holds "${path.basename(bad)}", a file type that is rejected — left in the download for a manual import`);
  }
  if (verify) {
    const kept: string[] = [];
    for (const src of ownFiles) {
      try {
        await assertFileIsWorthImporting(src, item.type, mediaRow.runtime_minutes, ctx, true, false);
        kept.push(src);
      } catch (err) {
        if (!(err instanceof ImportSkippedError)) throw err;
        log.warn(`[importer] left "${path.basename(src)}" in the download: ${err.message}`);
        unworthy++;
      }
    }
    ownFiles = kept;
  }
  if (ownFiles.length === 0 && identityRejected > 0) {
    throw new ImportIdentityMismatchError(`Not importing: every file of this download names another title than "${item.title}" — left for a manual import`);
  }
  if (ownFiles.length === 0 && unworthy > 0) {
    throw new ImportSkippedError(`Not importing: every file of this download is a sample, has no audio or is too short to be the release — left for a manual import`);
  }

  const episodes = (await db
    .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ?")
    .all(itemId, seasonNumber)) as any[];
  const planned = await planSeasonPackFiles(ownFiles, episodes, itemId, seasonNumber, item.title);
  // An identity-rejected file is an episode file the download still holds.
  let unmatchedCount = planned.unmatchedCount + identityRejected + unworthy;

  let notUpgradedCount = 0;
  const groups = await qualityGroupsOfProfile(item.qualityProfileId);
  const toPlace = planned.plans.filter(({ src, episodes: targets }) => {
    const better = targets.find((e) => Number(e.has_file) && !isQualityUpgrade(item.type, quality, e.quality, releaseTitle, e.file_release_title, groups));
    if (!better) return true;
    log.info(
      `[importer] left "${path.basename(src)}" in the download: "${quality ?? "unknown"}" is not an upgrade over episode ${better.episode_number}'s "${better.quality ?? "unknown"}" file`
    );
    notUpgradedCount++;
    return false;
  });
  if (toPlace.length === 0) {
    if (notUpgradedCount > 0) {
      throw new ImportSkippedError(
        `Not an upgrade: every episode of season ${seasonNumber} this download matched already has a file of the same or better quality — left in the download`
      );
    }
    throw new NoPackFileMatchedError(`No files in this download could be matched to a known episode of season ${seasonNumber}`);
  }

  await assertEnoughFreeSpaceForImport(toPlace.map((p) => p.src), rootFolder.path, rootFolder.minFreeSpaceGb);

  let importedCount = 0;
  let upgradedCount = 0;
  let destFolder = "";
  const replacedPaths: (string | null)[] = [];
  const placedPaths: string[] = [];
  const packFinishing: { dest: string; ext: string; rowIds: number[] }[] = [];
  const usedDestinations = new Set<string>();
  let packFolderSegments: string[] | null = null;
  for (const { src, episodes: targetEpisodes } of toPlace) {
    // A Sonarr-style multi-episode file within the pack (e.g. "S01E01-E02.mkv") resolves to every
    // one of this season's own episode rows it actually covers, not just the first.
    const covered = [...targetEpisodes].sort((a, b) => Number(a.episode_number) - Number(b.episode_number));
    const primary = covered[0];
    const primaryEpisodeNumber = Number(primary.episode_number);

    // Season 0 (specials) is excluded from the running count — see the identical comment in
    // placeFile() above.
    const absoluteEpisode = Number(
      (
        (await db
          .prepare(
            `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
           AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
          )
          .get(itemId, seasonNumber, seasonNumber, primaryEpisodeNumber)) as { c: number }
      ).c
    );
    const packTemplate = getNamingTemplate(item.type);
    const placedFolder = await withItemFolder(
      item,
      rootFolder.path,
      renderPathSegments(
        packTemplate,
        episodicNameVars(item, {
          season: seasonNumber,
          numbers: covered.map((e) => Number(e.episode_number)),
          absoluteEpisode,
          airDate: primary.air_date ?? null,
          episodeTitle: primary.title ?? null,
          quality,
          releaseTitle,
        }),
        path.extname(src)
      ),
      packTemplate
    );
    const segments = placedFolder.segments;
    packFolderSegments ??= segments.slice(0, placedFolder.folderLength);
    const ext = path.extname(src);
    const { destPath: dest, fileLabel } = resolveDest(rootFolder.path, segments, ext, src, getNamingEnabled(item.type));
    const destKey = path.resolve(dest).toLowerCase();
    if (usedDestinations.has(destKey)) {
      log.warn(`[importer] "${path.basename(src)}" would land on "${dest}", which another file of this pack just took — left in place`);
      unmatchedCount++;
      continue;
    }
    usedDestinations.add(destKey);
    // A destination another entry's file, or a file nothing tracks, holds is not overwritten: this file stays
    // in the download like any other the pack could not place, and the rest of the pack still imports.
    if (
      (await isFileOfAnotherRow(dest, item.id, covered.map((e) => Number(e.id)), null)) ||
      destinationVerdict(src, dest, covered.map((e) => e.file_path)) === "refuse"
    ) {
      log.warn(`[importer] "${path.basename(src)}" would land on "${dest}", which is already a file this pack does not replace — left in place`);
      unmatchedCount++;
      continue;
    }
    destFolder = path.dirname(dest);
    await placeAtDestination(src, dest, item, covered.map((e) => e.file_path));
    placedPaths.push(src, dest);

    // The rows are written first and the slow steps (subtitle provider, ffprobe) follow, as in placeFile.
    const sizeBytes = await fsp.stat(dest).then((s) => s.size).catch(() => null);
    // The pack's own title stands for each file's release: a later REPACK of the pack is the same group's.
    const packRecord = await releaseRecordFor(item, releaseTitle, null);
    for (const targetEpisode of covered) {
      const upgraded = !!Number(targetEpisode.has_file);
      if (upgraded) {
        replacedPaths.push(targetEpisode.file_path);
        upgradedCount++;
      }
      await db
        .prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ?, size_bytes = ?, file_release_title = ?, file_format_score = ? WHERE id = ?")
        .run(dest, quality, null, sizeBytes, packRecord.title, packRecord.score, targetEpisode.id);
      // One row per episode, with episodeId/quality set — the same shape placeFile's single-episode
      // path uses, and what duplicates.ts's repeated-import grouping keys on. A single season-level
      // summary row here (as this used to write) collapsed every season-pack import of this series
      // to the same "media item, no episode/sub-item" key, so importing two different seasons looked
      // like one item repeatedly re-imported. A multi-episode file gets one history row per episode
      // it actually covers, same reasoning.
      await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
        item.id,
        importedHistoryData({
          fileLabel,
          destPath: dest,
          episodeId: targetEpisode.id,
          subItemId: null,
          quality: quality ?? null,
          ...(upgraded ? { upgraded: true, previousQuality: targetEpisode.quality ?? null } : {}),
        })
      );
    }
    importedCount += covered.length;
    // The same two steps as a single file's import: the air date as the file's date, the release's subtitles beside it.
    if (currentImportStrategy() !== "hardlink" && currentImportStrategy() !== "symlink") await applyFileDate(dest, primary.air_date ?? null);
    if (VIDEO_EXTENSIONS.has(ext.toLowerCase())) {
      await copyReleaseExtras(src, dest).catch((err) => log.warn(`[importer] could not copy the extra files of "${path.basename(src)}":`, (err as Error).message));
    }
    packFinishing.push({ dest, ext, rowIds: covered.map((e) => Number(e.id)) });
  }

  await markParentHasFile(item.id);
  if (packFolderSegments && importedCount > 0) await rememberItemFolder(item.id, packFolderSegments);
  await recycleReplacedFiles(replacedPaths, placedPaths, item);
  // Best effort, now that every row is written: a subtitle provider that stalls cannot hold the rows back.
  for (const { dest, ext, rowIds } of packFinishing) {
    try {
      if (VIDEO_EXTENSIONS.has(ext.toLowerCase())) {
        await withinTimeout(tryDownloadSubtitle(dest, item.id), POST_IMPORT_STEP_TIMEOUT_MS, `subtitle download for "${dest}"`);
      }
      const probed = await probeMediaInfo(dest);
      if (!probed) continue;
      for (const rowId of rowIds) {
        await db.prepare("UPDATE episodes SET media_info = ? WHERE id = ? AND file_path = ?").run(JSON.stringify(probed), rowId, dest);
      }
    } catch (err) {
      log.warn(`[importer] finishing "${dest}" after its import failed:`, (err as Error).message);
    }
  }
  const newCount = importedCount - upgradedCount;
  if (newCount > 0) await notifyImported(item.title, `season ${seasonNumber} pack — ${newCount} episode(s)`, destFolder, { mediaItemId: item.id });
  if (upgradedCount > 0) await notifyUpgraded(item.title, `season ${seasonNumber} pack — ${upgradedCount} episode(s) upgraded`, destFolder, { mediaItemId: item.id });
  log.info(
    `[importer] imported season ${seasonNumber} pack for "${item.title}": ${importedCount} episode(s)${upgradedCount > 0 ? `, ${upgradedCount} of them upgrades` : ""}`
  );
  return { destFolder, episodeCount: importedCount, unmatchedCount, leftInPlace, notUpgradedCount, packDir };
}

/**
 * Locates, moves, and links the downloaded file(s) for a completed queue entry. Throws on failure.
 * `manualSourceFile`, when given, skips the automatic `findDownloadedFile` fuzzy match entirely and
 * uses that exact path instead — the manual-import path (Activity page) for a file the automatic
 * matcher couldn't find or picked wrong; it's the admin's own explicit choice at that point, so no
 * confidence threshold applies the way it does for the automatic match.
 */
export async function importQueueItem(queueItemId: number, manualSourceFile?: string, overrideQuality?: string): Promise<void> {
  const row = (await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueItemId)) as any;
  const historyFacts = row ? queueHistoryFields(queueItemFromRow(row)) : {};
  return importHistoryContext.run(historyFacts, async () => {
    // A manual import that asked for a strategy keeps it; otherwise "auto" is decided by this download's protocol.
    if (strategyOverride.getStore() === undefined && getSetting("importStrategy") === "auto") {
      const client = row?.download_client_id
        ? ((await db.prepare("SELECT type FROM download_clients WHERE id = ?").get(row.download_client_id)) as { type: string } | undefined)
        : undefined;
      return withImportStrategy(autoStrategyFor(row?.protocol, client?.type), () => importQueueItemWithStrategy(queueItemId, manualSourceFile, overrideQuality));
    }
    return importQueueItemWithStrategy(queueItemId, manualSourceFile, overrideQuality);
  });
}

async function importQueueItemWithStrategy(queueItemId: number, manualSourceFile?: string, overrideQuality?: string): Promise<void> {
  const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueItemId);
  if (!queueRow) throw new Error(`Queue item ${queueItemId} not found`);
  const queueItem = queueItemFromRow(queueRow);

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(queueItem.mediaItemId);
  if (!mediaRow) throw new Error(`Media item ${queueItem.mediaItemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);

  // A discography is for several albums: its queue row has none of its own, and lists them in queue_targets.
  const discographyTargets =
    shape === "collection" && typeConfig.multiFilePerChild && !queueItem.subItemId && !queueItem.episodeId ? await queueTargetIds(queueItem.id) : [];
  if (
    discographyTargets.length === 0 &&
    shape === "collection" &&
    typeConfig.multiFilePerChild &&
    !queueItem.subItemId &&
    !queueItem.episodeId &&
    queueItem.seasonNumber == null &&
    parseReleaseTitle(queueItem.title).discography
  ) {
    // Every album it was grabbed for has since been removed or merged away: there is nothing to file it under.
    throw new ImportSkippedError(`"${queueItem.title}" was grabbed as a discography, but none of the albums it was for is left; remove it from the queue`);
  }

  let episodeTarget: EpisodeTarget | undefined;
  if (shape === "episodic" && queueItem.episodeId) {
    const epRow = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(queueItem.episodeId)) as any;
    if (!epRow) throw new Error(`Episode ${queueItem.episodeId} not found`);
    episodeTarget = item.seriesType === "daily" && epRow.air_date
      ? { airDate: epRow.air_date }
      : {
          season: epRow.season_number,
          episode: epRow.episode_number,
          sceneSeason: epRow.scene_season_number,
          sceneEpisode: epRow.scene_episode_number,
          absoluteEpisode: item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, epRow.season_number, epRow.episode_number) : null,
          sceneIndex: await sceneIndexFor(item.id),
        };
  }

  const clientRow = queueItem.downloadClientId
    ? ((await db.prepare("SELECT category, category_by_type FROM download_clients WHERE id = ?").get(queueItem.downloadClientId)) as
        | { category: string | null; category_by_type: string | null }
        | undefined)
    : undefined;
  // The category the download was grabbed under: the client's per-type one for this title's type, else its default.
  const ctx: DownloadContext = {
    releaseTitle: queueItem.title,
    downloadPath: queueItem.downloadPath,
    category: clientRow ? categoryForType({ category: clientRow.category, categoryByType: parseCategoryByType(clientRow.category_by_type) }, item.type) : null,
  };

  // Sonarr/Radarr's "matched by indexer id only" rule: an automatic grab confirmed by the indexer's
  // id while its title named something else is held for the admin, who sees both titles. A manual
  // grab (the admin already chose it), a row from before match_type existed, and a type whose gate
  // isn't enforcing all import as before.
  if (
    !manualSourceFile &&
    queueItem.matchType === "id" &&
    queueItem.grabSource != null &&
    queueItem.grabSource !== "interactive" &&
    usesQualityTiers(item.type) &&
    identityModeFor(item.type) === "enforce"
  ) {
    throw new ImportSkippedError(
      `"${queueItem.title}" was matched to "${item.title}" by the indexer's id only, not by its title — left for a manual import`
    );
  }

  // A download named by a scene number that was only carried forward from TheXEM's last mapping may be the
  // wrong episode: held for a manual import (the same hold Sonarr puts on unverified scene numbering).
  if (!manualSourceFile && queueItem.episodeId && usesQualityTiers(item.type)) {
    const ep = (await db
      .prepare("SELECT season_number, episode_number, scene_season_number, scene_episode_number, scene_unverified FROM episodes WHERE id = ?")
      .get(queueItem.episodeId)) as
      | { season_number: number; episode_number: number; scene_season_number: number | null; scene_episode_number: number | null; scene_unverified: number | null }
      | undefined;
    if (ep && Number(ep.scene_unverified ?? 0) && ep.scene_season_number != null && ep.scene_episode_number != null) {
      const parsed = parseReleaseTitle(queueItem.title);
      const names = (season: number, episode: number) => parsed.seasonNumber === season && !!parsed.episodeNumbers?.includes(episode);
      if (names(Number(ep.scene_season_number), Number(ep.scene_episode_number)) && !names(Number(ep.season_number), Number(ep.episode_number))) {
        throw new ImportSkippedError(
          `"${queueItem.title}" is numbered S${String(ep.scene_season_number).padStart(2, "0")}E${String(ep.scene_episode_number).padStart(2, "0")}, a scene number carried forward from TheXEM's last mapping and not confirmed — left for a manual import`
        );
      }
    }
  }

  let sourceFile: string | null;
  let unpackFailures: { archive: string; reason: string }[] = [];
  let locateReason: LocateReason | undefined;
  if (manualSourceFile) {
    const resolvedDownloadsDir = path.resolve(config.downloadsDir);
    const resolved = path.resolve(manualSourceFile);
    if (resolved !== resolvedDownloadsDir && !resolved.startsWith(resolvedDownloadsDir + path.sep)) {
      throw new Error("Selected file must be inside the downloads directory");
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("Selected file no longer exists");
    }
    sourceFile = resolved;
  } else {
    const unpacked = await unpackDownloadedArchives({ downloadPath: queueItem.downloadPath ?? null, releaseTitle: queueItem.title, mediaType: item.type });
    unpackFailures = unpacked.failed;
    const childRow =
      shape === "collection" && !typeConfig.multiFilePerChild && queueItem.subItemId
        ? ((await db.prepare("SELECT title FROM sub_items WHERE id = ?").get(queueItem.subItemId)) as { title: string } | undefined)
        : undefined;
    const located = locateDownloadedFile(queueItem.title, item.type, episodeTarget, queueItem.downloadPath, {
      childTitle: childRow?.title ?? null,
      category: ctx.category,
    });
    sourceFile = located.file;
    locateReason = located.reason;
    if (sourceFile && unpackFailures.length > 0 && !isUnpackedMediaCandidate(sourceFile, queueItem.downloadPath, queueItem.title)) sourceFile = null;
  }
  if (!sourceFile && !manualSourceFile && (await releaseAlreadyImported(queueItem, shape))) {
    // A restart cut off the end of an earlier attempt: the file was moved into the library and its row
    // written (with this release's title) before the download was cleaned up. Finish the cleanup;
    // failing here would blocklist a release that imported fine and grab another.
    await db.prepare(`DELETE FROM queue WHERE id = ?`).run(queueItemId);
    notifyQueueChanged();
    log.info(`[importer] "${queueItem.title}" was already imported before a restart; its queue entry is cleared`);
    return;
  }
  if (!sourceFile) {
    // The media may well be inside an archive this server couldn't unpack (no unrar/7z, a password):
    // a local problem, not the release's, so it's left for a manual import rather than blocklisted.
    if (unpackFailures.length > 0) {
      throw new ImportSkippedError(
        `No matching file found in downloads directory for "${queueItem.title}"; couldn't unpack: ${unpackFailures
          .map((f) => `${path.basename(f.archive)}: ${f.reason}`)
          .join("; ")}`
      );
    }
    // The client said where the download is and nothing there is importable: a disc image, a
    // folder of archives or extras. The release isn't at fault, so the row waits for a manual import.
    if (locateReason === "unsupported-extension") {
      throw new ImportSkippedError(`"${path.basename(queueItem.downloadPath ?? queueItem.title)}" is not a file type this library imports — left for a manual import`);
    }
    // A reported folder with no importable file in it (another show's episode, a sample alone, no
    // media at all) is the release's fault: it fails like any other bad release and is retried.
    if (locateReason === "nothing-in-reported-folder") {
      // A reported folder with no file in it at all is a mount or mapping problem, not a bad release.
      if (!folderHasAnyFile(queueItem.downloadPath)) {
        throw new ImportSkippedError(
          `The download client reports "${queueItem.downloadPath}", but nothing is in it as AoNarr sees it — check the download folder mount and the Remote Path Mappings; left for a manual import`
        );
      }
      throw new ReleaseFaultError(`No matching file found in the download's folder for "${queueItem.title}" (the rest of the downloads directory is not searched)`);
    }
    // The client's path is not there for AoNarr, or the downloads folder is empty: it cannot see the
    // download, which says nothing against the release.
    if (queueItem.downloadPath && !fs.existsSync(queueItem.downloadPath)) {
      throw new ImportSkippedError(
        `The download client reports "${queueItem.downloadPath}", which AoNarr cannot see — check the download folder mount and the Remote Path Mappings; left for a manual import`
      );
    }
    if (!downloadsFolderHasEntries()) {
      throw new ImportSkippedError("The downloads folder is empty or unreadable — check that it is mounted; left for a manual import");
    }
    throw new ReleaseFaultError(`No matching file found in downloads directory for "${queueItem.title}"`);
  }

  // Interactive-Import-style override: the admin's own explicit choice on the Activity page's
  // "Manual import..." picker, for when the automatic quality detection (parsed from the release
  // title at grab time) guessed wrong — only ever applies to a manual import, an automatic one
  // always uses the parsed value as before.
  const quality = overrideQuality ?? queueItem.quality;

  // The file is checked against the item's identity before it is placed, except when the admin chose
  // it: a manual import's file, or any file of a release the admin grabbed from the interactive search.
  // The exception: a file the downloads-wide search found, because the client's own path is missing,
  // stale or unmapped, is checked like any other: it may be another download's file, and importing it
  // moved that download's data out from under its own torrent.
  const interactive = queueItem.grabSource === "interactive";
  // A client that reported no path at all is the same case: the file was found by searching the whole downloads
  // folder, and nothing says it is this download's (isWithinReportedDownload is false for a missing path).
  const foundOutsideReportedDownload = !manualSourceFile && !isWithinReportedDownload(sourceFile, queueItem.downloadPath);
  const verify = manualSourceFile || (interactive && !foundOutsideReportedDownload) ? undefined : ctx;
  // Only an automatic import is held to the downgrade check: the admin chose the other two.
  const automatic = !manualSourceFile && !interactive;

  // Files left in place that may belong to this download — their data must outlive the download's removal.
  let leftFilesBehind = false;
  // The download's own folder, removed once only junk is left in it; null when it has none.
  let releaseDir: string | null = null;
  // Set when what was placed may be only part of the download (one episode of a pack, one book of
  // a trilogy, one album of a discography).
  let mayHoldMore = false;
  if (discographyTargets.length > 0) {
    const releaseRoot = discographyRootOf(sourceFile, queueItem.downloadPath, queueItem.title, ctx.category);
    if (!releaseRoot) {
      throw new ImportSkippedError(`Cannot tell which folder holds the discography "${queueItem.title}" — left for a manual import`);
    }
    const done = await placeDiscographyFiles({
      itemId: item.id,
      targetSubItemIds: discographyTargets,
      releaseDir: releaseRoot,
      quality,
      releaseTitle: queueItem.title,
      category: ctx.category,
      refuseDowngrade: automatic,
      // A file the admin picked stands for its own album: just that folder is imported, from the folder it is in.
      ...(manualSourceFile ? { onlyFolder: albumFolderOfFile(sourceFile, releaseRoot), trustFolder: true } : {}),
    });
    leftFilesBehind = done.leftBehind;
    releaseDir = releaseRoot;
    // The albums this download has settled, imported or not in it, no longer wait on it. An album whose folder was found
    // and could not be placed keeps its link: the row stays, parked, and holds it from the searches (and from a second
    // grab of the same release) until the admin has seen why.
    const settled = [...done.imported.map((album) => album.subItemId), ...done.notFound, ...done.alreadyHad];
    for (const id of settled) await db.prepare("DELETE FROM queue_targets WHERE queue_id = ? AND sub_item_id = ?").run(queueItem.id, id);
    if (!manualSourceFile && (done.notFound.length > 0 || done.failed.length > 0)) {
      // The release was not what it said, or part of it cannot be filed: this release is not taken again, and the albums
      // it lacks are looked for one by one.
      await addToBlocklist({
        mediaItemId: item.id,
        releaseTitle: queueItem.title,
        indexerId: queueItem.indexerId ?? null,
        reason:
          done.notFound.length > 0
            ? `Imported without ${done.notFound.length} album(s) it was grabbed for`
            : `${done.failed.length} album(s) of it could not be filed`,
        protocol: queueItem.protocol ?? null,
        size: queueItem.size ?? null,
        publishDate: queueItem.publishDate ?? null,
        infoHash: queueItem.infoHash ?? null,
      });
      for (const id of done.notFound) await wakeLeaf("sub_items", id);
    }
    const waiting = await queueTargetIds(queueItem.id);
    if (waiting.length > 0) {
      const reason = done.failed.length > 0
        ? `Imported ${done.imported.length} album(s) of "${queueItem.title}"; ${done.failed.length} could not be placed (${done.failed.map((f) => `"${f.title}": ${f.reason}`).join("; ")}) — left for a manual import`
        : `${waiting.length} album(s) of "${queueItem.title}" are still to be imported`;
      if (!manualSourceFile) throw new ImportSkippedError(reason);
      // A manual import of one album is done; the row keeps the rest and is parked like any import left for the admin, so
      // that neither a restart's resume nor the week-old failed-row clean-up takes it.
      await db
        .prepare(
          `UPDATE queue SET import_started_at = NULL, import_skipped_reason = ?, import_resume_state = CASE WHEN import_resume_state = 3 THEN 0 ELSE import_resume_state END, updated_at = ${nowExpr(db)} WHERE id = ?`
        )
        .run(reason, queueItem.id);
      notifyQueueChanged();
      return;
    }
    // The last album of a manual import: the download is whole in the library, apart from whatever folders it still holds.
    if (manualSourceFile) leftFilesBehind = withoutSamples(walk(releaseRoot, getMediaTypeConfig(item.type).extensions, 6), releaseRoot, queueItem.title).length > 0;
  } else if (shape === "collection" && typeConfig.multiFilePerChild && queueItem.subItemId) {
    const album = await placeAlbumFiles({
      itemId: item.id,
      subItemId: queueItem.subItemId,
      anchorFile: sourceFile,
      quality,
      releaseTitle: queueItem.title,
      downloadPath: queueItem.downloadPath,
      category: ctx.category,
      refuseDowngrade: automatic,
    });
    leftFilesBehind = album.leftInPlace > 0;
    releaseDir = album.sourceFolder ? ownReleaseFolderOf(sourceFile, ctx, album.sourceFolder) : null;
    mayHoldMore = true;
  } else if (
    shape === "episodic" &&
    queueItem.seasonNumber != null &&
    // A full-season pack grabbed for one of its episodes brings the whole season along — importing
    // just that one episode left the rest to be searched for (and the same pack grabbed) again.
    (!queueItem.episodeId || (!manualSourceFile && parseReleaseTitle(queueItem.title).isFullSeason))
  ) {
    try {
      const pack = await placeSeasonPackFiles({
        itemId: item.id,
        seasonNumber: queueItem.seasonNumber,
        anchorFile: sourceFile,
        quality,
        releaseTitle: queueItem.title,
        downloadPath: queueItem.downloadPath,
        category: ctx.category,
        verify: !!verify,
      });
      // unmatchedCount already counts every episode file the planner left in the download: another
      // season's, another show's, a duplicate. (A post-placement walk would make a bundled special's
      // fate depend on which file was the anchor.)
      leftFilesBehind = pack.unmatchedCount > 0 || pack.leftInPlace > 0 || pack.notUpgradedCount > 0;
      releaseDir = pack.packDir;
    } catch (err) {
      // A pack grabbed for one episode whose files can't be mapped to episodes may still hold that
      // episode's own file — but only one whose own name says so: findDownloadedFile falls back on
      // the pack folder's name, which fits every file of it, and then takes the largest.
      if (
        !(err instanceof NoPackFileMatchedError) ||
        !queueItem.episodeId ||
        !episodeTarget ||
        !nameIdentifiesEpisode(path.basename(sourceFile, path.extname(sourceFile)), episodeTarget)
      ) {
        throw err;
      }
      const epRow = (await db.prepare("SELECT episode_number, has_file, quality, file_release_title FROM episodes WHERE id = ?").get(queueItem.episodeId)) as
        | { episode_number: number; has_file: number; quality: string | null; file_release_title: string | null }
        | undefined;
      if (epRow && Number(epRow.has_file) && !isQualityUpgrade(item.type, quality, epRow.quality, queueItem.title, epRow.file_release_title, await qualityGroupsOfProfile(item.qualityProfileId))) {
        throw new ImportSkippedError(
          `Not an upgrade: episode ${epRow.episode_number} already has a "${epRow.quality ?? "unknown"}" file, and this download is "${quality ?? "unknown"}"`
        );
      }
      await placeFile({ itemId: item.id, episodeId: queueItem.episodeId, subItemId: null, sourceFile, quality, verify, releaseTitle: queueItem.title, refuseDowngrade: automatic });
      releaseDir = ownReleaseFolderOf(sourceFile, ctx);
      mayHoldMore = true;
    }
  } else {
    await placeFile({
      itemId: item.id,
      episodeId: queueItem.episodeId,
      subItemId: queueItem.subItemId,
      sourceFile,
      quality,
      verify,
      releaseTitle: queueItem.title,
      refuseDowngrade: automatic,
    });
    releaseDir = ownReleaseFolderOf(sourceFile, ctx);
    // A ROM is a single item but a multi-disc game is several files (Disc 1, Disc 2, a .cue and its
    // .bin tracks): importing one must not have the client delete the rest with the download.
    mayHoldMore = shape !== "single" || item.type === "rom";
  }
  // A manual import of one episode of a pack, or one book of a trilogy, otherwise had the client
  // delete the rest of the download with it. A download with no folder of its own (a multi-file
  // torrent saved straight into its category folder) can't be told apart from the other downloads
  // there, so any media still in the folder the client reported keeps its data.
  const leftoverDir = releaseDir ?? (queueItem.downloadPath && isDirectory(queueItem.downloadPath) ? queueItem.downloadPath : null);
  if (mayHoldMore && !leftFilesBehind && leftoverDir && releaseHoldsMoreMedia(leftoverDir, typeConfig.extensions, shape, sourceFile)) {
    leftFilesBehind = true;
  }

  // The queue row is deleted outright rather than left at status='imported' — the 'imported' event
  // this call just recorded in the `history` table (above, in placeFile/placeAlbumFiles/
  // placeSeasonPackFiles) is already the permanent record the Activity page's Timeline reads from,
  // so there's nothing left for a finished queue row to still be useful for. Leaving it around was
  // the actual cause of the queue silently accumulating every successful import forever.
  await db.prepare(`DELETE FROM queue WHERE id = ?`).run(queueItemId);
  notifyQueueChanged();
  await recordGroupSuccess(parseReleaseTitle(queueItem.title).releaseGroup);

  // Hardlink and symlink imports exist to keep the download seeding in its client: removing it
  // there, even without its data, stopped seeding right after the import (a hit-and-run on a
  // private tracker) and left Seed Goal Cleanup nothing to act on.
  if (getSetting("removeCompletedDownloads") !== "0" && strategyDeletesSourceData()) {
    await removeQueueItemDownload(queueItem, !leftFilesBehind);
  } else if (currentImportStrategy() === "hardlink" && !leftFilesBehind) {
    // Everything of the download is now in the library by hardlink (or, across filesystems, as a copy): the
    // client marks it, and Seed Goal Cleanup may delete its data when seeding is over. Any other torrent
    // keeps its data, because it may hold the only copy.
    await markDownloadImported(queueItem);
  } else if (!leftFilesBehind && queueItem.indexerId && (await indexerHasSeedGoal(queueItem.indexerId))) {
    // The torrent keeps seeding with its data kept (a copy or a symlink): only the indexer's own seed goal is recorded on it.
    await markDownloadImported(queueItem, false);
  }
  if (!leftFilesBehind) cleanupDownloadSourceFolder(releaseDir, ctx);
}

/** True when the target of a queue row already has a file on disk that came from this very release
 * (the title recorded on its row): the import finished and only its clean-up was cut off. */
async function releaseAlreadyImported(queueItem: { id?: number; title: string; episodeId?: number | null; subItemId?: number | null; mediaItemId: number }, shape: MediaShape): Promise<boolean> {
  // A discography is imported when each album it was grabbed for has files that came from this very release.
  if (queueItem.id != null && !queueItem.episodeId && !queueItem.subItemId) {
    const targets = await queueTargetIds(queueItem.id);
    if (targets.length > 0) {
      const rows = (await db
        .prepare(`SELECT has_file, file_release_title AS t FROM sub_items WHERE id IN (${targets.map(() => "?").join(", ")})`)
        .all(...targets)) as { has_file: number | boolean | null; t: string | null }[];
      return rows.length === targets.length && rows.every((r) => !!Number(r.has_file) && r.t === queueItem.title);
    }
  }
  const row = (
    queueItem.episodeId
      ? await db.prepare("SELECT has_file, file_path AS p, file_release_title AS t FROM episodes WHERE id = ?").get(queueItem.episodeId)
      : queueItem.subItemId
      ? await db.prepare("SELECT has_file, file_path AS p, file_release_title AS t FROM sub_items WHERE id = ?").get(queueItem.subItemId)
      : shape === "single"
      ? await db.prepare("SELECT has_file, path AS p, file_release_title AS t FROM media_items WHERE id = ?").get(queueItem.mediaItemId)
      : undefined
  ) as { has_file: number | boolean | null; p: string | null; t: string | null } | undefined;
  return !!row && !!Number(row.has_file) && !!row.p && row.t === queueItem.title && fs.existsSync(row.p);
}

/** Whether `file` lies inside what the download client reported for the download (the file itself, its
 * folder, or the folder an archive it reported was unpacked into). False when the client reported
 * nothing, or a path that does not exist here: the file was then found by searching the downloads
 * directory, and nothing says it belongs to this download. */
function isWithinReportedDownload(file: string, downloadPath: string | null | undefined): boolean {
  if (!downloadPath || !fs.existsSync(downloadPath)) return false;
  const src = path.resolve(file);
  const reported = path.resolve(downloadPath);
  if (src === reported || src.startsWith(reported + path.sep)) return true;
  if (!isDirectory(reported) && isArchiveFile(reported)) return src.startsWith(path.resolve(archiveDestinationFor(reported)) + path.sep);
  return false;
}

/** Whether a file found for a download whose archive couldn't be unpacked may still be its media —
 * the media is most likely in that archive. A sample never is, nor is anything outside the folder
 * or file the client reported: the search falls back to the whole downloads directory, where it
 * turned up another download of the same title (an older grab still seeding). */
function isUnpackedMediaCandidate(sourceFile: string, downloadPath: string | null | undefined, releaseTitle: string): boolean {
  const src = path.resolve(sourceFile);
  let base = path.dirname(src);
  if (downloadPath && fs.existsSync(downloadPath)) {
    const reported = path.resolve(downloadPath);
    // A reported archive's contents live in the sibling folder named after it.
    const unpacked = !isDirectory(reported) && isArchiveFile(reported) ? path.resolve(archiveDestinationFor(reported)) : null;
    if (unpacked && src.startsWith(unpacked + path.sep)) base = unpacked;
    else if (src !== reported && !src.startsWith(reported + path.sep)) return false;
    else if (src !== reported) base = reported;
  }
  return !isSamplePath(src, base, releaseTitle);
}

/** True when the configured import strategy actually moves/copies the file's bytes out of the
 * downloads directory (the default "move" strategy, and cross-filesystem "hardlink" falls back to
 * a non-deleting copy — but this is about whether it's SAFE to delete the source, not which one
 * actually happened) — false for "hardlink"/"symlink", which both need the original data to keep
 * existing. Shared by the source-folder cleanup below and the download-client removal call, so
 * both agree on when destroying the original data is safe. */
function strategyDeletesSourceData(): boolean {
  const strategy = currentImportStrategy();
  return strategy !== "hardlink" && strategy !== "symlink" && strategy !== "copy";
}

/** Whether a download's folder still holds media the import didn't take — more episodes of a pack,
 * more books or albums of a collection. Samples don't count; neither does the imported file under
 * another format ("Title.mobi" beside the imported "Title.epub", a .cbr beside its .cbz), which
 * otherwise kept every multi-format ebook's download forever; and for a show neither does anything
 * not numbered as an episode (extras, featurettes). Only a file beside the imported one is another
 * format of it: a pack giving each book a folder of its own often names every file alike
 * ("The Final Empire/book.epub", "The Hero of Ages/book.epub"). */
function releaseHoldsMoreMedia(dir: string, extensions: string[], shape: MediaShape, importedFile: string): boolean {
  const importedName = comparableName(path.basename(importedFile, path.extname(importedFile)));
  const importedDir = path.resolve(path.dirname(importedFile));
  return walk(dir, extensions, 4).some((f) => {
    if (isSamplePath(f, dir)) return false;
    const base = path.basename(f, path.extname(f));
    if (path.resolve(path.dirname(f)) === importedDir && comparableName(base) === importedName) return false;
    if (shape !== "episodic") return true;
    const name = withoutVersionTag(base);
    const folder = path.basename(path.dirname(f));
    const own = parseReleaseTitle(name);
    return (
      detectSeasonEpisode(folder, name).episodes.length > 0 ||
      own.absoluteEpisode != null ||
      !!own.airDate ||
      (parseReleaseTitle(folder).isFullSeason && BARE_EPISODE.test(name))
    );
  });
}

function comparableName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Radarr/Sonarr's real "remove completed downloads" behavior: once a download's files are in the
 * library, what its own folder still holds (samples, .nfo, subtitles, the emptied folder itself) is
 * disposable too. Only ever the download's own folder (`releaseDir`, null when it has none), and
 * only while nothing but such leftovers remains in it: a single-file torrent's folder is its
 * client's category folder, and a recursive delete there took every other download in it —
 * unimported ROM zips, RAR sets, files still downloading. Walks upward removing whatever's now
 * empty above it, same as removeEmptyParents, never touching config.downloadsDir itself, and never
 * runs for "hardlink"/"symlink", which keep the download's data alive (continued seeding, or a
 * remote mount). Best-effort: a locked file or permissions error is logged and otherwise ignored,
 * same as every other filesystem side-effect in this module.
 */
function cleanupDownloadSourceFolder(releaseDir: string | null, ctx: DownloadContext): void {
  if (!releaseDir || !strategyDeletesSourceData()) return;
  if (getSetting("removeCompletedDownloads") === "0") return;

  const resolvedDownloadsDir = path.resolve(config.downloadsDir);
  const dir = path.resolve(releaseDir);
  if (dir === resolvedDownloadsDir || !dir.startsWith(resolvedDownloadsDir + path.sep)) return;
  if (!isOwnReleaseFolder(dir, ctx)) return;

  const kept = findNonJunkFile(dir, dir);
  if (kept) {
    log.info(`[importer] leaving ${dir} in place — still contains ${path.relative(dir, kept)}`);
    return;
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    removeEmptyParents(path.dirname(dir), resolvedDownloadsDir);
    log.info(`[importer] removed source download folder ${dir}`);
  } catch (err) {
    log.warn(`[importer] failed to remove source download folder ${dir}:`, (err as Error).message);
  }
}

// What a release folder may still hold besides its media and be removed whole.
const RELEASE_JUNK_EXTENSIONS = new Set([
  ".nfo", ".txt", ".sfv", ".srr", ".srs", ".md5", ".sha1", ".sha256", ".url", ".log", ".cue", ".m3u", ".m3u8",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".srt", ".sub", ".idx", ".ass", ".ssa", ".vtt", ".par2",
]);
const RELEASE_JUNK_NAMES = new Set(["thumbs.db", ".ds_store", "desktop.ini"]);

/** First file under `dir` that isn't a release's disposable leftover (a sample, .nfo, subtitle,
 * artwork, checksum), or null when only such leftovers remain. Anything else — another download's
 * media, an archive, a file still being written — keeps the folder. */
function findNonJunkFile(dir: string, root: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findNonJunkFile(full, root);
      if (nested) return nested;
      continue;
    }
    if (!entry.isFile()) return full;
    if (RELEASE_JUNK_NAMES.has(entry.name.toLowerCase())) continue;
    if (isSamplePath(full, root)) continue;
    if (RELEASE_JUNK_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    return full;
  }
  return null;
}

/** Same "Skip Free Space Check" guard placeFile() applies to a single file (see its own comment),
 * but for a multi-file move (a whole album, a whole season pack) — sums every source file's size
 * first so the check still runs against the operation's true total rather than being silently
 * skipped just because no single file in the batch happens to exceed free space alone. */
async function assertEnoughFreeSpaceForImport(sourceFiles: string[], rootFolderPath: string, rootMinFreeSpaceGb?: number | null): Promise<void> {
  if (getSetting("skipFreeSpaceCheck") === "1") return;
  try {
    // Off the main thread and raced against a timeout: these are the download and library mounts, and a share that
    // stopped answering used to freeze the whole server here. A mount that does not answer lets the import go on
    // (the catch below), where the move itself reports what is wrong.
    let totalSize = 0;
    for (const f of sourceFiles) totalSize += (await statAsync(f)).size;
    const stat = await statfsAsync(rootFolderPath);
    if (!stat) return;
    const freeBytes = stat.bavail * stat.bsize; // see placeFile: root-reserved blocks aren't ours
    const reserve = importReserveBytes(rootMinFreeSpaceGb);
    if (freeBytes < totalSize + reserve) {
      throw new ImportSkippedError(
        `Not enough free space at "${rootFolderPath}" (${Math.round(freeBytes / 1e9)}GB free, ${Math.round(totalSize / 1e9)}GB needed${reserve > 0 ? ` plus ${Math.round(reserve / 1e6)}MB kept free` : ""}) — kept for a manual import from Activity`
      );
    }
  } catch (err) {
    if (err instanceof ImportSkippedError) throw err;
    // Can't stat the source/destination filesystem — don't block the import over that; the move
    // itself will surface a clearer filesystem error if something's actually wrong.
  }
}

/** Removes now-empty directories left behind by a rename, walking upward from a file's old folder
 * but never touching the root folder itself or anything above it. */
export function removeEmptyParents(dir: string, rootFolderPath: string): void {
  const resolvedRoot = path.resolve(rootFolderPath);
  let current = path.resolve(dir);
  while (current !== resolvedRoot && current.startsWith(resolvedRoot + path.sep)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

export interface RenameResult {
  renamed: { title: string; from: string; to: string }[];
  errors: { title: string; error: string }[];
  skippedMusic: number;
}

/**
 * Retroactively re-renames every already-imported file for items whose naming template has
 * changed since they were imported — Sonarr/Radarr's "Rename Files" bulk action. Never touches
 * anything without a file yet, and only actually moves a file when the freshly-computed
 * destination differs from where it already is. Music and Audiobooks (multiFilePerChild shapes) are renamed in two
 * steps: an album's folder is moved to the one the template names, and the track files and audiobook parts inside it
 * are renamed to the track template (`namingArtistTrackTemplate`), each staying in the folder it is in. An album that
 * is a single file, is not a folder of its own, or shares its folder, is counted in `skippedMusic` (shared by both
 * types) so a caller isn't left thinking it was silently included.
 */
export async function renameLibraryFiles(mediaType?: MediaType, dryRun = false, mediaItemIds?: number[]): Promise<RenameResult> {
  const result: RenameResult = { renamed: [], errors: [], skippedMusic: 0 };

  const itemRows = (
    mediaItemIds && mediaItemIds.length > 0
      ? await db
          .prepare(
            `SELECT * FROM media_items WHERE id IN (${mediaItemIds.map(() => "?").join(",")})${mediaType ? " AND type = ?" : ""}`
          )
          .all(...mediaItemIds, ...(mediaType ? [mediaType] : []))
      : mediaType
      ? await db.prepare("SELECT * FROM media_items WHERE type = ?").all(mediaType)
      : await db.prepare("SELECT * FROM media_items").all()
  ) as any[];

  // Preview runs (dryRun) never touch anything and are cheap/instant even for a whole library, so
  // they aren't tracked as a background job — only a real, committing run shows up in the widget.
  // Selected-items runs share the same `kind:type` tracking slot as a whole-library run for that
  // type (see backgroundJobs.ts's id scheme) so the two can't overlap and double-move a file.
  const jobType = mediaType ?? "all";
  const selectedCount = mediaItemIds?.length ?? 0;
  const label =
    selectedCount > 0
      ? `Organize & Rename — ${selectedCount} selected item(s)${mediaType ? ` (${getMediaTypeConfig(mediaType).label})` : ""}`
      : `Organize & Rename — ${mediaType ? getMediaTypeConfig(mediaType).label : "All Libraries"}`;
  const jobId = !dryRun ? startBackgroundJob("organize", jobType, label, itemRows.length) : null;
  let errorMessage: string | undefined;
  try {
    for (const mediaRow of itemRows) {
      const renamedBefore = result.renamed.length;
      await renameOneItemRow(mediaRow, result, undefined, dryRun);
      if (!dryRun) await recordRenames((mediaRow as any).id, result.renamed.slice(renamedBefore));
      if (jobId) incrementBackgroundJobDone("organize", jobType);
    }
  } catch (err) {
    errorMessage = (err as Error).message;
    throw err;
  } finally {
    if (jobId) finishBackgroundJob(jobId, errorMessage);
  }

  if (result.renamed.length > 0 && !dryRun) {
    log.info(`[importer] renamed ${result.renamed.length} file(s) to match the current naming template`);
  }
  return result;
}

/** True while a real (non-preview) Organize & Rename run is in progress for a type ("all" for the
 * no-type/whole-instance run) — checked by the route before starting another one, same guard
 * scan/refresh/match-providers already use. */
export function isOrganizeRunning(mediaType?: MediaType): boolean {
  return isBackgroundJobRunning("organize", mediaType ?? "all");
}

/** Per-item version of renameLibraryFiles, for the "Organize & Rename" button on a single media
 * page — same logic, scoped to just this item's own file(s) instead of a whole library.
 * `onlySeasonNumber`, when given, is the season toolbar's "Organize & Rename" button — only that
 * season's episodes are considered (meaningless for non-episodic shapes, so ignored there). */
/** One `renamed` history row per file Organize & Rename moved, so "why is this file here" has an answer (DL17). */
async function recordRenames(mediaItemId: number, renames: { title: string; from: string; to: string }[]): Promise<void> {
  for (const r of renames) {
    await db.prepare("INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'renamed', ?)").run(mediaItemId, JSON.stringify({ label: r.title, from: r.from, to: r.to }));
  }
}

export async function renameOneMediaItem(mediaItemId: number, onlySeasonNumber?: number, dryRun = false): Promise<RenameResult> {
  const result: RenameResult = { renamed: [], errors: [], skippedMusic: 0 };
  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId);
  if (mediaRow) {
    await renameOneItemRow(mediaRow, result, onlySeasonNumber, dryRun);
    if (!dryRun) await recordRenames(mediaItemId, result.renamed);
  }
  // Sonarr's "On Rename": told once per title, not per file.
  if (mediaRow && !dryRun && result.renamed.length > 0) notifyRenamed(String((mediaRow as any).title), result.renamed.length, { mediaItemId, renamed: result.renamed.map((r) => ({ from: r.from, to: r.to })) }).catch(() => undefined);
  return result;
}

/** Why renaming `src` onto `dest` must not happen, or null when it can. A different file already
 * there — or another file of this item bound for the same name, like two lessons' "Introduction.mp4"
 * with naming disabled — was silently overwritten, leaving two rows on the one surviving file. */
function renameConflict(src: string, dest: string, claimed: Set<string>): string | null {
  const key = path.resolve(dest);
  if (claimed.has(key)) return `Another file of this item is also being renamed to "${dest}" — not overwriting it`;
  claimed.add(key);
  if (isOtherExistingEntry(src, dest)) return `A different file already exists at "${dest}" — not overwriting it`;
  return null;
}

/** True when something other than `src` itself (a case-only rename on a case-insensitive
 * filesystem finds src there) occupies `dest`, dangling symlinks included. */
export function isOtherExistingEntry(src: string, dest: string): boolean {
  let destStat: fs.Stats;
  try {
    destStat = fs.lstatSync(dest);
  } catch {
    return false;
  }
  try {
    const srcStat = fs.lstatSync(src);
    return srcStat.dev !== destStat.dev || srcStat.ino !== destStat.ino;
  } catch {
    return true;
  }
}

const SUBTITLE_SIDECAR_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt"]);
// Language/flag tags between a video's name and its subtitle's extension: "en", "pt-BR", "eng", "forced", "sdh".
export const SIDECAR_TAG_RE = /^(?:[a-z]{2,3}(?:-[a-z0-9]{2,4})?|forced|sdh|cc|hi)$/i;

/** The subtitle and .nfo files named for a media file ("Movie.nfo", "Movie.srt", "Movie.en.forced.srt"),
 * each with the suffix it keeps across a rename. */
function findSidecars(mediaPath: string): { file: string; suffix: string }[] {
  const dir = path.dirname(mediaPath);
  const mediaName = path.basename(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sidecars: { file: string; suffix: string }[] = [];
  for (const name of names) {
    if (name === mediaName || !name.startsWith(base + ".")) continue;
    const ext = path.extname(name).toLowerCase();
    const suffix = name.slice(base.length);
    const tags = suffix.slice(1, suffix.length - ext.length);
    const isSidecar =
      ext === ".nfo"
        ? tags === ""
        : SUBTITLE_SIDECAR_EXTENSIONS.has(ext) && (tags === "" || tags.split(".").every((t) => SIDECAR_TAG_RE.test(t)));
    if (isSidecar) sidecars.push({ file: path.join(dir, name), suffix });
  }
  return sidecars;
}

/**
 * Moves a show's folder (artwork, NFO, extras and all) to the name the naming template gives its current title, or to
 * `newName`, and points its episodes at it. Imports and renames keep a show in one folder, so this is the explicit
 * step for a title that changed; Sonarr's series "move files" does the same.
 */
export async function moveItemFolder(itemId: number, newName?: string): Promise<{ from: string; to: string; episodesUpdated: number }> {
  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  if (isTitleMoving(item.id)) throw new ImportSkippedError(`"${item.title}" is being moved to another root folder — try again when the move has finished`);
  if (effectiveShape(item) !== "episodic") throw new ImportSkippedError("Only a show has a folder of its own to move");
  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);
  if (rootFolder.readOnly) throw new ImportSkippedError(`Root folder "${rootFolder.path}" is a read-only library: its folders are not moved`);

  const template = namingTemplateFor(item);
  const own = ownFolderDepth(template, true);
  if (own === 0) throw new ImportSkippedError("The naming template has no folder of the show's own");
  const rendered = renderPathSegments(template, {
    parentTitle: item.title,
    season: 1,
    episode: 1,
    year: item.year ?? "",
    quality: "",
    ...titleVars("parent", item.title, item.year),
    ...providerIdVars(item),
  });
  const current = await withItemFolder(item, rootFolder.path, rendered, template);
  const currentSegments = current.segments.slice(0, current.folderLength);
  if (currentSegments.length === 0) throw new ImportSkippedError("The show has no folder of its own yet");
  // Only the show's own level is renamed; a category folder above it stays.
  const targetLast = newName && newName.trim() ? safePathSegment(newName.trim()) : rendered[own - 1];
  const targetSegments = [...currentSegments.slice(0, -1), targetLast];
  const from = path.join(rootFolder.path, ...currentSegments);
  const to = path.join(rootFolder.path, ...targetSegments);
  assertInsideRoot(rootFolder.path, to);
  if (from === to) return { from, to, episodesUpdated: 0 };

  let episodesUpdated = 0;
  if (fs.existsSync(from)) {
    // A folder two titles share (a category folder, or a remake that always lived beside its original) is not this show's to move.
    const allRoots = ((await db.prepare("SELECT path FROM root_folders").all()) as { path: string }[]).map((r) => path.resolve(r.path));
    if (allRoots.some((r) => r === path.resolve(from) || r.startsWith(path.resolve(from) + path.sep))) {
      throw new ImportSkippedError(`"${from}" is, or holds, a root folder — not moving it`);
    }
    const sharer = await trackedFileInside(from, item.id);
    if (sharer) throw new ImportSkippedError(`"${sharer}" belongs to another title in "${from}" — not moving a folder two titles share`);
    if (isOtherExistingEntry(from, to)) throw new ImportSkippedError(`"${to}" already exists — not moving the show's folder onto it`);
    await moveAlbumFolder(from, to);
    const episodes = (await db.prepare("SELECT id, file_path FROM episodes WHERE media_item_id = ? AND file_path IS NOT NULL").all(item.id)) as { id: number; file_path: string }[];
    for (const ep of episodes) {
      if (ep.file_path.startsWith(from + path.sep)) {
        await db.prepare("UPDATE episodes SET file_path = ? WHERE id = ?").run(to + ep.file_path.slice(from.length), ep.id);
        episodesUpdated++;
      }
    }
  }
  await db.prepare("UPDATE media_items SET library_folder = ? WHERE id = ?").run(targetSegments.join("/"), item.id);
  return { from, to, episodesUpdated };
}

/** Marks the staging name of a folder copied across file systems ("<destination>.partial-<random>"). */
const PARTIAL_COPY_MARKER = ".partial-";

/** Moves an album folder to a new place: a rename, or a copy and removal when the root folders are on different file systems. */
export async function moveAlbumFolder(src: string, dest: string): Promise<void> {
  makeLibraryDirectory(path.dirname(dest));
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // The copy goes to a staging name and is renamed into place when it is complete, so a crash or a kill during a
    // long copy leaves a staging folder (removed at the next try), never a partial folder under the real name.
    const parent = path.dirname(dest);
    const stagingPrefix = `${path.basename(dest)}${PARTIAL_COPY_MARKER}`;
    for (const name of await fsp.readdir(parent).catch(() => [] as string[])) {
      if (name.startsWith(stagingPrefix) && /^[0-9a-f]{8}$/.test(name.slice(stagingPrefix.length))) await fsp.rm(path.join(parent, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const staging = path.join(parent, `${stagingPrefix}${crypto.randomBytes(4).toString("hex")}`);
    try {
      await fsp.cp(src, staging, { recursive: true });
      await fsp.rename(staging, dest);
    } catch (copyErr) {
      // Only the staging folder: a finished destination is never touched.
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw copyErr;
    }
    // The copy is complete: callers point the database at it. A source that cannot be removed is left for the admin,
    // not undone, since a half-removed source with the copy deleted would lose files.
    await fsp.rm(src, { recursive: true, force: true }).catch((rmErr) =>
      log.warn(`[importer] copied "${src}" to "${dest}" but could not remove the original:`, (rmErr as Error).message)
    );
  }
}

/** A rename's move: the media file, then the subtitles/.nfo named for it (downloaded or written by
 * AoNarr itself — left behind, players lost them and their old folder was never cleaned up), then
 * any folder that emptied. Sidecars are best-effort; one whose new name is taken stays put. */
async function relocateLibraryFile(src: string, dest: string, rootFolderPath: string): Promise<void> {
  const sidecars = findSidecars(src);
  await moveFile(src, dest, true);
  const newBase = dest.slice(0, dest.length - path.extname(dest).length);
  for (const { file, suffix } of sidecars) {
    const target = newBase + suffix;
    if (path.resolve(target) === path.resolve(file)) continue;
    try {
      if (isOtherExistingEntry(file, target)) {
        log.warn(`[importer] left sidecar "${file}" in place: "${target}" already exists`);
        continue;
      }
      await moveFile(file, target, true);
    } catch (err) {
      log.warn(`[importer] failed to move sidecar "${file}":`, (err as Error).message);
    }
  }
  removeEmptyParents(path.dirname(src), rootFolderPath);
}

/** The lyrics file named for a track ("01 - Song.lrc"), which goes with it. */
function findTrackSidecars(trackPath: string): string[] {
  const dir = path.dirname(trackPath);
  const stem = path.basename(trackPath, path.extname(trackPath));
  try {
    return fs.readdirSync(dir).filter((name) => name.toLowerCase() === `${stem.toLowerCase()}.lrc`).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Renames the track files (and audiobook parts) of albums to the track template, as the import names them. A file stays
 * in the folder it is in: only its name changes, so a disc folder is kept and nothing leaves its album folder. Only an
 * album that is a folder is handled (a single-file book is one file the album row itself points at), and only a track
 * that sits inside that folder. `albumFolderAfter` holds the folders the folder pass has moved (or, in a preview, will
 * move) albums to.
 */
async function renameTrackFiles(
  item: { title: string; [key: string]: any },
  albums: { id: number; title: string; file_path: string }[],
  albumFolderAfter: Map<number, string>,
  claimed: Set<string>,
  result: RenameResult,
  dryRun: boolean
): Promise<void> {
  for (const album of albums) {
    const movedTo = albumFolderAfter.get(album.id);
    // A real run has already moved the folder (and the track rows with it); a preview works from the old place.
    const folderAfter = path.resolve(movedTo ?? album.file_path);
    if (!isDirectory(dryRun ? album.file_path : folderAfter)) continue;
    const rows = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ? AND has_file = 1 AND file_path IS NOT NULL ORDER BY track_number").all(album.id)) as any[];
    const oldFolder = path.resolve(album.file_path);
    for (const track of rows) {
      const recorded = path.resolve(String(track.file_path));
      const current = dryRun && movedTo && recorded.startsWith(oldFolder + path.sep) ? path.join(path.resolve(movedTo), path.relative(oldFolder, recorded)) : recorded;
      if (!current.startsWith(folderAfter + path.sep)) continue;
      const extension = path.extname(current);
      const dest = path.join(path.dirname(current), trackFileNameFor(item, album.title, track, extension));
      if (path.resolve(dest) === current) {
        claimed.add(current);
        continue;
      }
      const label = `${item.title} — ${album.title} — ${track.title}`;
      const conflict = renameConflict(dryRun ? recorded : current, dest, claimed);
      if (conflict) {
        result.errors.push({ title: label, error: conflict });
        continue;
      }
      try {
        if (!dryRun) {
          const sidecars = findTrackSidecars(current);
          await moveFile(current, dest, true);
          const newStem = dest.slice(0, dest.length - extension.length);
          for (const sidecar of sidecars) {
            const target = newStem + path.extname(sidecar);
            if (isOtherExistingEntry(sidecar, target)) continue;
            await moveFile(sidecar, target, true).catch((err) => log.warn(`[importer] failed to move lyrics file "${sidecar}":`, (err as Error).message));
          }
          await db.prepare("UPDATE tracks SET file_path = ? WHERE id = ?").run(dest, track.id);
        }
        result.renamed.push({ title: label, from: recorded, to: dest });
      } catch (err) {
        result.errors.push({ title: label, error: (err as Error).message });
      }
    }
  }
}

/** `dryRun` computes and reports the same from/to paths a real rename would, without touching the
 * filesystem or the database — Radarr-style rename preview, so an admin can see what a bulk
 * "Organize & Rename" would actually do before committing to it. */
async function renameOneItemRow(mediaRow: any, result: RenameResult, onlySeasonNumber?: number, dryRun = false): Promise<void> {
  const item = mediaItemFromRow(mediaRow);
  if (isTitleMoving(item.id)) {
    // Its files are on the way to another root folder: renaming them now would race the move.
    result.errors.push({ title: item.title, error: "The title is being moved to another root folder — rename it when the move has finished" });
    return;
  }
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);
  if (!item.rootFolderId) return;
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) return;
  const rootFolder = rootFolderFromRow(folderRow);
  // A library the admin marked read-only is never rewritten: no file in it is renamed (a rename would be a write to another tool's files).
  if (rootFolder.readOnly) return;
  const namingEnabled = getNamingEnabled(item.type);
  const template = namingTemplateFor(item);
  // Destinations already taken by an earlier file of this item — also what a dry run checks against.
  const claimed = new Set<string>();

  try {
    if (shape === "single") {
      if (!item.hasFile || !item.path) return;
      const ext = path.extname(item.path);
      const segments = renderPathSegments(
        template,
        {
          title: item.title,
          year: item.year ?? "",
          quality: item.quality ?? "",
          ...titleVars("", item.title, item.year),
          // A file the scan adopted has no recorded release: its own name stands in, so a group in it is kept.
          ...releaseVars(mediaRow.file_release_title ?? path.basename(item.path, ext), item.quality),
          ...providerIdVars(item),
        },
        ext
      );
      const { destPath } = resolveDest(rootFolder.path, segments, ext, item.path, namingEnabled);
      if (path.resolve(destPath) === path.resolve(item.path)) return;
      const conflict = renameConflict(item.path, destPath, claimed);
      if (conflict) {
        result.errors.push({ title: item.title, error: conflict });
        return;
      }
      if (!dryRun) {
        await relocateLibraryFile(item.path, destPath, rootFolder.path);
        await db.prepare("UPDATE media_items SET path = ? WHERE id = ?").run(destPath, item.id);
      }
      result.renamed.push({ title: item.title, from: item.path, to: destPath });
    } else if (shape === "episodic") {
      const episodes = (await (onlySeasonNumber != null
        ? db
            .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ? AND has_file = 1 AND file_path IS NOT NULL")
            .all(item.id, onlySeasonNumber)
        : db.prepare("SELECT * FROM episodes WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL").all(item.id))) as any[];
      // Group by file_path first — a multi-episode release (e.g. "S01E01-E02.mkv") writes the
      // same file_path to every episode row it covers, and moving each row independently would
      // try to move the same already-relocated physical file a second time.
      const fileGroups = new Map<string, any[]>();
      for (const epRow of episodes) {
        const key = path.resolve(epRow.file_path);
        if (!fileGroups.has(key)) fileGroups.set(key, []);
        fileGroups.get(key)!.push(epRow);
      }
      for (const group of fileGroups.values()) {
        group.sort((a, b) => a.episode_number - b.episode_number);
        const primary = group[0];
        const ext = path.extname(primary.file_path);
        const absoluteEpisode = Number(
          (
            (await db
              .prepare(
                `SELECT COUNT(*) AS c FROM episodes WHERE media_item_id = ? AND season_number > 0
               AND (season_number < ? OR (season_number = ? AND episode_number <= ?))`
              )
              .get(item.id, primary.season_number, primary.season_number, primary.episode_number)) as { c: number }
          ).c
        );
        const segments = (
          await withItemFolder(
            item,
            rootFolder.path,
            renderPathSegments(
              template,
              episodicNameVars(item, {
                season: primary.season_number,
                numbers: group.map((g) => Number(g.episode_number)),
                absoluteEpisode,
                airDate: primary.air_date ?? null,
                episodeTitle: primary.title ?? null,
                quality: primary.quality ?? null,
                // A file the scan adopted or imported before releases were recorded has none: its own name stands in.
                releaseTitle: primary.file_release_title ?? path.basename(primary.file_path, ext),
              }),
              ext
            ),
            template
          )
        ).segments;
        const { destPath } = resolveDest(rootFolder.path, segments, ext, primary.file_path, namingEnabled);
        if (path.resolve(destPath) === path.resolve(primary.file_path)) continue;
        const label =
          group.length > 1
            ? `${item.title} — ${primary.season_number}x${primary.episode_number}-${group[group.length - 1].episode_number}`
            : `${item.title} — ${primary.season_number}x${primary.episode_number}`;
        const conflict = renameConflict(primary.file_path, destPath, claimed);
        if (conflict) {
          result.errors.push({ title: label, error: conflict });
          continue;
        }
        if (!dryRun) {
          await relocateLibraryFile(primary.file_path, destPath, rootFolder.path);
          for (const epRow of group) {
            await db.prepare("UPDATE episodes SET file_path = ? WHERE id = ?").run(destPath, epRow.id);
          }
        }
        result.renamed.push({ title: label, from: primary.file_path, to: destPath });
      }
    } else if (shape === "collection" && typeConfig.multiFilePerChild) {
      // An album (or audiobook) is a folder: the folder is moved to the one the template names, with its files as they
      // are (a track keeps the name it was downloaded with, as at import). With naming switched off nothing is renamed.
      const albums = (await db
        .prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL ORDER BY id")
        .all(item.id)) as any[];
      if (!namingEnabled) result.skippedMusic += albums.length;
      // Where each album's folder is (or, in a preview, will be) after the folder pass below.
      const albumFolderAfter = new Map<number, string>();
      for (const album of albums) {
        if (!namingEnabled) break;
        const current = path.resolve(album.file_path);
        // Only a folder of the album's own is moved: not a file (a single-file audiobook), not a folder that is not
        // on disk, not the artist's or author's folder (a loose track or book beside the albums), and not a folder
        // another album lives in. All of those stay as they are.
        const stat = fs.existsSync(current) ? fs.statSync(current) : null;
        const sharesFolder =
          !!stat?.isDirectory() &&
          albums.some((other) => other.id !== album.id && other.file_path && (path.resolve(other.file_path) === current || path.resolve(other.file_path).startsWith(current + path.sep)));
        const isArtistFolder = path.dirname(current) === path.resolve(rootFolder.path);
        if (!stat?.isDirectory() || sharesFolder || isArtistFolder) {
          result.skippedMusic++;
          continue;
        }
        const segments = renderPathSegments(getNamingTemplate(item.type), {
          parentTitle: item.title,
          childTitle: album.title,
          quality: album.quality ?? "",
          ...titleVars("parent", item.title, item.year),
          ...providerIdVars(item),
        });
        const destPath = path.join(rootFolder.path, ...segments);
        assertInsideRoot(rootFolder.path, destPath);
        if (path.resolve(destPath) === current) {
          claimed.add(current);
          continue;
        }
        if (path.resolve(destPath).startsWith(current + path.sep)) {
          result.skippedMusic++;
          continue;
        }
        const label = `${item.title} — ${album.title}`;
        const key = path.resolve(destPath);
        if (claimed.has(key) || fs.existsSync(destPath) || (await isFolderOfAnotherChild(destPath, album.id))) {
          result.errors.push({ title: label, error: `"${destPath}" is already taken — not moving the album folder onto it` });
          continue;
        }
        claimed.add(key);
        albumFolderAfter.set(album.id, destPath);
        if (!dryRun) {
          await moveAlbumFolder(album.file_path, destPath);
          await db.prepare("UPDATE sub_items SET file_path = ? WHERE id = ?").run(destPath, album.id);
          const prefix = album.file_path.replace(/[\\/]+$/, "");
          const tracks = (await db.prepare("SELECT id, file_path FROM tracks WHERE sub_item_id = ? AND file_path IS NOT NULL").all(album.id)) as { id: number; file_path: string }[];
          for (const track of tracks) {
            if (track.file_path === prefix || track.file_path.startsWith(prefix + path.sep) || track.file_path.startsWith(`${prefix}/`)) {
              await db.prepare("UPDATE tracks SET file_path = ? WHERE id = ?").run(destPath + track.file_path.slice(prefix.length), track.id);
            }
          }
          removeEmptyParents(path.dirname(album.file_path), rootFolder.path);
        }
        result.renamed.push({ title: label, from: album.file_path, to: destPath });
      }
      if (namingEnabled) await renameTrackFiles(item, albums, albumFolderAfter, claimed, result, dryRun);
    } else if (shape === "collection") {
      const subItems = (await db
        .prepare("SELECT * FROM sub_items WHERE media_item_id = ? AND has_file = 1 AND file_path IS NOT NULL ORDER BY id")
        .all(item.id)) as any[];
      for (const subRow of subItems) {
        const ext = path.extname(subRow.file_path);
        const current = path.resolve(subRow.file_path);
        const candidates = collectionChildDestinations(
          rootFolder.path,
          template,
          item.title,
          subRow,
          subRow.quality ?? null,
          ext,
          subRow.file_path,
          namingEnabled,
          { ...titleVars("parent", item.title, item.year), ...providerIdVars(item) }
        );
        // The same choice placeFile makes: a name a same-titled sibling holds (or takes earlier in
        // this pass) passes to the next one, and a child already at one of its own names stays there.
        let destPath: string | null = null;
        for (const candidate of candidates) {
          const key = path.resolve(candidate.destPath);
          if (key === current || (!claimed.has(key) && !(await isFileOfAnotherRow(candidate.destPath, item.id, [], subRow.id)))) {
            destPath = candidate.destPath;
            break;
          }
        }
        if (destPath === null) {
          result.errors.push({ title: `${item.title} — ${subRow.title}`, error: anotherEntrysFileMessage(candidates[0].destPath) });
          continue;
        }
        if (path.resolve(destPath) === current) {
          claimed.add(current);
          continue;
        }
        const conflict = renameConflict(subRow.file_path, destPath, claimed);
        if (conflict) {
          result.errors.push({ title: `${item.title} — ${subRow.title}`, error: conflict });
          continue;
        }
        if (!dryRun) {
          await relocateLibraryFile(subRow.file_path, destPath, rootFolder.path);
          await db.prepare("UPDATE sub_items SET file_path = ? WHERE id = ?").run(destPath, subRow.id);
        }
        result.renamed.push({ title: `${item.title} — ${subRow.title}`, from: subRow.file_path, to: destPath });
      }
    }
  } catch (err) {
    result.errors.push({ title: item.title, error: (err as Error).message });
    log.warn(`[importer] rename failed for "${item.title}":`, (err as Error).message);
  }
}

/** Whether the indexer carries a seed goal of its own (see markDownloadImported). */
async function indexerHasSeedGoal(indexerId: number): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS ok FROM indexers WHERE id = ? AND (seed_ratio IS NOT NULL OR seed_time_minutes IS NOT NULL)").get(indexerId));
}
