import { probeMediaInfo, type MediaInfo } from "./ffprobe.js";
import { getSetting } from "./settingsStore.js";
import { log } from "./logger.js";

/**
 * Sonarr's and Radarr's `EnableMediaInfo` ("Analyse video files"): an import or a scan reads a file's streams with ffprobe
 * unless the admin switched it off (a library on a slow share, where every probe is a read of the file's header across
 * the network). `enableMediaInfo` = "0" is off; anything else, and an install that never set it, is on as before.
 *
 * What goes quiet when it is off: the media info stored with a file (so the UI shows none), the sample and no-audio checks
 * of an automatic import (a sample is still told by its name), and the frame-size comparison that lets an unnamed
 * quality replace a lower one (the release name decides alone). A file is never refused or failed for want of the probe.
 *
 * It does not apply to what the admin asks for by name: the corrupt-media check, "Re-analyse" on the Media Analysis page,
 * the AI identify tool and the audiobook converter read the file because they are asked to, and still do.
 */

export function mediaInfoEnabled(): boolean {
  return getSetting("enableMediaInfo") !== "0";
}

let saidSo = false;

/**
 * The probe an import or a scan runs on a file: probeMediaInfo, or null without calling it when "Analyse video files" is
 * off. Says so once in the log, so a missing "Media info" on a file is not a mystery.
 */
export async function probeLibraryFile(filePath: string): Promise<MediaInfo | null> {
  if (!mediaInfoEnabled()) {
    if (!saidSo) {
      saidSo = true;
      log.info('[mediaInfo] "Analyse video files" is off: imports and scans do not read files with ffprobe (no media info is stored, the sample and no-audio checks are skipped)');
    }
    return null;
  }
  return probeMediaInfo(filePath);
}

/** Test-only: forget that the note was logged. */
export function __resetMediaInfoNoteForTests(): void {
  saidSo = false;
}
