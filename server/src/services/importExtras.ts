import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getSetting } from "./settingsStore.js";

/**
 * Subtitles (and, if listed, other files) that came with a release go next to the imported file, named for it, when
 * `importExtraFiles` is "1" (Sonarr's ImportExtraFiles; `importExtraFileExtensions`, default "srt"). Off, they are
 * thrown away with the release folder, as before: a subtitle provider is the only source.
 */

export function importExtraFilesEnabled(): boolean {
  return getSetting("importExtraFiles") === "1";
}

export function extraFileExtensions(): Set<string> {
  const listed = (getSetting("importExtraFileExtensions") ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
  return new Set(listed.length > 0 ? listed : [".srt"]);
}

const SUBTITLE_FOLDERS = new Set(["subs", "sub", "subtitles", "subtitle"]);
const VIDEO_FILE = /\.(mkv|mp4|avi|mov|wmv|m4v|webm)$/i;

/** "2_English" -> "English", "en-forced.hi" kept: the part of a file name that says which subtitle it is. */
function subtitleLabel(stem: string): string {
  const cleaned = stem.replace(/^\d+[\s._-]+/, "").replace(/[^\w.\- ]+/g, "").trim();
  return cleaned || "und";
}

/**
 * Copies the extras of the release `sourceFile` came in to sit beside `destFile`:
 * - files named for the video ("Movie.2019.1080p.en.srt" beside "Movie.2019.1080p.mkv") keep their language tags;
 * - when the video is the only one in its folder, the files of a "Subs" folder are named "<video>.<label>.srt".
 * A file that would overwrite another is skipped. Returns what was copied. Never throws for one bad file.
 */
export async function copyReleaseExtras(sourceFile: string, destFile: string): Promise<string[]> {
  if (!importExtraFilesEnabled()) return [];
  const extensions = extraFileExtensions();
  const sourceDir = path.dirname(sourceFile);
  const sourceBase = path.basename(sourceFile, path.extname(sourceFile));
  const destBase = destFile.slice(0, destFile.length - path.extname(destFile).length);
  const copied: string[] = [];

  const copy = async (from: string, suffix: string): Promise<void> => {
    const target = `${destBase}${suffix}`;
    try {
      await fsp.copyFile(from, target, fs.constants.COPYFILE_EXCL);
      copied.push(target);
    } catch {
      // already there, or unreadable: the extra is a nicety
    }
  };

  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return copied;
  }
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.startsWith(`${sourceBase}.`)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (extensions.has(ext) && entry.name !== path.basename(sourceFile)) {
      await copy(path.join(sourceDir, entry.name), entry.name.slice(sourceBase.length));
    }
  }

  const videos = names.filter((e) => e.isFile() && VIDEO_FILE.test(e.name));
  const only = videos.length <= 1;
  if (only) {
    for (const folder of names.filter((e) => e.isDirectory() && SUBTITLE_FOLDERS.has(e.name.toLowerCase()))) {
      const used = new Set<string>();
      for (const file of fs.readdirSync(path.join(sourceDir, folder.name), { withFileTypes: true })) {
        const ext = path.extname(file.name).toLowerCase();
        if (!file.isFile() || !extensions.has(ext)) continue;
        let label = subtitleLabel(path.basename(file.name, ext));
        for (let n = 2; used.has(label.toLowerCase()); n++) label = `${subtitleLabel(path.basename(file.name, ext))}.${n}`;
        used.add(label.toLowerCase());
        await copy(path.join(sourceDir, folder.name, file.name), `.${label}${ext}`);
      }
    }
  }
  return copied;
}
