import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Bazarr-style subtitle timing sync: re-aligns a subtitle file's timestamps against the video's
 * own audio track using ffsubsync (voice-activity detection, entirely local — no external API).
 * Best-effort and never throws: on any failure the original subtitle file is left untouched,
 * since a mistimed-but-present subtitle beats none at all. Writes to a temp path first and only
 * replaces the original once ffsubsync has actually succeeded, so a crash/failure mid-run can't
 * leave a half-written or corrupt subtitle file in its place.
 */
export async function syncSubtitleToVideo(videoPath: string, subtitlePath: string): Promise<boolean> {
  const tmpPath = `${subtitlePath}.sync-tmp.srt`;
  try {
    await execFileAsync("ffsubsync", [videoPath, "-i", subtitlePath, "-o", tmpPath], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    fs.renameSync(tmpPath, subtitlePath);
    log.info(`[subtitleSync] synced timing for "${subtitlePath}"`);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmpPath never got created — nothing to clean up.
    }
    const stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.trim();
    log.warn(`[subtitleSync] sync failed for "${subtitlePath}", keeping the original:`, stderr || (err as Error).message);
    return false;
  }
}
