import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../db/index.js";
import { probeMediaInfo } from "./ffprobe.js";
import { safeFileName } from "./metadataExport.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

interface TrackToMerge {
  id: number;
  trackNumber: number;
  title: string;
  filePath: string;
}

/** FFMPEG's FFMETADATA1 chapter format — start/end are in the timebase declared on the first
 * line (1/1000 here, i.e. milliseconds), which keeps the math simple (no rational-number juggling
 * for odd durations). */
function buildChapterMetadata(tracks: { title: string; durationMs: number }[]): string {
  const lines = [";FFMETADATA1"];
  let cursor = 0;
  for (const t of tracks) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${cursor}`,
      `END=${cursor + t.durationMs}`,
      `title=${t.title.replace(/[\r\n]/g, " ")}`
    );
    cursor += t.durationMs;
  }
  return lines.join("\n");
}

/**
 * Merges every downloaded track of an audiobook sub-item into one chapterized M4B — the LazyLibrarian
 * advantage this codebase otherwise lacked: audiobooks downloaded as a folder of per-chapter MP3/M4A
 * files stay a folder of files forever with no way to get one clean chapterized book out of it.
 * Uses ffmpeg's concat filter (not the concat demuxer) specifically because it decodes each input
 * properly regardless of container/codec before joining, so it works whether the source tracks are
 * mixed bitrates/codecs or perfectly uniform — unlike the demuxer, which requires format-identical
 * inputs to concatenate safely.
 *
 * On success, replaces every per-track `tracks` row for this sub-item with a single row pointing at
 * the merged file — everything downstream (OPDS, Send to Kindle, the track list UI) already treats
 * one row per downloadable file as the invariant for a `multiFilePerChild` type, so collapsing N
 * tracks into 1 needs no changes anywhere else.
 */
export async function convertSubItemToM4b(subItemId: number): Promise<{ path: string }> {
  const subRow = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
  if (!subRow) throw new Error("Sub-item not found");
  if (!subRow.file_path) throw new Error("This audiobook has no downloaded folder yet");

  const trackRows = (await db
    .prepare("SELECT id, track_number, title, file_path FROM tracks WHERE sub_item_id = ? AND has_file = 1 ORDER BY track_number")
    .all(subItemId)) as { id: number; track_number: number; title: string; file_path: string }[];
  if (trackRows.length < 2) throw new Error("Need at least 2 downloaded tracks to merge into one M4B");

  const tracks: TrackToMerge[] = trackRows.map((t) => ({ id: t.id, trackNumber: t.track_number, title: t.title, filePath: t.file_path }));
  for (const t of tracks) {
    if (!fs.existsSync(t.filePath)) throw new Error(`Track file missing on disk: ${t.filePath}`);
  }

  const durations: number[] = [];
  for (const t of tracks) {
    const info = await probeMediaInfo(t.filePath);
    if (!info?.durationSeconds) throw new Error(`Couldn't read duration for "${t.title}" — ffprobe returned nothing`);
    durations.push(Math.round(info.durationSeconds * 1000));
  }

  const destDir = fs.statSync(subRow.file_path).isDirectory() ? subRow.file_path : path.dirname(subRow.file_path);
  const outputPath = path.join(destDir, `${safeFileName(subRow.title)}.m4b`);
  const chapterMetaPath = path.join(destDir, `.aonarr-chapters-${subItemId}.txt`);
  fs.writeFileSync(chapterMetaPath, buildChapterMetadata(tracks.map((t, i) => ({ title: t.title, durationMs: durations[i] }))));

  const inputArgs = tracks.flatMap((t) => ["-i", t.filePath]);
  const concatInputs = tracks.map((_, i) => `[${i}:a]`).join("");
  const filterComplex = `${concatInputs}concat=n=${tracks.length}:v=0:a=1[out]`;
  const args = [
    "-y",
    ...inputArgs,
    "-i",
    chapterMetaPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    "-map_metadata",
    String(tracks.length), // the ffmetadata input, for chapters
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  try {
    await execFileAsync("ffmpeg", args, { timeout: 30 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
  } finally {
    fs.unlinkSync(chapterMetaPath);
  }

  const totalDurationSeconds = Math.round(durations.reduce((a, b) => a + b, 0) / 1000);

  await db.transaction(async () => {
    for (const t of tracks) {
      await db.prepare("DELETE FROM tracks WHERE id = ?").run(t.id);
      try {
        fs.unlinkSync(t.filePath);
      } catch (err) {
        log.warn(`[audiobookConvert] couldn't remove source track ${t.filePath}:`, (err as Error).message);
      }
    }
    await db
      .prepare(
        `INSERT INTO tracks (sub_item_id, track_number, title, duration_seconds, has_file, file_path)
         VALUES (?, 1, ?, ?, 1, ?)`
      )
      .run(subItemId, subRow.title, totalDurationSeconds, outputPath);
  });

  return { path: outputPath };
}
