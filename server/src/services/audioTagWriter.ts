import crypto from "node:crypto";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import NodeID3 from "node-id3";
import { writeTagsWithFfmpeg } from "./audioTagFfmpeg.js";
import { lockAudioFile, unlockAudioFile } from "./audioFileLock.js";
import {
  FileChangedError,
  LEGACY_MP3_ONLY,
  TAGS_UP_TO_DATE,
  TAG_FILE_BUSY,
  TAG_NO_SPACE,
  assertFileUnchanged,
  cleanTagText,
  formatLabelOf,
  freeSpaceProblem,
  tagFormatOf,
  withTagSlot,
  type AudioTagInfo,
  type CoverImage,
  type TagWriteResult,
  type WriteAudioTagsOptions,
} from "./audioTagCommon.js";
import { log } from "./logger.js";

export type { AudioTagInfo, CoverImage, TagWriteResult, WriteAudioTagsOptions } from "./audioTagCommon.js";

/** Writes the tagged copy beside the file and renames it over it, keeping the original's mode and
 * (where permitted) owner. Asynchronous because an audiobook MP3 can run to hundreds of MB, and a
 * synchronous write that size would stall every request and poll in the server. The copy is flushed
 * to disk before the rename: otherwise a power loss can leave the rename on disk but not the data,
 * replacing the only copy of the audio with an empty or truncated file. The bytes were read a while
 * ago: if the file at the path is no longer the one they came from (replaced by an import, changed by
 * another program), the copy is dropped, not renamed over the newer file. */
async function replaceWith(filePath: string, data: Buffer, original: fs.Stats): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.aonarr-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const fh = await fsp.open(tmpPath, "wx");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.chmod(tmpPath, original.mode & 0o7777);
    // Not permitted when running unprivileged; the file then keeps this process's own owner.
    await fsp.chown(tmpPath, original.uid, original.gid).catch(() => {});
    await assertFileUnchanged(filePath, original);
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

// ---- MP3 (ID3v2, through node-id3) -----------------------------------------------------------------------------------

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function ofTotal(n: number, total: number | null): string {
  return total && total >= n ? `${n}/${total}` : String(n);
}

/** The ID3 frames for `info`. MusicBrainz ids go in the TXXX frames Picard uses. */
export function id3TagsFor(info: AudioTagInfo): NodeID3.Tags {
  const tags: NodeID3.Tags = {};
  const text = (value: unknown) => cleanTagText(value) ?? undefined;
  tags.title = text(info.title);
  tags.artist = text(info.artist);
  tags.album = text(info.album);
  tags.performerInfo = text(info.albumArtist);
  const track = positive(info.trackNumber);
  if (track) tags.trackNumber = ofTotal(track, positive(info.trackTotal));
  const disc = positive(info.discNumber);
  if (disc) tags.partOfSet = ofTotal(disc, positive(info.discTotal));
  // TYER takes four digits.
  const year = /^\d{4}/.exec(String(info.year ?? info.date ?? ""))?.[0];
  if (year) tags.year = year;
  tags.genre = text(info.genre);
  tags.composer = text(info.composer);
  const series = text(info.series);
  const userText: { description: string; value: string }[] = [];
  const addText = (description: string, value: unknown) => {
    const v = text(value);
    if (v) userText.push({ description, value: v });
  };
  if (series) {
    tags.contentGroup = series;
    addText("SERIES", series);
    addText("SERIES-PART", info.seriesPart);
  }
  const mb = info.musicbrainz;
  if (mb) {
    addText("MusicBrainz Artist Id", mb.artistId);
    addText("MusicBrainz Album Artist Id", mb.albumArtistId);
    addText("MusicBrainz Album Id", mb.albumId);
    addText("MusicBrainz Release Group Id", mb.releaseGroupId);
  }
  if (userText.length > 0) tags.userDefinedText = userText;
  // An absent field must not be sent as undefined: update() would take it as "set to nothing".
  for (const key of Object.keys(tags) as (keyof NodeID3.Tags)[]) if (tags[key] === undefined) delete tags[key];
  return tags;
}

/**
 * What the old on/off switch wrote: title, artist, album, track number (as the plain number) and year. Nothing else, so no other
 * frame of the file is touched.
 */
export function legacyId3TagsFor(info: AudioTagInfo): NodeID3.Tags {
  const tags: NodeID3.Tags = {};
  const text = (value: unknown) => cleanTagText(value) ?? undefined;
  tags.title = text(info.title);
  tags.artist = text(info.artist);
  tags.album = text(info.album);
  const track = positive(info.trackNumber);
  if (track) tags.trackNumber = String(track);
  const year = /^\d{4}/.exec(String(info.year ?? ""))?.[0];
  if (year) tags.year = year;
  for (const key of Object.keys(tags) as (keyof NodeID3.Tags)[]) if (tags[key] === undefined) delete tags[key];
  return tags;
}

/** Frames this writer sets; any other text frame on a file is somebody else's tag. */
const MANAGED_FRAMES = new Set(["TIT2", "TPE1", "TALB", "TPE2", "TRCK", "TPOS", "TYER", "TCON", "TCOM", "TIT1", "TXXX", "APIC"]);

function sameCount(wanted: string, have: string): boolean {
  return wanted.includes("/") ? wanted === have : parseInt(have, 10) === parseInt(wanted, 10);
}

/** Whether the file's ID3 tag already has everything in `wanted` (and, when scrubbing, nothing else). */
function id3UpToDate(current: any, wanted: NodeID3.Tags, scrub: boolean, wantsCover: boolean): boolean {
  const same = (key: keyof NodeID3.Tags, compare: (w: string, h: string) => boolean = (w, h) => w === h): boolean => {
    const w = wanted[key];
    if (w === undefined) return true;
    const h = current[key];
    return typeof w === "string" && typeof h === "string" && compare(w, h);
  };
  if (!same("title") || !same("artist") || !same("album") || !same("performerInfo") || !same("year") || !same("genre") || !same("composer") || !same("contentGroup")) return false;
  if (!same("trackNumber", sameCount) || !same("partOfSet", sameCount)) return false;
  for (const want of wanted.userDefinedText ?? []) {
    const have = (current.userDefinedText ?? []).find((t: { description: string }) => t.description === want.description);
    if (!have || have.value !== want.value) return false;
  }
  if (wantsCover && !current.image) return false;
  if (scrub) {
    const raw = (current.raw ?? {}) as Record<string, unknown>;
    if (Object.keys(raw).some((frame) => !MANAGED_FRAMES.has(frame))) return false;
    const wantedUserText = new Set((wanted.userDefinedText ?? []).map((t) => t.description));
    if ((current.userDefinedText ?? []).some((t: { description: string }) => !wantedUserText.has(t.description))) return false;
  }
  return true;
}

/** The last 128 bytes of an MP3 are an ID3v1 tag when they start with "TAG". */
function withoutId3v1(buffer: Buffer): Buffer {
  return buffer.length >= 128 && buffer.subarray(buffer.length - 128, buffer.length - 125).toString("latin1") === "TAG" ? buffer.subarray(0, buffer.length - 128) : buffer;
}

/** An MP3 is read whole, and copied once more to put the tag in front of it: past this it is left alone rather than risk the process's memory. */
export const MP3_MAX_BYTES = 512 * 1024 * 1024;

async function writeMp3Tags(filePath: string, info: AudioTagInfo, options: WriteAudioTagsOptions, link: fs.Stats): Promise<TagWriteResult> {
  if (link.size > MP3_MAX_BYTES) {
    return { outcome: "skipped", reason: `the MP3 is over ${MP3_MAX_BYTES / 1024 ** 2} MB, more than can be held in memory while it is rewritten`, format: "MP3" };
  }
  // The old switch writes its five fields and leaves everything else (other frames, the picture) as it is.
  const legacy = options.legacy === true;
  const scrub = !legacy && options.scrub === true;
  const data = await fsp.readFile(filePath);
  let current: any = {};
  try {
    current = NodeID3.read(data, { noRaw: false }) || {};
  } catch {
    // not a readable ID3 tag: the write below starts a new one
  }
  const wanted = legacy ? legacyId3TagsFor(info) : id3TagsFor(info);
  const cover = legacy ? null : options.cover;
  const wantsCover = !!cover && (!current.image || scrub);
  if (id3UpToDate(current, wanted, scrub, wantsCover)) return { outcome: "skipped", reason: TAGS_UP_TO_DATE, format: "MP3" };
  // The tagged copy is written beside the file and is as big as it.
  const space = await freeSpaceProblem(path.dirname(filePath), link.size, options.statfs);
  if (space) {
    log.warn(`[audioTagWriter] "${filePath}" left untagged: ${Math.round(space.free / 1024 ** 2)} MB free beside it, ${Math.round(space.needed / 1024 ** 2)} MB needed for the tagged copy`);
    return { outcome: "skipped", reason: TAG_NO_SPACE, format: "MP3" };
  }

  const tags: NodeID3.Tags = { ...wanted };
  if (wantsCover && cover) {
    tags.image = { mime: cover.mime, type: { id: 3 }, description: "Cover", imageBuffer: cover.data };
  } else if (scrub && current.image) {
    // Scrubbing removes the text tags; the picture stays unless a new cover takes its place.
    tags.image = current.image;
  }
  let tagged: Buffer;
  if (scrub) {
    // Exported by node-id3 but missing from its type declarations.
    const stripped = (NodeID3 as unknown as { removeTagsFromBuffer(buffer: Buffer): Buffer | false }).removeTagsFromBuffer(data);
    tagged = NodeID3.write(tags, withoutId3v1(Buffer.isBuffer(stripped) ? stripped : data)) as Buffer;
  } else {
    tagged = NodeID3.update(tags, data) as Buffer;
  }
  await replaceWith(filePath, tagged, link);
  return { outcome: "written", format: "MP3" };
}

// ---- the entry point -------------------------------------------------------------------------------------------------

/**
 * Lidarr-style "retagging" — writes artist, album, title, track, disc, year, genre and the MusicBrainz ids that are known
 * directly into an audio file, so the file itself carries correct metadata even when opened outside AoNarr (a phone's music
 * app, a different media server, a USB stick). MP3 goes through `node-id3` (a small pure-JS dependency with no native
 * bindings, safe for the multi-arch Docker build); FLAC, M4A/M4B/MP4, OGG and Opus go through ffmpeg (audioTagFfmpeg.ts),
 * which is in the product image. Any other format is left alone and reported as skipped.
 *
 * Never throws — a failed tag write is a nice-to-have, not something that should fail the import that triggered it (same
 * contract as metadataExport.ts's writeNfoSidecar); the result says what happened and why, for the retag report.
 */
export async function writeAudioTags(filePath: string, info: AudioTagInfo, options: WriteAudioTagsOptions = {}): Promise<TagWriteResult> {
  const entry = tagFormatOf(filePath);
  const label = formatLabelOf(filePath);
  if (!entry) return { outcome: "skipped", reason: `${label} files cannot be tagged`, format: label };
  // The old on/off switch tagged MP3 files and nothing else.
  if (options.legacy && entry.format !== "mp3") return { outcome: "skipped", reason: LEGACY_MP3_ONLY, format: label };
  // One writer per file: an import that replaces the file, or another tag write, would be undone by a copy made from the old bytes.
  if (!(await lockAudioFile(filePath, options.lockWaitMs ?? 0))) {
    log.info(`[audioTagWriter] left "${filePath}" untagged: ${TAG_FILE_BUSY}`);
    return { outcome: "skipped", reason: TAG_FILE_BUSY, format: label };
  }
  try {
    // Waits its turn behind the other files being written (see withTagSlot); the file is looked at only once it is this one's turn.
    return await withTagSlot(options.signal, async (): Promise<TagWriteResult> => {
      // A symlinked or hardlinked import shares its data with the download client's copy: tagging in
      // place would corrupt a seeding torrent, and replacing the file would break the link and
      // silently double the disk it takes up.
      const link = await fsp.lstat(filePath);
      if (link.isSymbolicLink() || link.nlink > 1) {
        log.info(`[audioTagWriter] left "${filePath}" untagged: it shares its data with the download it was imported from`);
        return { outcome: "skipped", reason: "it shares its data with the download it was imported from (a hardlink or symlink)", format: label };
      }
      if (!link.isFile()) return { outcome: "skipped", reason: "it is not a regular file", format: label };
      const result = entry.format === "mp3" ? await writeMp3Tags(filePath, info, options, link) : await writeTagsWithFfmpeg(filePath, info, options, link);
      if (result.outcome === "failed") log.warn(`[audioTagWriter] failed to write ${label} tags for "${filePath}": ${result.reason}`);
      else if (result.outcome === "skipped" && result.reason !== TAGS_UP_TO_DATE) log.info(`[audioTagWriter] left "${filePath}" untagged: ${result.reason}`);
      return result;
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "skipped", reason: "the file is missing", format: label };
    if (err instanceof FileChangedError) {
      log.info(`[audioTagWriter] left "${filePath}" untagged: ${err.message}`);
      return { outcome: "skipped", reason: err.message, format: label };
    }
    if ((err as Error).name === "AbortError") return { outcome: "skipped", reason: "cancelled", format: label };
    log.warn(`[audioTagWriter] failed to write ${label} tags for "${filePath}":`, (err as Error).message);
    return { outcome: "failed", reason: (err as Error).message, format: label };
  } finally {
    unlockAudioFile(filePath);
  }
}
