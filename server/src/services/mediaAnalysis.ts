import { db } from "../db/index.js";
import { probeMediaInfo, type MediaInfo } from "./ffprobe.js";
import { log } from "./logger.js";

export interface CompatibilityNote {
  level: "ok" | "caution" | "incompatible";
  message: string;
}

const VIDEO_CODEC_NOTES: Record<string, CompatibilityNote> = {
  h264: { level: "ok", message: "H.264/AVC — decodes on essentially everything, hardware-accelerated on all modern devices." },
  hevc: {
    level: "ok",
    message: "HEVC/H.265 — supported by most TVs, streaming boxes, and phones from 2016 onward; some older Chromecasts and browsers (older Firefox) need transcoding.",
  },
  av1: {
    level: "caution",
    message: "AV1 — only decodes natively on fairly recent hardware (2020+ TVs, Chromecast with Google TV, current browsers); older devices will need transcoding.",
  },
  vp9: {
    level: "caution",
    message: "VP9 — well supported on Chromecast/Android TV/most browsers, but not natively on Apple devices (iPhone/iPad/Apple TV) without transcoding.",
  },
  mpeg2video: { level: "caution", message: "MPEG-2 — legacy codec, plays fine in software but rarely hardware-decoded on modern streaming boxes." },
  mpeg4: { level: "caution", message: "MPEG-4 Part 2 (Xvid/DivX) — legacy codec, software decode only on most modern players." },
  vc1: { level: "caution", message: "VC-1 — legacy Blu-ray codec, limited hardware decode support outside dedicated Blu-ray players." },
  wmv3: { level: "caution", message: "WMV — legacy Windows Media codec, narrow player support outside Windows itself." },
};

const AUDIO_CODEC_NOTES: Record<string, CompatibilityNote> = {
  aac: { level: "ok", message: "AAC — universally supported, decodes in software on virtually every device." },
  ac3: { level: "ok", message: "Dolby Digital (AC-3) — universally supported for stereo/5.1 audio." },
  mp3: { level: "ok", message: "MP3 — universally supported." },
  eac3: {
    level: "ok",
    message: "Dolby Digital Plus (E-AC-3) — widely supported; if the track carries Atmos metadata, a Dolby Atmos–capable receiver/soundbar is needed for object-based audio, otherwise it plays back as ordinary 5.1/7.1.",
  },
  truehd: {
    level: "caution",
    message: "Dolby TrueHD (often carrying Atmos) — needs an HDMI passthrough–capable AVR/soundbar; many TV apps and built-in speakers can't decode it directly.",
  },
  dts: { level: "caution", message: "DTS — needs a DTS-licensed device or AVR for passthrough; not every budget soundbar/smart TV supports it." },
  "dts-hd": { level: "caution", message: "DTS-HD — needs a DTS-HD-capable AVR for passthrough; falls back to core DTS or requires transcoding otherwise." },
  dts_hd: { level: "caution", message: "DTS-HD — needs a DTS-HD-capable AVR for passthrough; falls back to core DTS or requires transcoding otherwise." },
  opus: { level: "caution", message: "Opus — good software support (VLC, most modern apps) but rarely hardware-decoded by smart TV apps or older AVRs." },
  flac: { level: "caution", message: "FLAC — good software support but rarely hardware-decoded; fine for music, less common for video containers." },
  vorbis: { level: "caution", message: "Vorbis — decent software support but rarely hardware-decoded on TV/AVR hardware." },
};

const IMAGE_SUBTITLE_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"]);

/** Rule-based guidance, not a guaranteed compatibility check for any specific device — real-world
 * hardware/firmware varies too much for that. Flags the well-known, broadly-true gotchas (codecs
 * that need transcoding on older hardware, HDR formats without a fallback layer, audio that needs
 * AVR passthrough, image-based subtitles that can't be resized/styled) so a library owner can spot
 * likely playback friction before it shows up as a support request. */
export function analyzeCompatibility(info: MediaInfo): CompatibilityNote[] {
  const notes: CompatibilityNote[] = [];

  if (info.videoCodec) {
    const note = VIDEO_CODEC_NOTES[info.videoCodec.toLowerCase()];
    notes.push(note ?? { level: "caution", message: `Uncommon video codec "${info.videoCodec}" — verify your player supports it before assuming direct play.` });
  }

  if (info.hdrFormat === "dolby-vision") {
    notes.push({
      level: "caution",
      message: "Single-layer Dolby Vision (Profile 5) has no HDR10 fallback — a non-Dolby-Vision display may show washed-out color or fail to play HDR at all.",
    });
  } else if (info.hdrFormat === "dolby-vision-hdr10") {
    notes.push({ level: "ok", message: "Dual-layer Dolby Vision — includes an HDR10-compatible base layer, so non-DV displays still get HDR10." });
  } else if (info.hdrFormat === "hdr10plus") {
    notes.push({
      level: "caution",
      message: "HDR10+ — needs a compatible display (Samsung, Panasonic, and a few others) for dynamic metadata; falls back to the static HDR10 base layer everywhere else.",
    });
  } else if (info.hdrFormat === "hdr10") {
    notes.push({ level: "ok", message: "HDR10 — the most widely supported HDR format across modern TVs and streaming devices." });
  } else if (info.hdrFormat === "hlg") {
    notes.push({ level: "ok", message: "HLG — broadcast-friendly HDR format, backward-compatible with SDR displays." });
  }

  if (info.bitDepth && info.bitDepth >= 10) {
    notes.push({
      level: "caution",
      message: `${info.bitDepth}-bit color — needs Main10/High10 profile decode support; most modern hardware handles this fine, but some older or budget devices are 8-bit-only.`,
    });
  }

  for (const audio of info.audioStreams) {
    if (!audio.codec) continue;
    const note = AUDIO_CODEC_NOTES[audio.codec.toLowerCase()];
    if (note && !notes.some((n) => n.message === note.message)) notes.push(note);
    else if (!note && !notes.some((n) => n.message.includes(audio.codec!))) {
      notes.push({ level: "caution", message: `Uncommon audio codec "${audio.codec}" — verify your player/receiver supports it.` });
    }
  }

  if (info.subtitleStreams.some((s) => s.codec && IMAGE_SUBTITLE_CODECS.has(s.codec))) {
    notes.push({
      level: "caution",
      message: "Image-based subtitles (PGS/VobSub/DVB) — can't be resized, restyled, or searched by most players; either burn them in or use a player with image-subtitle support.",
    });
  }

  return notes;
}

export interface AnalysisSummary {
  totalFiles: number;
  filesWithoutMediaInfo: number;
  byVideoCodec: Record<string, number>;
  byHdrFormat: Record<string, number>;
  byAudioCodec: Record<string, number>;
  byResolution: Record<string, number>;
  subtitleLanguages: Record<string, number>;
}

export interface AnalysisItem {
  id: number;
  table: "media_items" | "episodes" | "sub_items";
  mediaItemId: number;
  title: string;
  type: string;
  path: string;
  mediaInfo: MediaInfo;
  compatibilityNotes: CompatibilityNote[];
}

interface ProbedRow {
  id: number;
  table: "media_items" | "episodes" | "sub_items";
  mediaItemId: number;
  title: string;
  type: string;
  path: string;
  mediaInfoJson: string | null;
}

function resolutionLabel(info: MediaInfo): string {
  if (!info.width || !info.height) return "unknown";
  return `${info.width}x${info.height}`;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

const ITEM_CAP = 2000;

/** Reads whatever media_info is already stored — doesn't probe anything itself, so this is
 * instant even for a large library. Files imported before this feature shipped only have the
 * narrower pre-HDR/Dolby-Vision MediaInfo shape; runLibraryAnalysis() (below) re-probes those. */
export async function getLibraryAnalysis(
  type?: string
): Promise<{ summary: AnalysisSummary; items: AnalysisItem[]; truncated: boolean }> {
  const rows: ProbedRow[] = [];

  const singleWhere = type ? "WHERE has_file = 1 AND path IS NOT NULL AND type = ?" : "WHERE has_file = 1 AND path IS NOT NULL";
  rows.push(
    ...((await db.prepare(`SELECT id, title, type, path, media_info FROM media_items ${singleWhere}`).all(...(type ? [type] : []))) as any[]).map(
      (r): ProbedRow => ({ id: r.id, table: "media_items", mediaItemId: r.id, title: r.title, type: r.type, path: r.path, mediaInfoJson: r.media_info })
    )
  );

  const epWhere = type ? "WHERE e.has_file = 1 AND e.file_path IS NOT NULL AND m.type = ?" : "WHERE e.has_file = 1 AND e.file_path IS NOT NULL";
  rows.push(
    ...(
      (await db
        .prepare(
          `SELECT e.id, e.title AS ep_title, e.file_path, e.media_info, e.media_item_id, m.title AS parent_title, m.type
           FROM episodes e JOIN media_items m ON m.id = e.media_item_id ${epWhere}`
        )
        .all(...(type ? [type] : []))) as any[]
    ).map(
      (r): ProbedRow => ({
        id: r.id,
        table: "episodes",
        mediaItemId: r.media_item_id,
        title: `${r.parent_title} — ${r.ep_title ?? "episode"}`,
        type: r.type,
        path: r.file_path,
        mediaInfoJson: r.media_info,
      })
    )
  );

  const subWhere = type ? "WHERE s.has_file = 1 AND s.file_path IS NOT NULL AND m.type = ?" : "WHERE s.has_file = 1 AND s.file_path IS NOT NULL";
  rows.push(
    ...(
      (await db
        .prepare(
          `SELECT s.id, s.title AS sub_title, s.file_path, s.media_info, s.media_item_id, m.title AS parent_title, m.type
           FROM sub_items s JOIN media_items m ON m.id = s.media_item_id ${subWhere}`
        )
        .all(...(type ? [type] : []))) as any[]
    ).map(
      (r): ProbedRow => ({
        id: r.id,
        table: "sub_items",
        mediaItemId: r.media_item_id,
        title: `${r.parent_title} — ${r.sub_title}`,
        type: r.type,
        path: r.file_path,
        mediaInfoJson: r.media_info,
      })
    )
  );

  const summary: AnalysisSummary = {
    totalFiles: rows.length,
    filesWithoutMediaInfo: 0,
    byVideoCodec: {},
    byHdrFormat: {},
    byAudioCodec: {},
    byResolution: {},
    subtitleLanguages: {},
  };
  const items: AnalysisItem[] = [];

  for (const row of rows) {
    if (!row.mediaInfoJson) {
      summary.filesWithoutMediaInfo++;
      continue;
    }
    let info: MediaInfo;
    try {
      info = JSON.parse(row.mediaInfoJson);
    } catch {
      summary.filesWithoutMediaInfo++;
      continue;
    }
    // Pre-Round-60 rows have the narrower MediaInfo shape (no audioStreams/subtitleStreams/
    // hdrFormat at all) — treat those the same as "not yet analyzed" rather than crashing on them.
    if (!Array.isArray(info.audioStreams) || !info.hdrFormat) {
      summary.filesWithoutMediaInfo++;
      continue;
    }

    bump(summary.byVideoCodec, info.videoCodec ?? "unknown");
    bump(summary.byHdrFormat, info.hdrFormat);
    bump(summary.byResolution, resolutionLabel(info));
    for (const a of info.audioStreams) bump(summary.byAudioCodec, a.codec ?? "unknown");
    for (const s of info.subtitleStreams) if (s.language) bump(summary.subtitleLanguages, s.language);

    if (items.length < ITEM_CAP) {
      items.push({
        id: row.id,
        table: row.table,
        mediaItemId: row.mediaItemId,
        title: row.title,
        type: row.type,
        path: row.path,
        mediaInfo: info,
        compatibilityNotes: analyzeCompatibility(info),
      });
    }
  }

  return { summary, items, truncated: items.length < rows.length - summary.filesWithoutMediaInfo };
}

export interface RunAnalysisResult {
  probed: number;
  failed: number;
}

/** Re-probes every file of a type (or every type) with the current, full-featured ffprobe wrapper
 * and updates the stored media_info — needed for anything imported before HDR/Dolby-Vision/
 * multi-track audio-subtitle capture existed, or files probed under an older AoNarr version.
 * Read-only with respect to the media files themselves (ffprobe never modifies what it inspects);
 * the only writes are to AoNarr's own media_info column. */
export async function runLibraryAnalysis(type?: string, signal?: AbortSignal): Promise<RunAnalysisResult> {
  let probed = 0;
  let failed = 0;

  const singleWhere = type ? "WHERE has_file = 1 AND path IS NOT NULL AND type = ?" : "WHERE has_file = 1 AND path IS NOT NULL";
  const singleRows = (await db.prepare(`SELECT id, path FROM media_items ${singleWhere}`).all(...(type ? [type] : []))) as {
    id: number;
    path: string;
  }[];
  for (const row of singleRows) {
    if (signal?.aborted) return { probed, failed };
    const info = await probeMediaInfo(row.path);
    if (!info) {
      failed++;
      continue;
    }
    await db.prepare("UPDATE media_items SET media_info = ? WHERE id = ?").run(JSON.stringify(info), row.id);
    probed++;
  }

  const epWhere = type ? "WHERE e.has_file = 1 AND e.file_path IS NOT NULL AND m.type = ?" : "WHERE e.has_file = 1 AND e.file_path IS NOT NULL";
  const epRows = (await db
    .prepare(`SELECT e.id, e.file_path FROM episodes e JOIN media_items m ON m.id = e.media_item_id ${epWhere}`)
    .all(...(type ? [type] : []))) as { id: number; file_path: string }[];
  for (const row of epRows) {
    if (signal?.aborted) return { probed, failed };
    const info = await probeMediaInfo(row.file_path);
    if (!info) {
      failed++;
      continue;
    }
    await db.prepare("UPDATE episodes SET media_info = ? WHERE id = ?").run(JSON.stringify(info), row.id);
    probed++;
  }

  const subWhere = type ? "WHERE s.has_file = 1 AND s.file_path IS NOT NULL AND m.type = ?" : "WHERE s.has_file = 1 AND s.file_path IS NOT NULL";
  const subRows = (await db
    .prepare(`SELECT s.id, s.file_path FROM sub_items s JOIN media_items m ON m.id = s.media_item_id ${subWhere}`)
    .all(...(type ? [type] : []))) as { id: number; file_path: string }[];
  for (const row of subRows) {
    if (signal?.aborted) return { probed, failed };
    const info = await probeMediaInfo(row.file_path);
    if (!info) {
      failed++;
      continue;
    }
    await db.prepare("UPDATE sub_items SET media_info = ? WHERE id = ?").run(JSON.stringify(info), row.id);
    probed++;
  }

  log.info(`[mediaAnalysis] analyzed ${type ?? "all libraries"}: ${probed} probed, ${failed} failed`);
  return { probed, failed };
}
