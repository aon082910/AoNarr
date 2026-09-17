import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import type { Request, Response } from "express";

export const CONTENT_TYPES: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
  ".ts": "video/mp2t",
  // Added for the OPDS download route (routes/opds.ts) — book/comic/audiobook formats, harmless to
  // share with the video-only IPTV stream route since extensions never collide with the above.
  ".epub": "application/epub+zip",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw3": "application/vnd.amazon.ebook",
  ".pdf": "application/pdf",
  ".cbz": "application/vnd.comicbook+zip",
  ".cbr": "application/vnd.comicbook-rar",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

/**
 * Serves a local file with HTTP Range support (206 Partial Content) — required for a media
 * server/player to seek within a stream instead of only ever playing from the start, the same way
 * any real video-serving endpoint needs to behave. Falls back to a plain 200 full-file response
 * when no Range header is sent (a first connection probe, or a client that doesn't seek).
 */
export function streamFileWithRangeSupport(req: Request, res: Response, filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.status(404).json({ error: "File not found on disk" });
    return;
  }

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;

  // stream.pipeline (not .pipe) so a client that aborts mid-stream — every seek a video player
  // makes — destroys the read stream and releases its file descriptor instead of leaking one
  // per request, and so a read error ends the response instead of surfacing as an unhandled
  // 'error' event.
  if (!range) {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
    pipeline(fs.createReadStream(filePath), res, () => {});
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match || (!match[1] && !match[2])) {
    res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
    return;
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    // Suffix range ("bytes=-500"): the LAST N bytes — MP4 moov atoms and MKV cues live there.
    const suffix = Math.min(Number(match[2]), stat.size);
    start = stat.size - suffix;
    end = stat.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  }
  if (start >= stat.size || start > end) {
    res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
    return;
  }

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
  });
  pipeline(fs.createReadStream(filePath, { start, end }), res, () => {});
}
