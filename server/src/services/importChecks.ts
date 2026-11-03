import fs from "node:fs";
import path from "node:path";
import { getSetting } from "./settingsStore.js";

/**
 * What an automatic import checks about the files themselves, after Sonarr's and Radarr's import specifications
 * (RejectedFileExtensionService, DetectSample, HasAudioTrackSpecification). A file that fails is left in the download
 * for a manual import, never placed in the library.
 */

/** Extensions of programs and scripts. A video release carries none; one that does is a trap (Sonarr's list, shortened). */
export const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".scr", ".bat", ".cmd", ".lnk", ".msi", ".msp", ".ps1", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".pif",
]);

/** Types whose downloads legitimately carry programs (a course's installers and project files, a channel's tools): the built-in rule skips them. */
const TYPES_WITH_PROGRAMS = new Set(["rom", "course", "adult", "video", "podcast"]);

/** `rejectedFileExtensions`: the admin's own extra list, "ass, nfo.exe" style separators ignored. */
export function userRejectedExtensions(): Set<string> {
  return new Set(
    (getSetting("rejectedFileExtensions") ?? "")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .map((e) => (e.startsWith(".") ? e : `.${e}`))
  );
}

/**
 * The first file in a download folder (two levels down) with a dangerous or listed extension, or null. Off with
 * `rejectDangerousFiles` = "0" (the built-in list; the admin's own list still applies), and never for ROM downloads,
 * where a DOS game is an .exe.
 */
export function findRejectedFile(dir: string, mediaType: string): string | null {
  const dangerous = getSetting("rejectDangerousFiles") !== "0" && !TYPES_WITH_PROGRAMS.has(mediaType);
  const listed = userRejectedExtensions();
  if (!dangerous && listed.size === 0) return null;
  const visit = (current: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) {
          const found = visit(full, depth + 1);
          if (found) return found;
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if ((dangerous && DANGEROUS_EXTENSIONS.has(ext)) || listed.has(ext)) return full;
    }
    return null;
  };
  return visit(dir, 0);
}

/** The shortest a real file can be for the runtime expected of it: a tenth of it, between 15 seconds and 10 minutes. */
export function minimumRuntimeSeconds(expectedMinutes: number | null | undefined): number {
  const expected = Number(expectedMinutes);
  if (!Number.isFinite(expected) || expected <= 0) return 60;
  return Math.min(600, Math.max(15, Math.round(expected * 6)));
}

export interface ProbedFile {
  durationSeconds: number | null;
  videoCodec: string | null;
  audioStreams?: unknown[] | null;
}

/**
 * Why a probed video file cannot be the release: far shorter than the title runs (a sample or a teaser under an
 * ordinary name), or no audio at all. Null when it looks right, and when nothing could be read (an unreadable file
 * is indeterminate, as in Sonarr). Off with `importProbeChecks` = "0".
 */
export function probeVerdict(info: ProbedFile | null, expectedMinutes: number | null | undefined): string | null {
  if (!info || getSetting("importProbeChecks") === "0") return null;
  // Only against a runtime the title is known to have: a short clip of a title with no runtime on record is not a sample.
  const expected = Number(expectedMinutes);
  if (expected > 0 && info.durationSeconds != null && info.durationSeconds > 0 && info.durationSeconds < minimumRuntimeSeconds(expectedMinutes)) {
    return `it runs only ${info.durationSeconds}s, too short for a real file (a sample?)`;
  }
  if (info.videoCodec && Array.isArray(info.audioStreams) && info.audioStreams.length === 0) return "it has no audio track";
  return null;
}
