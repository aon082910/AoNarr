import path from "node:path";
import { db } from "../db/index.js";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { downloadSubtitleForLanguage } from "./importer.js";
import { log } from "./logger.js";

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"]);

/**
 * Bazarr's other real advantage AoNarr otherwise lacked: subtitles were previously only ever
 * fetched once, at import time — a provider added later, a language added to an existing
 * provider, or a transient search failure meant that file just never got a subtitle. This
 * re-checks every downloaded video (single-shape: movies/ROMs/adult; episodic: series/anime —
 * the same scope tryDownloadSubtitle already covers at import time) against every configured
 * language and fetches whatever's still missing. Idempotent by design (downloadSubtitleForLanguage's
 * `skipExisting`) — safe to run on a schedule against the whole library without re-fetching
 * anything already on disk.
 */
export async function rescanMissingSubtitles(): Promise<void> {
  const provider = (await db.prepare("SELECT * FROM subtitle_providers WHERE enabled = 1 LIMIT 1").get()) as
    | { type: string; api_key: string | null; languages: string; config: string | null }
    | undefined;
  if (!provider) return;
  if (provider.type !== "custom" && !provider.api_key) return;

  const languages = provider.languages
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  if (languages.length === 0) return;

  let downloaded = 0;

  const singleItems = (await db.prepare("SELECT id, type, path FROM media_items WHERE has_file = 1 AND path IS NOT NULL").all()) as {
    id: number;
    type: string;
    path: string;
  }[];
  for (const item of singleItems) {
    if (getMediaTypeConfig(item.type).shape !== "single") continue;
    if (!VIDEO_EXTENSIONS.has(path.extname(item.path).toLowerCase())) continue;
    for (const language of languages) {
      try {
        if (await downloadSubtitleForLanguage(item.path, item.id, language, provider, true)) downloaded++;
      } catch (err) {
        log.warn(`[subtitleRescan] "${language}" failed for media item ${item.id}:`, (err as Error).message);
      }
    }
  }

  const episodes = (await db.prepare("SELECT id, media_item_id, file_path FROM episodes WHERE has_file = 1 AND file_path IS NOT NULL").all()) as {
    id: number;
    media_item_id: number;
    file_path: string;
  }[];
  for (const ep of episodes) {
    if (!VIDEO_EXTENSIONS.has(path.extname(ep.file_path).toLowerCase())) continue;
    for (const language of languages) {
      try {
        if (await downloadSubtitleForLanguage(ep.file_path, ep.media_item_id, language, provider, true)) downloaded++;
      } catch (err) {
        log.warn(`[subtitleRescan] "${language}" failed for episode ${ep.id}:`, (err as Error).message);
      }
    }
  }

  if (downloaded > 0) log.info(`[subtitleRescan] downloaded ${downloaded} missing subtitle(s)`);
}
