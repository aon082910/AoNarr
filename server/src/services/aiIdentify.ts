import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db/index.js";
import { queryAi, type AiProviderConfig } from "./aiClient.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4a", ".ogg", ".wav", ".m4b"]);

async function getAiProviderConfig(providerId?: number | null): Promise<AiProviderConfig | null> {
  const row = providerId
    ? await db.prepare("SELECT * FROM ai_providers WHERE id = ? AND enabled = 1").get(providerId)
    : await db.prepare("SELECT * FROM ai_providers WHERE is_default = 1 AND enabled = 1 LIMIT 1").get();
  if (!row) return null;
  const r = row as any;
  return { type: r.type, baseUrl: r.base_url, apiKey: r.api_key, model: r.model };
}

async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
      { timeout: 15_000 }
    );
    const data = JSON.parse(stdout);
    const d = data.format?.duration ? Number(data.format.duration) : null;
    return d && Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Grabs one frame ~25% into the video (past any studio-logo bumper, well before end credits) as a
 * base64 PNG for a vision-capable AI model to look at. Returns null on any failure (no ffmpeg, an
 * unreadable/DRM'd file, an unsupported codec) — this is a best-effort fallback the caller falls
 * back further from, never something the rest of the import flow depends on.
 */
async function extractVideoFrameBase64(filePath: string): Promise<string | null> {
  const duration = await probeDurationSeconds(filePath);
  const seekSeconds = duration ? Math.max(5, Math.round(duration * 0.25)) : 60;
  const tmpFile = path.join(os.tmpdir(), `aonarr-ai-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await execFileAsync("ffmpeg", ["-ss", String(seekSeconds), "-i", filePath, "-frames:v", "1", "-q:v", "3", "-y", tmpFile], {
      timeout: 30_000,
    });
    return fs.readFileSync(tmpFile).toString("base64");
  } catch (err) {
    log.warn(`[aiIdentify] failed to extract a frame from "${filePath}":`, (err as Error).message);
    return null;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

/** Embedded ID3/Vorbis/etc. tags ffprobe can read off an audio file — as close as this
 * integration gets to "sampling the audio": general chat-completion AI providers have no way to
 * actually listen to a clip through this integration, so the file's own embedded metadata is the
 * real signal handed to the model, with the model's job being to make sense of/clean up what's
 * there rather than transcribe sound it was never given. */
async function extractAudioTags(filePath: string): Promise<Record<string, string> | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format_tags", "-of", "json", filePath],
      { timeout: 15_000 }
    );
    const data = JSON.parse(stdout);
    const tags = data.format?.tags;
    return tags && Object.keys(tags).length > 0 ? tags : null;
  } catch {
    return null;
  }
}

export interface AiIdentifyResult {
  guess: string;
  usedFrame: boolean;
  usedTags: boolean;
}

/**
 * AI-assisted identification for a file whose name alone wasn't enough to confidently match — a
 * video file gets a frame grabbed partway through and shown to a vision-capable model; an audio
 * file's own embedded tags (when present) are handed to the model as text context instead. Either
 * way the result is a suggestion for a human to read and act on in the normal search/pick flow,
 * never an automatic match on its own — this only ever returns a text guess, it doesn't touch the
 * database or the filesystem.
 */
export async function identifyMediaFile(filePath: string, mediaType: string, providerId?: number | null): Promise<AiIdentifyResult> {
  const cfg = await getAiProviderConfig(providerId);
  if (!cfg) throw new Error("No enabled AI provider is configured — add one in Settings → AI Providers first");

  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  if (VIDEO_EXTENSIONS.has(ext)) {
    const frame = await extractVideoFrameBase64(filePath);
    if (frame) {
      const prompt =
        `This is a single frame extracted from partway through a video file named "${fileName}". ` +
        `Based on what's visible (cast, setting, on-screen text/logos, subtitles), identify the movie ` +
        `or TV show it's most likely from. If it's a TV show, include the season/episode if you can tell. ` +
        `Reply in this exact short form and nothing else: "Title (Year)" or "Show Title SxxEyy" — or ` +
        `"Unknown" if you genuinely can't tell from a single frame.`;
      const reply = await queryAi(cfg, prompt, frame);
      return { guess: reply.trim(), usedFrame: true, usedTags: false };
    }
    // Falls through to the filename-only guess below when frame extraction itself failed.
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    const tags = await extractAudioTags(filePath);
    if (tags) {
      const tagLines = Object.entries(tags)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const prompt =
        `A music/audiobook file named "${fileName}" has this embedded metadata:\n${tagLines}\n\n` +
        `Based on this, what's the correct canonical title and artist/author? Reply in this exact ` +
        `short form and nothing else: "Title — Artist" — or "Unknown" if the metadata isn't enough to tell.`;
      const reply = await queryAi(cfg, prompt);
      return { guess: reply.trim(), usedFrame: false, usedTags: true };
    }
  }

  // Filename-only fallback for anything else (a video whose frame extraction failed, an audio file
  // with no embedded tags, or another file type entirely) — weaker evidence, but still potentially
  // useful for a garbled or foreign-language filename an admin can't parse by eye.
  const prompt =
    `A ${mediaType} file is named "${fileName}" — no other information is available. Based only on ` +
    `the filename, what movie/show/album/book do you think this is? Reply in this exact short form ` +
    `and nothing else: "Title (Year)" — or "Unknown" if the filename gives no real clue.`;
  const reply = await queryAi(cfg, prompt);
  return { guess: reply.trim(), usedFrame: false, usedTags: false };
}
