import crypto from "node:crypto";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * What the audio tag writers (audioTagWriter.ts for MP3 through node-id3, audioTagFfmpeg.ts for FLAC, M4A/M4B/MP4,
 * OGG and Opus through ffmpeg) share: the shapes they take and give back, the format table, the "write tags" mode and
 * the safe replace-by-rename.
 */

export interface MusicBrainzIds {
  artistId?: string | null;
  albumArtistId?: string | null;
  /** The release (one pressing of an album). AoNarr keeps the release group, so this is only set where something knows it. */
  albumId?: string | null;
  releaseGroupId?: string | null;
  /** The recording. */
  trackId?: string | null;
}

export interface AudioTagInfo {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string | null;
  trackNumber?: number;
  trackTotal?: number | null;
  discNumber?: number | null;
  discTotal?: number | null;
  /** The four digit year; `date` carries the whole date when it is known and is what a Vorbis or MP4 file gets. */
  year?: string | null;
  date?: string | null;
  genre?: string | null;
  /** An audiobook's narrator (a book has no composer, and players show this field). */
  composer?: string | null;
  /** The series an audiobook is part of and its place in it. */
  series?: string | null;
  seriesPart?: string | null;
  musicbrainz?: MusicBrainzIds;
}

export interface CoverImage {
  data: Buffer;
  mime: "image/jpeg" | "image/png";
}

/** The reason of a skip that is the normal case of a pass over tagged files (not logged one by one). */
export const TAGS_UP_TO_DATE = "the tags are already up to date";

export type TagWriteOutcome = "written" | "skipped" | "failed";

export interface TagWriteResult {
  outcome: TagWriteOutcome;
  /** Why a file was skipped or failed; also set on "written" when the cover could not go in with the tags. */
  reason?: string;
  /** The report label of the file's format ("MP3", "FLAC", "M4A/M4B", "OGG", "Opus"); the extension for one we cannot write. */
  format: string;
}

/** The result of one external tool run. A tool that could not start (not installed) has `spawnError`. */
export interface ToolRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export type ToolRunner = (tool: "ffmpeg" | "ffprobe", args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<ToolRunResult>;

export interface WriteAudioTagsOptions {
  /** Remove every tag the file has before writing (the text tags; an embedded picture stays unless a new cover replaces it). */
  scrub?: boolean;
  /** Put this picture in the file when it has none (when scrubbing, in place of the one it has). */
  cover?: CoverImage | null;
  /** Cancels a write in progress: ffmpeg is stopped, its temporary file removed and the original left as it was. */
  signal?: AbortSignal;
  /** Replaces the ffmpeg and ffprobe runs (tests). */
  runner?: ToolRunner;
}

export type AudioTagFormat = "mp3" | "flac" | "mp4" | "ogg" | "opus";

interface FormatEntry {
  format: AudioTagFormat;
  label: string;
  /** The ffmpeg muxer to name with -f (the extension is never trusted to pick it). */
  muxer?: string;
}

const FORMATS: Readonly<Record<string, FormatEntry>> = {
  ".mp3": { format: "mp3", label: "MP3" },
  ".flac": { format: "flac", label: "FLAC", muxer: "flac" },
  ".m4a": { format: "mp4", label: "M4A/M4B", muxer: "ipod" },
  ".m4b": { format: "mp4", label: "M4A/M4B", muxer: "ipod" },
  ".mp4": { format: "mp4", label: "M4A/M4B", muxer: "mp4" },
  ".ogg": { format: "ogg", label: "OGG", muxer: "ogg" },
  ".oga": { format: "ogg", label: "OGG", muxer: "ogg" },
  ".opus": { format: "opus", label: "Opus", muxer: "opus" },
};

/** The extensions a tag can be written to. */
export const TAGGABLE_EXTENSIONS: readonly string[] = Object.keys(FORMATS);

export function tagFormatOf(filePath: string): (FormatEntry & { extension: string }) | null {
  const extension = path.extname(filePath).toLowerCase();
  const entry = FORMATS[extension];
  return entry ? { ...entry, extension } : null;
}

/** The report label for a file: its format's, or its extension in upper case when we cannot write it. */
export function formatLabelOf(filePath: string): string {
  const entry = tagFormatOf(filePath);
  if (entry) return entry.label;
  const extension = path.extname(filePath).replace(/^\./, "").toUpperCase();
  return extension || "unknown";
}

export const WRITE_TAGS_MODES = ["none", "new", "all", "sync"] as const;
export type WriteTagsMode = (typeof WRITE_TAGS_MODES)[number];

/**
 * Lidarr's "write tags" choice. `writeAudioTagsMode` wins when it is set; before it existed `writeAudioTagsOnImport = 1`
 * meant "tag what is imported", which is `new`, so an upgrade changes nothing.
 */
export function resolveWriteTagsMode(modeSetting: string | undefined | null, legacyOnImport: string | undefined | null): WriteTagsMode {
  const mode = (modeSetting ?? "").trim();
  if ((WRITE_TAGS_MODES as readonly string[]).includes(mode)) return mode as WriteTagsMode;
  return legacyOnImport === "1" ? "new" : "none";
}

/** New and upgraded files are tagged as they are imported. */
export function modeTagsOnImport(mode: WriteTagsMode): boolean {
  return mode !== "none";
}

/** The scheduled library pass runs: for `all` (new files and a library-wide retag) and `sync` (edits are followed). */
export function modeRetagsLibrary(mode: WriteTagsMode): boolean {
  return mode === "all" || mode === "sync";
}

/** An edit or rematch of a title retags its files at once. */
export function modeFollowsEdits(mode: WriteTagsMode): boolean {
  return mode === "sync";
}

/** A hidden name beside the file (the same prefix the scanner and the leftover sweep know), with the file's extension. */
export function tempPathNextTo(filePath: string, kind = ""): string {
  const suffix = kind ? `${kind}-` : "";
  return path.join(path.dirname(filePath), `.aonarr-tmp-${suffix}${crypto.randomBytes(6).toString("hex")}${path.extname(filePath).toLowerCase()}`);
}

/**
 * Puts a finished temporary file over the original: mode and (where permitted) owner are the original's, and the rename is
 * the last step. The caller removes the temp file when this throws.
 */
export async function commitTempFile(tmpPath: string, filePath: string, original: fs.Stats): Promise<void> {
  await fsp.chmod(tmpPath, original.mode & 0o7777);
  // Not permitted when running unprivileged; the file then keeps this process's own owner.
  await fsp.chown(tmpPath, original.uid, original.gid).catch(() => {});
  await fsp.rename(tmpPath, filePath);
}

/** Flushes a file's data to disk before it is renamed into place: a power loss after the rename must not leave an empty file. */
export async function syncFile(filePath: string): Promise<void> {
  const fh = await fsp.open(filePath, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** A file's tag text, trimmed and without control characters (an ffmpeg argument and an ID3 frame both take it as it comes). */
export function cleanTagText(value: unknown): string | null {
  if (value == null) return null;
  // eslint-disable-next-line no-control-regex
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text === "" ? null : text;
}
