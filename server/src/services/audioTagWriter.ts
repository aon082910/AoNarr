import crypto from "node:crypto";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import NodeID3 from "node-id3";
import { log } from "./logger.js";

export interface AudioTagInfo {
  title: string;
  artist: string;
  album: string;
  trackNumber?: number;
  year?: string | null;
}

/** Writes the tagged copy beside the file and renames it over it, keeping the original's mode and
 * (where permitted) owner. Asynchronous because an audiobook MP3 can run to hundreds of MB, and a
 * synchronous write that size would stall every request and poll in the server. The copy is flushed
 * to disk before the rename: otherwise a power loss can leave the rename on disk but not the data,
 * replacing the only copy of the audio with an empty or truncated file. */
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
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Lidarr-style "retagging" — writes ID3v2 tags (artist/album/track/title/year) directly into an
 * imported audio file, so the file itself carries correct metadata even when opened outside
 * AoNarr (a phone's music app, a different media server, a USB stick). Scoped to MP3/ID3v2 only:
 * `node-id3` is a small pure-JS dependency with no native bindings (safe for the multi-arch Docker
 * build), but it only speaks ID3 — FLAC/OGG/Vorbis-comment and M4A/MP4 atom tag writing would each
 * need a different library and format-specific handling, which isn't built here. A non-MP3 file is
 * silently left untouched rather than erroring the whole import over a tag it can't write. Never
 * throws — a failed tag write is a nice-to-have, not something that should fail the import that
 * triggered it (same contract as metadataExport.ts's writeNfoSidecar).
 */
export async function writeAudioTags(filePath: string, info: AudioTagInfo): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== ".mp3") return;
  try {
    // A symlinked or hardlinked import shares its data with the download client's copy: tagging in
    // place would corrupt a seeding torrent, and replacing the file would break the link and
    // silently double the disk it takes up.
    const link = await fsp.lstat(filePath);
    if (link.isSymbolicLink() || link.nlink > 1) {
      log.info(`[audioTagWriter] left "${filePath}" untagged: it shares its data with the download it was imported from`);
      return;
    }
    const tagged = NodeID3.update(
      {
        title: info.title,
        artist: info.artist,
        album: info.album,
        trackNumber: info.trackNumber != null ? String(info.trackNumber) : undefined,
        year: info.year ?? undefined,
      },
      await fsp.readFile(filePath)
    );
    await replaceWith(filePath, tagged, link);
  } catch (err) {
    log.warn(`[audioTagWriter] failed to write ID3 tags for "${filePath}":`, (err as Error).message);
  }
}
