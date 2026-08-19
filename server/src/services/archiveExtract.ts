import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { config } from "../config.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Marker dropped next to an archive once it's been unpacked, so repeated import passes (every
 * queue poll) don't re-extract the same archive over and over. */
function markerPath(archivePath: string): string {
  return `${archivePath}.aonarr-extracted`;
}

function walkArchives(dir: string, depth = 0, maxDepth = 4): string[] {
  if (depth > maxDepth) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkArchives(full, depth + 1, maxDepth));
    } else if ([".zip", ".7z", ".rar"].includes(path.extname(entry.name).toLowerCase())) {
      if (!fs.existsSync(markerPath(full))) found.push(full);
    }
  }
  return found;
}

async function extractOne(archivePath: string): Promise<void> {
  const destDir = path.join(path.dirname(archivePath), path.basename(archivePath, path.extname(archivePath)));
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(archivePath).toLowerCase();

  if (ext === ".zip") {
    new AdmZip(archivePath).extractAllTo(destDir, true);
  } else if (ext === ".7z") {
    // Requires the `7z` binary on PATH — not bundled in the image by default. Skips quietly
    // (leaving the archive for manual handling) rather than failing the whole import pass.
    await execFileAsync("7z", ["x", `-o${destDir}`, "-y", archivePath]);
  } else if (ext === ".rar") {
    await execFileAsync("unrar", ["x", "-y", archivePath, `${destDir}/`]);
  }

  fs.writeFileSync(markerPath(archivePath), new Date().toISOString());
  log.info(`[archiveExtract] unpacked ${path.basename(archivePath)} -> ${destDir}`);
}

/** Best-effort: unpacks any not-yet-extracted .zip/.7z/.rar sitting under the downloads
 * directory, so the ordinary file-matching pass (which only looks at media file extensions) can
 * find what's inside. Never throws — a missing 7z/unrar binary or a corrupt archive just gets
 * logged and skipped, since most downloads aren't archives at all. */
export async function unpackDownloadedArchives(): Promise<void> {
  const archives = walkArchives(config.downloadsDir);
  for (const archivePath of archives) {
    try {
      await extractOne(archivePath);
    } catch (err) {
      log.warn(`[archiveExtract] failed to unpack "${archivePath}":`, (err as Error).message);
    }
  }
}
