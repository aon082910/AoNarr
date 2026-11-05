import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type fs from "node:fs";
import {
  cleanTagText,
  commitTempFile,
  syncFile,
  tagFormatOf,
  tempPathNextTo,
  type AudioTagFormat,
  type AudioTagInfo,
  type CoverImage,
  TAGS_UP_TO_DATE,
  type TagWriteResult,
  type ToolRunResult,
  type ToolRunner,
  type WriteAudioTagsOptions,
} from "./audioTagCommon.js";
import { log } from "./logger.js";

/**
 * Tags for FLAC, M4A/M4B/MP4, OGG and Opus, written by remuxing the file through ffmpeg (`-c copy`: the audio is not
 * decoded) into a temporary file beside it. The temporary file is checked with ffprobe (the same audio, the same length, the
 * same cover art and chapters, and the tags read back) before it is flushed and renamed over the original; on any failure it
 * is deleted and the original is untouched. This project has had file-loss bugs in its file handling, so every step that can
 * go wrong ends in "leave the original alone".
 *
 * What ffmpeg cannot keep is caught beforehand instead of lost: an MP4 file carrying tags the MP4 muxer has no atom for
 * (iTunes freeform atoms such as ASIN or iTunNORM) is skipped unless the tags are being scrubbed anyway, and a FLAC file with an
 * embedded cue sheet is skipped. Atoms ffprobe does not show cannot be told apart from absent ones: see the README.
 */

/** At most this many ffmpeg tag writes run at once in the whole process (an import and a library retag share it). */
export const FFMPEG_TAG_CONCURRENCY = 2;
const MIN_TIMEOUT_MS = 60_000;
/** The slowest disk this is expected to work against, which sets how long a write of a given size may take. */
const FLOOR_BYTES_PER_SECOND = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 60_000;
const DURATION_TOLERANCE_SECONDS = 1;
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

export function timeoutForSize(sizeBytes: number): number {
  return Math.max(MIN_TIMEOUT_MS, Math.ceil(sizeBytes / FLOOR_BYTES_PER_SECOND) * 1000);
}

// ---- running the tools ----------------------------------------------------------------------------------------------

export const defaultToolRunner: ToolRunner = (tool, args, { timeoutMs, signal }) =>
  new Promise<ToolRunResult>((resolve) => {
    const result = (extra: Partial<ToolRunResult>): ToolRunResult => ({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, ...extra });
    if (signal?.aborted) return resolve(result({ aborted: true }));
    let child;
    try {
      child = spawn(tool, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return resolve(result({ spawnError: (err as Error).message }));
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (value: ToolRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Only the end matters: ffmpeg's last lines say what went wrong.
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => finish(result({ spawnError: err.message, stderr })));
    child.on("close", (code) => finish(result({ code, stdout, stderr, timedOut, aborted })));
  });

let running = 0;
const waiters: (() => void)[] = [];

async function withFfmpegSlot<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  while (running >= FFMPEG_TAG_CONCURRENCY) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

// ---- probing --------------------------------------------------------------------------------------------------------

export interface ProbedAudio {
  audioStreams: number;
  audioCodec: string | null;
  /** Attached pictures (cover art). */
  pictures: number;
  /** Video streams that are not cover art. */
  videoStreams: number;
  chapters: number;
  duration: number | null;
  /** The container's tags, keys in lower case. */
  formatTags: Map<string, string>;
  /** The first audio stream's tags (where Ogg and Opus keep their comments). */
  streamTags: Map<string, string>;
  majorBrand: string | null;
}

function tagMap(source: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries((source ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim() !== "") map.set(key.toLowerCase(), value.trim());
  }
  return map;
}

export function parseProbe(json: any): ProbedAudio {
  const streams: any[] = Array.isArray(json?.streams) ? json.streams : [];
  const audio = streams.filter((s) => s.codec_type === "audio");
  const isPicture = (s: any) => s.codec_type === "video" && Number(s.disposition?.attached_pic) === 1;
  const duration = Number(json?.format?.duration);
  const formatTags = tagMap(json?.format?.tags);
  return {
    audioStreams: audio.length,
    audioCodec: audio[0]?.codec_name ?? null,
    pictures: streams.filter(isPicture).length,
    videoStreams: streams.filter((s) => s.codec_type === "video" && !isPicture(s)).length,
    chapters: Array.isArray(json?.chapters) ? json.chapters.length : 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    formatTags,
    streamTags: tagMap(audio[0]?.tags),
    // Not trimmed: the brand is four characters and "M4B " ends in a space.
    majorBrand: typeof json?.format?.tags?.major_brand === "string" ? json.format.tags.major_brand : null,
  };
}

async function probe(filePath: string, run: ToolRunner, signal: AbortSignal | undefined): Promise<ProbedAudio | { error: string }> {
  const res = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", "-i", filePath], { timeoutMs: PROBE_TIMEOUT_MS, signal });
  if (res.aborted) return { error: "cancelled" };
  if (res.spawnError) return { error: `ffprobe is not available (${res.spawnError})` };
  if (res.timedOut) return { error: "ffprobe did not answer in time" };
  if (res.code !== 0) return { error: `ffprobe could not read the file: ${lastLine(res.stderr)}` };
  try {
    return parseProbe(JSON.parse(res.stdout));
  } catch {
    return { error: "ffprobe gave an answer that could not be read" };
  }
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "no message";
}

/** The tags a file's format keeps its comments in: the first audio stream for Ogg and Opus, the container for the rest. */
export function commentTags(probed: ProbedAudio, format: AudioTagFormat): Map<string, string> {
  return format === "ogg" || format === "opus" ? new Map([...probed.formatTags, ...probed.streamTags]) : probed.formatTags;
}

// ---- the tags -------------------------------------------------------------------------------------------------------

type Pair = [key: string, value: string];

function pushPair(pairs: Pair[], key: string, value: unknown): void {
  const text = cleanTagText(value);
  if (text !== null) pairs.push([key, text]);
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Keys ffmpeg turns into the format's own names: `track` is TRACKNUMBER, `album_artist` ALBUMARTIST and `disc` DISCNUMBER in
 * a Vorbis comment, so they stay lower case here. The rest are written as given.
 */
export function vorbisTagPairs(info: AudioTagInfo): Pair[] {
  const pairs: Pair[] = [];
  pushPair(pairs, "title", info.title);
  pushPair(pairs, "artist", info.artist);
  pushPair(pairs, "album", info.album);
  pushPair(pairs, "album_artist", info.albumArtist);
  const track = positive(info.trackNumber);
  if (track) {
    pairs.push(["track", String(track)]);
    const total = positive(info.trackTotal);
    if (total && total >= track) pairs.push(["TRACKTOTAL", String(total)]);
  }
  const disc = positive(info.discNumber);
  if (disc) {
    pairs.push(["disc", String(disc)]);
    const total = positive(info.discTotal);
    if (total && total >= disc) pairs.push(["DISCTOTAL", String(total)]);
  }
  pushPair(pairs, "date", info.date ?? info.year);
  pushPair(pairs, "genre", info.genre);
  pushPair(pairs, "composer", info.composer);
  if (cleanTagText(info.series)) {
    pushPair(pairs, "GROUPING", info.series);
    pushPair(pairs, "SERIES", info.series);
    pushPair(pairs, "SERIES-PART", info.seriesPart);
  }
  const mb = info.musicbrainz;
  if (mb) {
    pushPair(pairs, "MUSICBRAINZ_ARTISTID", mb.artistId);
    pushPair(pairs, "MUSICBRAINZ_ALBUMARTISTID", mb.albumArtistId);
    pushPair(pairs, "MUSICBRAINZ_ALBUMID", mb.albumId);
    pushPair(pairs, "MUSICBRAINZ_RELEASEGROUPID", mb.releaseGroupId);
    pushPair(pairs, "MUSICBRAINZ_TRACKID", mb.trackId);
  }
  return pairs;
}

/**
 * The atoms the MP4 muxer writes. Its freeform atoms (the MusicBrainz ids, a series' position) have no home in it, so
 * those are not written to M4A/M4B/MP4 files.
 */
export function mp4TagPairs(info: AudioTagInfo): Pair[] {
  const pairs: Pair[] = [];
  pushPair(pairs, "title", info.title);
  pushPair(pairs, "artist", info.artist);
  pushPair(pairs, "album", info.album);
  pushPair(pairs, "album_artist", info.albumArtist);
  const track = positive(info.trackNumber);
  if (track) {
    const total = positive(info.trackTotal);
    pairs.push(["track", total && total >= track ? `${track}/${total}` : String(track)]);
  }
  const disc = positive(info.discNumber);
  if (disc) {
    const total = positive(info.discTotal);
    pairs.push(["disc", total && total >= disc ? `${disc}/${total}` : String(disc)]);
  }
  pushPair(pairs, "date", info.date ?? info.year);
  pushPair(pairs, "genre", info.genre);
  pushPair(pairs, "composer", info.composer);
  const series = cleanTagText(info.series);
  const part = cleanTagText(info.seriesPart);
  if (series) pairs.push(["grouping", part ? `${series} #${part}` : series]);
  return pairs;
}

export function ffmpegTagPairs(format: AudioTagFormat, info: AudioTagInfo): Pair[] {
  return format === "mp4" ? mp4TagPairs(info) : vorbisTagPairs(info);
}

/** Keys the MP4 muxer writes (the others are dropped by a remux) and the technical ones ffmpeg sets again by itself. */
const MP4_WRITABLE_KEYS = new Set([
  "title", "artist", "album_artist", "composer", "album", "date", "comment", "genre", "copyright", "grouping", "lyrics", "description",
  "synopsis", "show", "episode_id", "network", "keywords", "episode_sort", "season_number", "media_type", "hd_video", "gapless_playback",
  "compilation", "track", "disc",
]);
const TECHNICAL_KEYS = new Set(["encoder", "major_brand", "minor_version", "compatible_brands", "creation_time", "handler_name", "vendor_id", "language", "encoding_tool"]);

/** Tags the file has that a remux through the MP4 muxer would lose. */
export function mp4TagsThatWouldBeLost(formatTags: Map<string, string>): string[] {
  return [...formatTags.keys()].filter((key) => !MP4_WRITABLE_KEYS.has(key) && !TECHNICAL_KEYS.has(key));
}

function leadingNumber(value: string): string {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? String(n) : value;
}

/** Whether a tag read back is the value that was meant to be written (the case of ids, the "3" of "3/12" and so on aside). */
export function tagValueMatches(key: string, expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const k = key.toLowerCase();
  const a = actual.normalize("NFC").trim();
  const e = expected.normalize("NFC").trim();
  if (k === "track" || k === "disc") return expected.includes("/") ? a.replace(/\s+/g, "") === e : leadingNumber(a.split("/")[0]) === leadingNumber(e);
  if (k.startsWith("musicbrainz_")) return a.toLowerCase() === e.toLowerCase();
  if (k === "date") return a === e || a.startsWith(e) || e.startsWith(a);
  return a === e;
}

/** The tags still to write: those the file does not have as they should be. Empty when it is up to date. */
export function missingTagPairs(pairs: Pair[], current: Map<string, string>): Pair[] {
  return pairs.filter(([key, value]) => !tagValueMatches(key, value, current.get(key.toLowerCase())));
}

// ---- the command ----------------------------------------------------------------------------------------------------

export interface FfmpegPlan {
  input: string;
  output: string;
  muxer: string;
  format: AudioTagFormat;
  pairs: Pair[];
  scrub: boolean;
  /** A temporary copy of the cover to embed, and whether it takes the place of the pictures the file has. */
  coverFile: string | null;
  /** The source's major brand, kept (an M4B stays an M4B). */
  brand: string | null;
}

export function buildFfmpegArgs(plan: FfmpegPlan): string[] {
  const args = ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", plan.input];
  if (plan.coverFile) args.push("-i", plan.coverFile);
  // Audio plus pictures only: another stream type is not what a tag write should carry over, and the chapter track of an M4B is
  // rebuilt from the chapters (-map_chapters), not copied as a stream.
  args.push("-map", "0:a");
  if (plan.coverFile) args.push("-map", "1:v");
  else args.push("-map", "0:v?");
  if (plan.format === "mp4") args.push("-map_chapters", "0");
  args.push("-map_metadata", plan.scrub ? "-1" : "0", "-c", "copy");
  if (plan.coverFile) {
    args.push("-disposition:v:0", "attached_pic");
    if (plan.format === "flac") args.push("-metadata:s:v:0", "comment=Cover (front)");
  }
  // No encoder tag of ffmpeg's own, and a stable result when the same tags are written again.
  args.push("-fflags", "+bitexact");
  if (plan.format === "mp4") {
    args.push("-movflags", "+faststart");
    if (plan.brand && plan.brand.length === 4) args.push("-brand", plan.brand);
  }
  // An Ogg or Opus file keeps its comments on the stream, and a comment already there wins over the container's: it is the
  // stream's tag that has to be replaced.
  const target = plan.format === "ogg" || plan.format === "opus" ? "-metadata:s:a:0" : "-metadata";
  for (const [key, value] of plan.pairs) args.push(target, `${key}=${value}`);
  args.push("-f", plan.muxer, plan.output);
  return args;
}

/** Only these hold a picture ffmpeg 5 can write: its Ogg muxer has no picture block. */
export function formatEmbedsCover(format: AudioTagFormat): boolean {
  return format === "flac" || format === "mp4";
}

// ---- verifying ------------------------------------------------------------------------------------------------------

/** What is wrong with the output, or null when it is the same audio with the tags in it. */
export function verifyTaggedOutput(
  source: ProbedAudio,
  output: ProbedAudio,
  plan: { format: AudioTagFormat; pairs: Pair[]; coverEmbedded: boolean },
  outputSize: number,
  sourceSize: number
): string | null {
  if (output.audioStreams !== source.audioStreams) return `the tagged copy has ${output.audioStreams} audio stream(s), the file has ${source.audioStreams}`;
  if (output.audioCodec !== source.audioCodec) return `the tagged copy's audio is ${output.audioCodec ?? "unknown"}, the file's is ${source.audioCodec ?? "unknown"}`;
  if ((source.duration === null) !== (output.duration === null)) return "the tagged copy's length cannot be compared with the file's";
  if (source.duration !== null && output.duration !== null && Math.abs(output.duration - source.duration) > DURATION_TOLERANCE_SECONDS) {
    return `the tagged copy is ${output.duration.toFixed(1)} s long, the file is ${source.duration.toFixed(1)} s`;
  }
  if (outputSize <= 0 || outputSize < sourceSize * 0.5) return `the tagged copy is ${outputSize} bytes, the file is ${sourceSize}`;
  const expectedPictures = plan.coverEmbedded ? 1 : source.pictures;
  if (output.pictures !== expectedPictures) return `the tagged copy has ${output.pictures} picture(s), expected ${expectedPictures}`;
  if (plan.format !== "flac" && output.chapters !== source.chapters) return `the tagged copy has ${output.chapters} chapter(s), the file has ${source.chapters}`;
  const stillMissing = missingTagPairs(plan.pairs, commentTags(output, plan.format));
  if (stillMissing.length > 0) return `the tags did not read back (${stillMissing.map(([key]) => key).join(", ")})`;
  return null;
}

// ---- the write ------------------------------------------------------------------------------------------------------

class SkipFile extends Error {}

function skipped(format: string, reason: string): TagWriteResult {
  return { outcome: "skipped", reason, format };
}

function failed(format: string, reason: string): TagWriteResult {
  return { outcome: "failed", reason, format };
}

/**
 * Writes `info` into a FLAC, M4A/M4B/MP4, OGG or Opus file by remuxing it through ffmpeg (see the top of this file).
 * `original` is the file's lstat, taken by the caller. Never throws.
 */
export async function writeTagsWithFfmpeg(filePath: string, info: AudioTagInfo, options: WriteAudioTagsOptions, original: fs.Stats): Promise<TagWriteResult> {
  const entry = tagFormatOf(filePath);
  if (!entry || !entry.muxer) return skipped(path.extname(filePath), "this format cannot be tagged");
  const label = entry.label;
  const run = options.runner ?? defaultToolRunner;
  const { signal } = options;
  const scrub = options.scrub === true;

  if (original.size === 0) return skipped(label, "the file is empty");
  try {
    await fsp.access(filePath, fsConstants.W_OK);
    await fsp.access(path.dirname(filePath), fsConstants.W_OK);
  } catch {
    return skipped(label, "the file or its folder is not writable");
  }

  const tmpPath = tempPathNextTo(filePath);
  // The cover copies made for ffmpeg, all removed at the end.
  const coverCopies: string[] = [];
  try {
    const source = await probe(filePath, run, signal);
    if ("error" in source) return source.error === "cancelled" ? skipped(label, "cancelled") : failed(label, source.error);
    if (source.audioStreams === 0) return skipped(label, "the file has no audio stream");
    if (source.videoStreams > 0) return skipped(label, "the file has a video track, which a tag write would not carry over");
    if (entry.format === "flac" && source.chapters > 0) return skipped(label, "the FLAC file has an embedded cue sheet, which the FLAC muxer would drop");

    if (entry.format === "mp4" && !scrub) {
      const lost = mp4TagsThatWouldBeLost(source.formatTags);
      if (lost.length > 0) return skipped(label, `it carries tags the MP4 muxer cannot rewrite (${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ", ..." : ""}): left as it is`);
    }

    const pairs = ffmpegTagPairs(entry.format, info);
    const current = commentTags(source, entry.format);
    // A cover goes in a file that has none (or, scrubbing, in place of what it has); one with a picture of its own keeps it.
    const wantsCover = !!options.cover && formatEmbedsCover(entry.format) && (source.pictures === 0 || scrub);
    const coverSkipped = options.cover && !formatEmbedsCover(entry.format) ? "the cover is left out: ffmpeg cannot put a picture in this format" : undefined;
    const tagsMissing = missingTagPairs(pairs, current).length > 0;
    const extraTags = scrub ? [...current.keys()].filter((key) => !TECHNICAL_KEYS.has(key) && !pairs.some(([k]) => k.toLowerCase() === key)) : [];
    if (!tagsMissing && extraTags.length === 0 && !wantsCover) {
      return { outcome: "skipped", reason: TAGS_UP_TO_DATE, format: label };
    }

    const sizeBefore = original.size;
    const timeoutMs = timeoutForSize(sizeBefore);

    let embedded = false;
    const attempt = async (withCover: boolean): Promise<ToolRunResult> => {
      let coverFile: string | null = null;
      if (withCover && options.cover) {
        coverFile = tempPathNextTo(filePath, "cover").replace(/\.[^.]+$/, options.cover.mime === "image/png" ? ".png" : ".jpg");
        coverCopies.push(coverFile);
        await fsp.writeFile(coverFile, options.cover.data, { flag: "wx" });
      }
      const plan: FfmpegPlan = {
        input: filePath,
        output: tmpPath,
        muxer: entry.muxer!,
        format: entry.format,
        pairs,
        scrub,
        coverFile,
        brand: source.majorBrand,
      };
      const res = await withFfmpegSlot(signal, () => run("ffmpeg", buildFfmpegArgs(plan), { timeoutMs, signal }));
      if (res.code === 0 && !res.spawnError && !res.timedOut && !res.aborted) embedded = coverFile !== null;
      return res;
    };

    let res = await attempt(wantsCover);
    if (wantsCover && res.code !== 0 && !res.aborted && !res.timedOut && !res.spawnError) {
      // A cover that ffmpeg cannot take (an odd image) must not cost the tags.
      log.warn(`[audioTagWriter] ffmpeg could not embed the cover into "${filePath}" (${lastLine(res.stderr)}): writing the tags without it`);
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      res = await attempt(false);
    }
    if (res.aborted) return skipped(label, "cancelled");
    if (res.spawnError) return failed(label, `ffmpeg is not available (${res.spawnError})`);
    if (res.timedOut) return failed(label, `ffmpeg did not finish within ${Math.round(timeoutMs / 1000)} s`);
    if (res.code !== 0) return failed(label, `ffmpeg stopped with code ${res.code}: ${lastLine(res.stderr)}`);

    const written = await fsp.stat(tmpPath).catch(() => null);
    if (!written) return failed(label, "ffmpeg wrote no file");
    const output = await probe(tmpPath, run, signal);
    if ("error" in output) return output.error === "cancelled" ? skipped(label, "cancelled") : failed(label, `the tagged copy could not be checked: ${output.error}`);
    const problem = verifyTaggedOutput(source, output, { format: entry.format, pairs, coverEmbedded: embedded }, written.size, sizeBefore);
    if (problem) return failed(label, `the tagged copy was not used: ${problem}`);

    await syncFile(tmpPath);
    // Another program (the download client, a media manager, the user) may have changed the file while ffmpeg read it.
    const now = await fsp.stat(filePath).catch(() => null);
    if (!now || now.size !== original.size || now.mtimeMs !== original.mtimeMs || now.ino !== original.ino) {
      throw new SkipFile("the file changed while it was being tagged");
    }
    await commitTempFile(tmpPath, filePath, original);
    return { outcome: "written", format: label, ...(coverSkipped ? { reason: coverSkipped } : wantsCover && !embedded ? { reason: "the cover is left out: ffmpeg could not embed it" } : {}) };
  } catch (err) {
    if (err instanceof SkipFile) return skipped(label, err.message);
    if ((err as Error).name === "AbortError") return skipped(label, "cancelled");
    return failed(label, (err as Error).message);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    for (const copy of coverCopies) await fsp.rm(copy, { force: true }).catch(() => {});
  }
}

export type { CoverImage };
