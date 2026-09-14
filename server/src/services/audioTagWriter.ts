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
    await NodeID3.Promise.update(
      {
        title: info.title,
        artist: info.artist,
        album: info.album,
        trackNumber: info.trackNumber != null ? String(info.trackNumber) : undefined,
        year: info.year ?? undefined,
      },
      filePath
    );
  } catch (err) {
    log.warn(`[audioTagWriter] failed to write ID3 tags for "${filePath}":`, (err as Error).message);
  }
}
