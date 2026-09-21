import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseStringPromise } from "xml2js";

export interface ComicInfoResult {
  /** The series/collection-level title (ComicInfo.xml's <Series>) — distinct from `title`, which
   * is this one issue's own title, since a single ComicInfo.xml carries both at once (unlike
   * Kodi's split show/episode NFO files). */
  series: string | null;
  title: string | null;
  issueNumber: string | null;
  overview: string | null;
  year: number | null;
  genres: string[];
}

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) return firstText(value[0]);
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "_" in (value as any)) return firstText((value as any)._);
  return null;
}

/** Parses a ComicRack/Comictagger-convention ComicInfo.xml — the de facto standard sidecar for
 * comic/manga issue metadata, whether it sits next to the archive or (far more commonly) inside
 * it, see findComicInfoInCbz below. */
export async function parseComicInfoXml(xml: string): Promise<ComicInfoResult> {
  const parsed = await parseStringPromise(xml, { explicitArray: true, mergeAttrs: true });
  const root = parsed?.ComicInfo;
  if (!root) return { series: null, title: null, issueNumber: null, overview: null, year: null, genres: [] };

  const series = firstText(root.Series);
  const title = firstText(root.Title);
  const issueNumber = firstText(root.Number);
  const overview = firstText(root.Summary);
  const yearText = firstText(root.Year);
  const year = yearText ? parseInt(yearText, 10) : null;
  const genresText = firstText(root.Genre);
  const genres = genresText ? genresText.split(",").map((g) => g.trim()).filter(Boolean) : [];

  return { series, title, issueNumber, overview, year: year && !Number.isNaN(year) ? year : null, genres };
}

/** Case-insensitive entry match — real-world CBZs vary between "ComicInfo.xml" and lowercase, and
 * some tools nest it under a subfolder. Only .cbz is searched (matches comicImageConvert.ts's own
 * "CBR/RAR isn't supported" limitation — adm-zip can't read RAR); a .cbr's ComicInfo.xml, if any,
 * is only reachable via the external-sidecar-file fallback in sidecarMetadata.ts. Never throws —
 * a corrupt/unreadable archive or a CBZ with no ComicInfo.xml at all just means "no sidecar here",
 * the same as every other sidecar lookup in this codebase. */
export function findComicInfoInCbz(filePath: string): string | null {
  if (path.extname(filePath).toLowerCase() !== ".cbz" || !fs.existsSync(filePath)) return null;
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntries().find((e) => !e.isDirectory && path.basename(e.entryName).toLowerCase() === "comicinfo.xml");
    return entry ? entry.getData().toString("utf-8") : null;
  } catch {
    return null;
  }
}
