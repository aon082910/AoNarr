import { log } from "./logger.js";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { config } from "../config.js";
import { decryptIfSet, mediaItemFromRow, queueItemFromRow, rootFolderFromRow } from "../db/mappers.js";
import { notifyImported, notifyManualInteractionRequired, notifyUpgraded } from "./notifications.js";
import { writeNfoSidecar } from "./metadataExport.js";
import { writeAudioTags } from "./audioTagWriter.js";
import { notifyQueueChanged } from "./realtime.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode } from "./releaseParser.js";
import {
  downloadSubtitleContent,
  downloadSubtitleFromUrl,
  pickBestSubtitle,
  pickBestSubtitleForLanguage,
  searchCustomSubtitles,
  searchSubtitles,
  type CustomSubtitleProviderConfig,
} from "./subtitleClient.js";
import { unpackDownloadedArchives } from "./archiveExtract.js";
import { removeQueueItemDownload } from "./downloadClient.js";
import { syncSubtitleToVideo } from "./subtitleSync.js";
import { DEFAULT_SHAPE_TEMPLATES, DEFAULT_TRACK_TEMPLATE, providerIdVars, renderTemplate } from "./naming.js";
import { effectiveShape, getMediaTypeConfig, isProbeableFile, type MediaShape } from "./mediaTypes.js";
import { qualityRank, usesQualityTiers } from "./quality.js";
import { getSetting } from "./settingsStore.js";
import { probeMediaInfo } from "./ffprobe.js";
import { recordGroupSuccess } from "./releaseGroupStats.js";
import { detectSeasonEpisode, guessTitleFromText } from "./libraryScan.js";
import { convertComicImagesBestEffort } from "./comicImageConvert.js";
import { recycleFile } from "./recycleBin.js";
import { finishBackgroundJob, incrementBackgroundJobDone, isBackgroundJobRunning, startBackgroundJob } from "./backgroundJobs.js";
import type { MediaType } from "../types/index.js";

// Shared across every "single"/"episodic" video library (Movies, TV Shows, Anime) so a just-moved
// file can be recognized as subtitle-eligible without hardcoding a type list.
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"]);

/** Absolute (AniDB/TVDB-absolute-order-style) episode number for a season/episode pair, counting
 * from season 1 episode 1 (season 0 specials excluded — absolute numbering conventions don't
 * count them). Computed live from the episodes table rather than trusting a stored column, since
 * `episodes.absolute_episode_number` is only ever populated by one of the many code paths that can
 * insert an episode row (see /metadata/import) — every other insert path (Trakt/Plex/watchlist
 * sync, import lists, library scan, a manual add, ...) leaves it NULL. */
export async function computeAbsoluteEpisodeNumber(mediaItemId: number, seasonNumber: number, episodeNumber: number): Promise<number> {
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
  return name
    .replace(/:\s*/g, " - ")
    .replace(/[/\\*?"<>|]/g, "")
    .trim();
}

/** One path segment that can never add, remove or climb a directory level: one that sanitizes to
 * nothing, "." or ".." becomes "_" instead (an album titled "?" otherwise vanished, dropping its
 * tracks loose into the artist folder). */
function safePathSegment(name: string): string {
  const cleaned = sanitizeForPath(name);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
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
function renderPathSegments(template: string, vars: Record<string, string | number>): string[] {
  const safeVars = pathSafeVars(vars);
  return template
    .split("/")
    .filter((part) => part.trim() !== "")
    .map((part) => safePathSegment(renderTemplate(part, safeVars)));
}

/** Last line of defence behind the segment sanitizing above: nothing is ever placed outside its root folder. */
function assertInsideRoot(rootFolderPath: string, target: string): void {
  const relative = path.relative(path.resolve(rootFolderPath), path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new ImportSkippedError(`Refusing to place "${target}" outside its root folder "${rootFolderPath}"`);
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
    : `${safePathSegment(path.basename(sourceFile, path.extname(sourceFile)))}${ext}`;
  const destPath = path.join(rootFolderPath, ...folderSegments, fileLabel);
  assertInsideRoot(rootFolderPath, destPath);
  return { destPath, fileLabel };
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
  const cleaned = text.replace(/\d+[.,]\d+/g, " ").replace(/[hx][.\s]?26[45]/gi, " ");
  for (const m of cleaned.matchAll(/(?<![a-z0-9])\d{1,3}(?![a-z0-9])/gi)) numbers.add(String(Number(m[0])));
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

/** Recursively walks the downloads directory (bounded depth) collecting files with a matching extension. */
function walk(dir: string, extensions: string[], maxDepth: number, depth = 0): string[] {
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
      found.push(...walk(full, extensions, maxDepth, depth + 1));
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
    for (const t of wantedTokens) if (fileTokens.has(t)) overlap++;
    let score = wantedTokens.size > 0 ? overlap / wantedTokens.size : 0;
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
  const extensions = getMediaTypeConfig(mediaType).extensions;
  const ctx: DownloadContext = { releaseTitle, downloadPath: searchRoot, category: options.category };

  if (searchRoot) {
    try {
      const stat = fs.statSync(searchRoot);
      if (stat.isFile()) {
        if (extensions.includes(path.extname(searchRoot).toLowerCase())) return searchRoot;
      } else if (stat.isDirectory()) {
        const scoped = findDownloadedFileIn(searchRoot, path.dirname(searchRoot), releaseTitle, extensions, target, ctx, options.childTitle);
        // The downloads-wide search could only turn up some other download of the same episode
        // number (another show's, or an older grab of this one still seeding) — not this one. Nor,
        // when the release's own folder holds only its sample, anything but another grab of the
        // same title, whose files would be moved out from under its seeding.
        if (scoped.file || target || (scoped.droppedSamples && isOwnReleaseFolder(searchRoot, ctx))) return scoped.file;
      }
    } catch {
      // Mapped path doesn't exist (stale mapping, or the client hasn't actually written there) —
      // fall through to the full downloadsDir search below exactly as if no path had been given.
    }
  }

  return findDownloadedFileIn(config.downloadsDir, config.downloadsDir, releaseTitle, extensions, target, ctx, options.childTitle).file;
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

function pickDownloadedFile(
  candidates: string[],
  baseDir: string,
  labelBase: string,
  releaseTitle: string,
  target: EpisodeTarget | undefined,
  ctx: DownloadContext,
  childTitle: string | null | undefined
): string | null {

  if (target && !isOwnReleaseFolder(baseDir, ctx)) {
    // An SxxEyy or air date alone doesn't identify a show, and a folder shared with other downloads
    // routinely holds other shows' files carrying the same numbers, so the series' own title must be
    // in the path too. A release's own folder holds only its own files and needs no such check.
    const seriesTokens = releaseTitleTokens(releaseTitle);
    if (seriesTokens.length > 0) {
      candidates = candidates.filter((filePath) => {
        const pathTokens = new Set(normalizeTokens(path.relative(labelBase, filePath)));
        return seriesTokens.every((t) => pathTokens.has(t));
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
  scored.sort((a, b) => b.score - a.score || b.size - a.size);
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
    ranked.sort((a, b) => b.child - a.child || b.c.score - a.c.score || b.c.size - a.c.size);
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
  const candidates = walk(config.downloadsDir, extensions, 4);
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
async function moveFile(src: string, dest: string, forceMove = false): Promise<void> {
  const destDir = path.dirname(dest);
  makeLibraryDirectory(destDir);
  const strategy = forceMove ? "move" : getSetting("importStrategy") ?? "move";

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

  try {
    fs.renameSync(src, dest);
  } catch (err: any) {
    if (err.code !== "EXDEV") throw err;
    await copyIntoPlace(src, dest);
    fs.unlinkSync(src);
  }
  applyConfiguredPermissions(dest, false);
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
    names = await fsp.readdir(dir);
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
async function copyIntoPlace(src: string, dest: string): Promise<void> {
  await removeStaleImportTemps(path.dirname(dest), dest);
  const tmp = tempPathNextTo(dest);
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
  const strategy = getSetting("importStrategy") ?? "move";
  const staged = tempPathNextTo(dest);
  activeTemps.add(path.resolve(staged));
  try {
    if (strategy === "symlink") {
      await moveFile(src, staged);
    } else {
      try {
        fs.linkSync(src, staged);
      } catch {
        await copyIntoPlace(src, staged);
      }
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
  log.info(`[importer] recycled "${dest}" to replace it with a hand-picked file for "${item.title}"`);
  if (strategyDeletesSourceData()) {
    try {
      fs.unlinkSync(src);
    } catch (err) {
      log.warn(`[importer] placed "${dest}" but couldn't remove its source "${src}":`, (err as Error).message);
    }
  }
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
function makeLibraryDirectory(dir: string): void {
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
      await recycleFile(oldPath, item.type, item.title, item.id);
      log.info(`[importer] recycled replaced file "${oldPath}" for "${item.title}"`);
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
      renderPathSegments(template, { parentTitle, childTitle: `${child.title}${suffix}`, quality: quality ?? "", ...providerVars }),
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
    const fileLabel = `${safePathSegment(path.basename(plain.fileLabel, ext) + suffix)}${ext}`;
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
function isQualityUpgrade(type: MediaType, quality: string | null, existingQuality: string | null): boolean {
  return usesQualityTiers(type) && qualityRank(quality) > qualityRank(existingQuality);
}

export class ImportSkippedError extends Error {}

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
  | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null }
  | { airDate: string };

function parsedMatchesTarget(parsed: ReturnType<typeof parseReleaseTitle>, target: EpisodeTarget): boolean {
  return "airDate" in target
    ? releaseMatchesAirDate(parsed, target.airDate)
    : releaseMatchesEpisode(parsed, target.season, target.episode, target.sceneSeason, target.sceneEpisode, target.absoluteEpisode);
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
}): Promise<{ destPath: string; fileLabel: string }> {
  const { itemId, episodeId, subItemId, sourceFile, quality, batchClaims } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);

  if (shape === "collection" && typeConfig.multiFilePerChild && subItemId) {
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

  if (shape === "single") {
    if (item.hasFile) replacedPaths = [item.path];
    const segments = renderPathSegments(template, { title: item.title, year: item.year ?? "", quality: quality ?? "", ...providerIdVars(item) });
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
    const primaryEpisodeNumber = Math.min(...allEpRows.map((e: any) => e.episode_number));
    const lastEpisodeNumber = Math.max(...allEpRows.map((e: any) => e.episode_number));
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
    const segments = renderPathSegments(template, {
      parentTitle: item.title,
      season: epRow.season_number,
      episode:
        allEpRows.length > 1
          ? `${String(primaryEpisodeNumber).padStart(2, "0")}-${String(lastEpisodeNumber).padStart(2, "0")}`
          : primaryEpisodeNumber,
      absoluteEpisode,
      airDate: primaryEpRow.air_date ?? "",
      episodeTitle: primaryEpRow.title ?? "",
      year: item.year ?? "",
      quality: quality ?? "",
      ...providerIdVars(item),
    });
    ({ destPath, fileLabel } = resolveDest(rootFolder.path, segments, ext, sourceFile, getNamingEnabled(item.type)));
  } else if (shape === "collection" && subItemId) {
    const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
    if (!subRow) throw new Error(`Sub-item ${subItemId} not found`);
    hadFileBefore = !!subRow.has_file;
    if (subRow.has_file) replacedPaths = [subRow.file_path];
    const candidates = collectionChildDestinations(
      rootFolder.path,
      template,
      item.title,
      subRow,
      quality,
      ext,
      sourceFile,
      getNamingEnabled(item.type),
      providerIdVars(item)
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
  const claimKeys =
    shape === "single" ? [`item:${item.id}`] : episodeId ? ownEpisodeIds.map((id) => `episode:${id}`) : [`sub:${subItemId}`];
  if (batchClaims && claimKeys.some((key) => batchClaims.has(key))) {
    throw new ImportSkippedError(`Another file in this import was already placed for "${fileLabel}" — not replacing it with "${path.basename(sourceFile)}"`);
  }

  // Radarr's "Skip Free Space Check" — on by default (i.e. the check runs), refuses an import that
  // would leave the destination filesystem with less free space than the file being placed, rather
  // than silently filling a small library drive to zero. `move` frees the source file's own space
  // back as part of the same operation on same-filesystem moves, but that can't be assumed here
  // (cross-filesystem move falls back to copy+delete, and hardlink/symlink never free anything) so
  // this stays conservative and checks against the file's full size either way.
  if (getSetting("skipFreeSpaceCheck") !== "1") {
    try {
      const sourceSize = fs.statSync(sourceFile).size;
      const stat = fs.statfsSync(rootFolder.path);
      // bavail, not bfree: the server runs unprivileged and can't write into root-reserved blocks.
      const freeBytes = stat.bavail * stat.bsize;
      if (freeBytes < sourceSize) {
        throw new ImportSkippedError(
          `Not enough free space at "${rootFolder.path}" (${Math.round(freeBytes / 1e9)}GB free, file is ${Math.round(sourceSize / 1e9)}GB) — kept for a manual import from Activity`
        );
      }
    } catch (err) {
      if (err instanceof ImportSkippedError) throw err;
      // Can't stat the source/destination filesystem — don't block the import over that; the
      // move itself will surface a clearer filesystem error if something's actually wrong.
    }
  }

  await moveFile(sourceFile, destPath);
  for (const key of claimKeys) batchClaims?.add(key);

  if (VIDEO_EXTENSIONS.has(ext.toLowerCase()) && (shape === "single" || shape === "episodic")) {
    await tryDownloadSubtitle(destPath, item.id);
  }

  if ((item.type === "comic" || item.type === "manga") && ext.toLowerCase() === ".cbz" && getSetting("comicImageConvertEnabled") === "1") {
    const format = getSetting("comicImageFormat") === "jpeg" ? "jpeg" : "webp";
    const quality = Number(getSetting("comicImageQuality") ?? "82") || 82;
    await convertComicImagesBestEffort(destPath, format, quality);
  }

  const mediaInfo = isProbeableFile(destPath) ? await probeMediaInfo(destPath) : null;
  const mediaInfoJson = mediaInfo ? JSON.stringify(mediaInfo) : null;
  const sizeBytes = await fsp.stat(destPath).then((s) => s.size).catch(() => null);

  if (shape === "single") {
    await db.prepare("UPDATE media_items SET has_file = 1, path = ?, quality = ?, media_info = ?, size_bytes = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      sizeBytes,
      item.id
    );
  } else if (episodeId) {
    const rows = episodicRows ?? [{ id: episodeId }];
    for (const row of rows) {
      await db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ?, size_bytes = ? WHERE id = ?").run(
        destPath,
        quality,
        mediaInfoJson,
        sizeBytes,
        row.id
      );
    }
  } else if (subItemId) {
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = ?, media_info = ?, size_bytes = ? WHERE id = ?").run(
      destPath,
      quality,
      mediaInfoJson,
      sizeBytes,
      subItemId
    );
  }
  if (shape !== "single") await markParentHasFile(item.id);
  await recycleReplacedFiles(replacedPaths, [destPath, sourceFile], item);

  // episodeId/subItemId/quality are what duplicates.ts's repeated-import check groups on. One
  // history row per covered episode when a single file spans more than one (multi-episode release).
  const historyEpisodeIds = episodicRows ? episodicRows.map((r) => r.id) : [episodeId ?? null];
  for (const historyEpisodeId of historyEpisodeIds) {
    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
      item.id,
      JSON.stringify({ fileLabel, destPath, episodeId: historyEpisodeId, subItemId: subItemId ?? null, quality: quality ?? null })
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
    writeNfoSidecar(destPath, { type: item.type, title: item.title, year: item.year, overview: item.overview, posterUrl: item.posterUrl, externalIds });
  }

  if (hadFileBefore) await notifyUpgraded(item.title, fileLabel, destPath);
  else await notifyImported(item.title, fileLabel, destPath);
  log.info(`[importer] imported "${fileLabel}" for "${item.title}"`);
  return { destPath, fileLabel };
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
}): Promise<{ destFolder: string; fileCount: number; leftInPlace: number; anchorDest: string | null; sourceFolder: string | null }> {
  const { itemId, subItemId, anchorFile, quality, releaseTitle, downloadPath, category, onlyAnchor = false, batchClaims } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

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
  const sharedSourceDir =
    onlyAnchor && isDiscFolderFile(anchorFile)
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
  const namingEnabled = getNamingEnabled(item.type);
  const trackTemplate = getSetting("namingArtistTrackTemplate") || DEFAULT_TRACK_TEMPLATE;
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
      track && namingEnabled
        ? safePathSegment(
            renderTemplate(
              trackTemplate,
              pathSafeVars({
                trackNumber: track.track_number,
                trackTitle: track.title,
                parentTitle: item.title,
                childTitle: subRow.title,
                ...providerIdVars(item),
              })
            )
          ) + path.extname(src)
        : sanitizeForPath(path.basename(src));
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

  assertEnoughFreeSpaceForImport(toPlace.map((p) => p.src), rootFolder.path);

  // Checked before anything moves, so a refusal never leaves the album half imported.
  for (const { dest } of toPlace) {
    if (await isFileOfAnotherRow(dest, item.id, [], subItemId)) {
      throw new ImportSkippedError(`"${dest}" is already another library entry's file — not importing "${subRow.title}" over it`);
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

  let movedCount = 0;
  let totalMovedBytes = 0;
  let anchorDest: string | null = null;
  const replacedPaths: (string | null)[] = [];
  const placedPaths: string[] = [];
  for (const p of toPlace) {
    const { src, track, dest } = p;
    if (replaceExisting.has(destKey(dest))) await placeOverRecycledFile(src, dest, item);
    else await moveFile(src, dest);
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

  await db.prepare("UPDATE sub_items SET has_file = ?, file_path = ?, quality = ?, media_info = ?, size_bytes = ? WHERE id = ?").run(
    movedCount > 0 ? 1 : 0,
    destFolder,
    quality,
    mediaInfo ? JSON.stringify(mediaInfo) : null,
    sizeBytes,
    subItemId
  );
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
      JSON.stringify({ destFolder, fileCount: movedCount, subItemId, quality: quality ?? null })
    );
    await notifyImported(item.title, `${movedCount} file(s) into ${path.basename(destFolder)}`, destFolder);
  }
  log.info(`[importer] imported ${movedCount} file(s) into "${path.basename(destFolder)}" for "${item.title}"`);
  if (leftInPlace > 0) {
    const reason = `${leftInPlace} other audio file(s) were left in ${sourceDir} after importing "${subRow.title}"; import any that belong to it manually`;
    log.warn(`[importer] ${reason}`);
    await notifyManualInteractionRequired(item.title, reason);
  }
  return { destFolder, fileCount: movedCount, leftInPlace, anchorDest, sourceFolder: sharedSourceDir ? null : albumSourceDir };
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
 * E-marker under a "Season NN" folder) comes first; then an air date (a daily show's
 * "Show.2024.01.15"); then an anime batch's "Show - 13" — absolute numbering when every such file of
 * the pack falls in this season's absolute range, the season's own numbering when every one fits
 * that instead; then, directly inside a folder named for this season ("Show.S01.1080p"), a name
 * that is only an episode number. Matching on SxxEyy alone left every file of such packs unmatched,
 * so the pack never imported and its season stayed blocked. An episode two files map to goes to the
 * one matched the earlier way (then the first); the other stays in the download and counts as unmatched.
 */
async function planSeasonPackFiles(
  files: string[],
  episodes: any[],
  itemId: number,
  seasonNumber: number,
  itemTitle: string
): Promise<{ plans: { src: string; episodes: any[] }[]; unmatchedCount: number }> {
  const byNumber = new Map<number, any>(episodes.map((e) => [Number(e.episode_number), e]));
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
  }

  type ParsedFile = { src: string; rank: number; numbers?: number[]; airDate?: string; absolute?: number; bare?: number };
  const parsedFiles: ParsedFile[] = files.map((src) => {
    const base = withoutVersionTag(path.basename(src, path.extname(src)));
    const folder = path.basename(path.dirname(src));
    const detected = detectSeasonEpisode(folder, base);
    // Another season's file (a bonus episode, the next season's opener) is neither placed nor counted.
    if (detected.episodes.length > 0) return { src, rank: 1, numbers: detected.season === null || detected.season === seasonNumber ? detected.episodes : [] };
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
      targets = p.numbers.map((n) => byNumber.get(n)).filter((e) => !!e);
      isEpisodeFile = p.numbers.length > 0;
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
      // Only a missing episode of this season keeps the download's data; counting extras, NCOP/NCED,
      // menus and other seasons' files too kept nearly every pack's data, with no queue row left to clean it.
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
}): Promise<{
  destFolder: string;
  episodeCount: number;
  unmatchedCount: number;
  leftInPlace: number;
  notUpgradedCount: number;
  packDir: string | null;
}> {
  const { itemId, seasonNumber, anchorFile, quality, releaseTitle, downloadPath, category } = params;

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId);
  if (!mediaRow) throw new Error(`Media item ${itemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);

  if (!item.rootFolderId) throw new ImportSkippedError(`"${item.title}" has no root folder configured`);
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) throw new ImportSkippedError(`Root folder for "${item.title}" no longer exists`);
  const rootFolder = rootFolderFromRow(folderRow);

  const { files: siblings, leftInPlace, packDir } = collectSeasonPackFiles(anchorFile, seasonNumber, typeConfig.extensions, {
    releaseTitle,
    downloadPath,
    category,
  });

  const episodes = (await db
    .prepare("SELECT * FROM episodes WHERE media_item_id = ? AND season_number = ?")
    .all(itemId, seasonNumber)) as any[];
  const planned = await planSeasonPackFiles(siblings, episodes, itemId, seasonNumber, item.title);
  let unmatchedCount = planned.unmatchedCount;

  let notUpgradedCount = 0;
  const toPlace = planned.plans.filter(({ src, episodes: targets }) => {
    const better = targets.find((e) => Number(e.has_file) && !isQualityUpgrade(item.type, quality, e.quality));
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

  assertEnoughFreeSpaceForImport(toPlace.map((p) => p.src), rootFolder.path);

  let importedCount = 0;
  let upgradedCount = 0;
  let destFolder = "";
  const replacedPaths: (string | null)[] = [];
  const placedPaths: string[] = [];
  const usedDestinations = new Set<string>();
  for (const { src, episodes: targetEpisodes } of toPlace) {
    // A Sonarr-style multi-episode file within the pack (e.g. "S01E01-E02.mkv") resolves to every
    // one of this season's own episode rows it actually covers, not just the first.
    const covered = [...targetEpisodes].sort((a, b) => Number(a.episode_number) - Number(b.episode_number));
    const primary = covered[0];
    const primaryEpisodeNumber = Number(primary.episode_number);
    const lastEpisodeNumber = Number(covered[covered.length - 1].episode_number);

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
    const segments = renderPathSegments(getNamingTemplate(item.type), {
      parentTitle: item.title,
      season: seasonNumber,
      // A plain number for the (overwhelmingly common) single-episode case, unchanged — a
      // pre-formatted "01-02" string for a real multi-episode file, which renderTemplate's
      // {episode:00} token already renders as-is (its zero-pad branch only fires for numbers),
      // so no naming-template changes are needed to support this.
      episode: covered.length > 1 ? `${String(primaryEpisodeNumber).padStart(2, "0")}-${String(lastEpisodeNumber).padStart(2, "0")}` : primaryEpisodeNumber,
      absoluteEpisode,
      airDate: primary.air_date ?? "",
      episodeTitle: primary.title ?? "",
      year: item.year ?? "",
      quality: quality ?? "",
      ...providerIdVars(item),
    });
    const ext = path.extname(src);
    const { destPath: dest, fileLabel } = resolveDest(rootFolder.path, segments, ext, src, getNamingEnabled(item.type));
    const destKey = path.resolve(dest).toLowerCase();
    if (usedDestinations.has(destKey)) {
      log.warn(`[importer] "${path.basename(src)}" would land on "${dest}", which another file of this pack just took — left in place`);
      unmatchedCount++;
      continue;
    }
    usedDestinations.add(destKey);
    destFolder = path.dirname(dest);
    await moveFile(src, dest);
    placedPaths.push(src, dest);

    if (VIDEO_EXTENSIONS.has(ext.toLowerCase())) await tryDownloadSubtitle(dest, item.id);
    const mediaInfo = await probeMediaInfo(dest);
    const sizeBytes = await fsp.stat(dest).then((s) => s.size).catch(() => null);
    for (const targetEpisode of covered) {
      const upgraded = !!Number(targetEpisode.has_file);
      if (upgraded) {
        replacedPaths.push(targetEpisode.file_path);
        upgradedCount++;
      }
      await db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = ?, media_info = ?, size_bytes = ? WHERE id = ?").run(
        dest,
        quality,
        mediaInfo ? JSON.stringify(mediaInfo) : null,
        sizeBytes,
        targetEpisode.id
      );
      // One row per episode, with episodeId/quality set — the same shape placeFile's single-episode
      // path uses, and what duplicates.ts's repeated-import grouping keys on. A single season-level
      // summary row here (as this used to write) collapsed every season-pack import of this series
      // to the same "media item, no episode/sub-item" key, so importing two different seasons looked
      // like one item repeatedly re-imported. A multi-episode file gets one history row per episode
      // it actually covers, same reasoning.
      await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'imported', ?)`).run(
        item.id,
        JSON.stringify({
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
  }

  await markParentHasFile(item.id);
  await recycleReplacedFiles(replacedPaths, placedPaths, item);
  const newCount = importedCount - upgradedCount;
  if (newCount > 0) await notifyImported(item.title, `season ${seasonNumber} pack — ${newCount} episode(s)`, destFolder);
  if (upgradedCount > 0) await notifyUpgraded(item.title, `season ${seasonNumber} pack — ${upgradedCount} episode(s) upgraded`, destFolder);
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
  const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(queueItemId);
  if (!queueRow) throw new Error(`Queue item ${queueItemId} not found`);
  const queueItem = queueItemFromRow(queueRow);

  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(queueItem.mediaItemId);
  if (!mediaRow) throw new Error(`Media item ${queueItem.mediaItemId} not found`);
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);

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
        };
  }

  const clientRow = queueItem.downloadClientId
    ? ((await db.prepare("SELECT category FROM download_clients WHERE id = ?").get(queueItem.downloadClientId)) as { category: string | null } | undefined)
    : undefined;
  const ctx: DownloadContext = { releaseTitle: queueItem.title, downloadPath: queueItem.downloadPath, category: clientRow?.category ?? null };

  let sourceFile: string | null;
  let unpackFailures: { archive: string; reason: string }[] = [];
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
    sourceFile = findDownloadedFile(queueItem.title, item.type, episodeTarget, queueItem.downloadPath, {
      childTitle: childRow?.title ?? null,
      category: ctx.category,
    });
    if (sourceFile && unpackFailures.length > 0 && !isUnpackedMediaCandidate(sourceFile, queueItem.downloadPath, queueItem.title)) sourceFile = null;
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
    throw new Error(`No matching file found in downloads directory for "${queueItem.title}"`);
  }

  // Interactive-Import-style override: the admin's own explicit choice on the Activity page's
  // "Manual import..." picker, for when the automatic quality detection (parsed from the release
  // title at grab time) guessed wrong — only ever applies to a manual import, an automatic one
  // always uses the parsed value as before.
  const quality = overrideQuality ?? queueItem.quality;

  // Files left in place that may belong to this download — their data must outlive the download's removal.
  let leftFilesBehind = false;
  // The download's own folder, removed once only junk is left in it; null when it has none.
  let releaseDir: string | null = null;
  // Set when what was placed may be only part of the download (one episode of a pack, one book of
  // a trilogy, one album of a discography).
  let mayHoldMore = false;
  if (shape === "collection" && typeConfig.multiFilePerChild && queueItem.subItemId) {
    const album = await placeAlbumFiles({
      itemId: item.id,
      subItemId: queueItem.subItemId,
      anchorFile: sourceFile,
      quality,
      releaseTitle: queueItem.title,
      downloadPath: queueItem.downloadPath,
      category: ctx.category,
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
      });
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
      const epRow = (await db.prepare("SELECT episode_number, has_file, quality FROM episodes WHERE id = ?").get(queueItem.episodeId)) as
        | { episode_number: number; has_file: number; quality: string | null }
        | undefined;
      if (epRow && Number(epRow.has_file) && !isQualityUpgrade(item.type, quality, epRow.quality)) {
        throw new ImportSkippedError(
          `Not an upgrade: episode ${epRow.episode_number} already has a "${epRow.quality ?? "unknown"}" file, and this download is "${quality ?? "unknown"}"`
        );
      }
      await placeFile({ itemId: item.id, episodeId: queueItem.episodeId, subItemId: null, sourceFile, quality });
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
    });
    releaseDir = ownReleaseFolderOf(sourceFile, ctx);
    mayHoldMore = shape !== "single";
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
  }
  if (!leftFilesBehind) cleanupDownloadSourceFolder(releaseDir, ctx);
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
    if (src !== reported && !src.startsWith(reported + path.sep)) return false;
    if (src !== reported) base = reported;
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
  const strategy = getSetting("importStrategy") ?? "move";
  return strategy !== "hardlink" && strategy !== "symlink";
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
function assertEnoughFreeSpaceForImport(sourceFiles: string[], rootFolderPath: string): void {
  if (getSetting("skipFreeSpaceCheck") === "1") return;
  try {
    const totalSize = sourceFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    const stat = fs.statfsSync(rootFolderPath);
    const freeBytes = stat.bavail * stat.bsize; // see placeFile: root-reserved blocks aren't ours
    if (freeBytes < totalSize) {
      throw new ImportSkippedError(
        `Not enough free space at "${rootFolderPath}" (${Math.round(freeBytes / 1e9)}GB free, ${Math.round(totalSize / 1e9)}GB needed) — kept for a manual import from Activity`
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
 * destination differs from where it already is. Music and Audiobooks (multiFilePerChild shapes)
 * are deliberately skipped — their individual track/chapter filenames are always kept as-
 * downloaded rather than templated (see placeAlbumFiles), so a template change there would only
 * affect the album/book folder name, a different and riskier operation (renaming a folder full of
 * files with no per-file destination to verify against) than this function's per-file model
 * handles; the count is still reported (as `skippedMusic`, shared by both types) so a caller isn't
 * left thinking they were silently included.
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
      await renameOneItemRow(mediaRow, result, undefined, dryRun);
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
export async function renameOneMediaItem(mediaItemId: number, onlySeasonNumber?: number, dryRun = false): Promise<RenameResult> {
  const result: RenameResult = { renamed: [], errors: [], skippedMusic: 0 };
  const mediaRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId);
  if (mediaRow) await renameOneItemRow(mediaRow, result, onlySeasonNumber, dryRun);
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
function isOtherExistingEntry(src: string, dest: string): boolean {
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
const SIDECAR_TAG_RE = /^(?:[a-z]{2,3}(?:-[a-z0-9]{2,4})?|forced|sdh|cc|hi)$/i;

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

/** `dryRun` computes and reports the same from/to paths a real rename would, without touching the
 * filesystem or the database — Radarr-style rename preview, so an admin can see what a bulk
 * "Organize & Rename" would actually do before committing to it. */
async function renameOneItemRow(mediaRow: any, result: RenameResult, onlySeasonNumber?: number, dryRun = false): Promise<void> {
  const item = mediaItemFromRow(mediaRow);
  const typeConfig = getMediaTypeConfig(item.type);
  const shape = effectiveShape(item);
  if (!item.rootFolderId) return;
  const folderRow = await db.prepare("SELECT * FROM root_folders WHERE id = ?").get(item.rootFolderId);
  if (!folderRow) return;
  const rootFolder = rootFolderFromRow(folderRow);
  const namingEnabled = getNamingEnabled(item.type);
  const template = namingTemplateFor(item);
  // Destinations already taken by an earlier file of this item — also what a dry run checks against.
  const claimed = new Set<string>();

  try {
    if (shape === "single") {
      if (!item.hasFile || !item.path) return;
      const ext = path.extname(item.path);
      const segments = renderPathSegments(template, { title: item.title, year: item.year ?? "", quality: item.quality ?? "", ...providerIdVars(item) });
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
        const lastEpisodeNumber = group[group.length - 1].episode_number;
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
        const segments = renderPathSegments(template, {
          parentTitle: item.title,
          season: primary.season_number,
          episode:
            group.length > 1
              ? `${String(primary.episode_number).padStart(2, "0")}-${String(lastEpisodeNumber).padStart(2, "0")}`
              : primary.episode_number,
          absoluteEpisode,
          airDate: primary.air_date ?? "",
          episodeTitle: primary.title ?? "",
          year: item.year ?? "",
          quality: primary.quality ?? "",
          ...providerIdVars(item),
        });
        const { destPath } = resolveDest(rootFolder.path, segments, ext, primary.file_path, namingEnabled);
        if (path.resolve(destPath) === path.resolve(primary.file_path)) continue;
        const label =
          group.length > 1
            ? `${item.title} — ${primary.season_number}x${primary.episode_number}-${lastEpisodeNumber}`
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
      const count = (await db.prepare("SELECT COUNT(*) AS c FROM sub_items WHERE media_item_id = ? AND has_file = 1").get(item.id)) as {
        c: number;
      };
      result.skippedMusic += Number(count.c);
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
          providerIdVars(item)
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
