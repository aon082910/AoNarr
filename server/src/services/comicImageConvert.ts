import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const IMAGE_EXT_RE = /\.(jpe?g|png|bmp|tiff?)$/i;

/** Maps a 1-100 "quality" setting to ffmpeg's mjpeg qscale (2 = best, 31 = worst) — there's no
 * standard "quality" knob for jpeg the way libwebp has one, so this is a reasonable linear map. */
function jpegQscale(quality: number): number {
  return Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
}

/**
 * Re-encodes every page image inside a CBZ in place, converting to WebP or re-compressed JPEG —
 * a real Kapowarr community ask (issue #143): comic archives are usually full-resolution
 * PNG/JPEG scans, and re-encoding to WebP typically shrinks a library substantially with no
 * visible quality loss at a reasonable quality setting. CBR (RAR) isn't supported — RAR is a
 * proprietary format AoNarr has no writer for, only unrar-style readers elsewhere in the
 * codebase, and rewriting a RAR archive isn't something the free tooling here can do.
 */
export async function convertComicImages(filePath: string, format: "webp" | "jpeg", quality: number): Promise<{ originalBytes: number; newBytes: number }> {
  if (path.extname(filePath).toLowerCase() !== ".cbz") {
    throw new Error("Only CBZ archives can be re-encoded (CBR/RAR isn't supported)");
  }
  const originalBytes = fs.statSync(filePath).size;

  const zip = new AdmZip(filePath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && IMAGE_EXT_RE.test(e.entryName));
  if (entries.length === 0) return { originalBytes, newBytes: originalBytes };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-comic-"));
  const outExt = format === "webp" ? ".webp" : ".jpg";
  try {
    for (const entry of entries) {
      const srcPath = path.join(tmpDir, "in" + path.extname(entry.entryName).toLowerCase());
      const outPath = path.join(tmpDir, "out" + outExt);
      fs.writeFileSync(srcPath, entry.getData());

      const args =
        format === "webp"
          ? ["-y", "-i", srcPath, "-quality", String(quality), outPath]
          : ["-y", "-i", srcPath, "-q:v", String(jpegQscale(quality)), outPath];
      await execFileAsync("ffmpeg", args, { timeout: 60_000 });

      const newBuf = fs.readFileSync(outPath);
      const newName = entry.entryName.replace(/\.[^./\\]+$/, outExt);
      zip.deleteFile(entry.entryName);
      zip.addFile(newName, newBuf);

      fs.unlinkSync(srcPath);
      fs.unlinkSync(outPath);
    }
    zip.writeZip(filePath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const newBytes = fs.statSync(filePath).size;
  return { originalBytes, newBytes };
}

/** Best-effort wrapper for the automatic post-import call site — a re-encode failing (a
 * corrupt page image, ffmpeg choking on an unusual format) should never fail the import itself,
 * just skip the size savings for that one file. */
export async function convertComicImagesBestEffort(filePath: string, format: "webp" | "jpeg", quality: number): Promise<void> {
  try {
    const { originalBytes, newBytes } = await convertComicImages(filePath, format, quality);
    const savedPct = originalBytes > 0 ? Math.round((1 - newBytes / originalBytes) * 100) : 0;
    log.info(`[comicImageConvert] re-encoded ${path.basename(filePath)} to ${format} — ${savedPct}% smaller`);
  } catch (err) {
    log.warn(`[comicImageConvert] failed to re-encode ${filePath}:`, (err as Error).message);
  }
}
