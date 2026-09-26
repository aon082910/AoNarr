import fs from "node:fs";
import path from "node:path";
import pdfParse from "pdf-parse";
import { findIsbnInText, findIsbnInIdentifiers } from "./isbn.js";
import { isMobiFile, readEpubPackage, readMobiIsbn } from "./bookFileMetadata.js";

export { findIsbnInText };

export interface BookMatch {
  title: string;
  releaseDate: string | null;
  posterUrl: string | null;
  externalId: string;
  externalProvider: "openlibrary";
}

/** EPUB is a zip archive; its OPF manifest (found via META-INF/container.xml) carries the book's
 * metadata including a dc:identifier — nearly always an ISBN for anything with an ISBN at all, so
 * this needs no page-scanning heuristics the way PDF does. */
async function extractIsbnFromEpub(filePath: string): Promise<string | null> {
  const pkg = await readEpubPackage(filePath);
  return pkg ? findIsbnInIdentifiers(pkg.identifiers) : null;
}

/**
 * Scans only the first and last 15 pages of a PDF's text layer, per the admin's original request
 * (a book's ISBN is always on the copyright page near the front, occasionally repeated on a back
 * page) — reading the whole book would work too but costs far more time on a long book for no
 * extra reliability. A scanned-image-only PDF with no text layer at all yields nothing here (no
 * OCR is attempted); the caller treats that the same as "not found."
 */
async function extractIsbnFromPdf(filePath: string): Promise<string | null> {
  const dataBuffer = fs.readFileSync(filePath);

  // Cheap first pass just to learn the page count — needed to know which pages count as "last 15"
  // before doing the real (targeted) extraction pass below.
  const probe = await pdfParse(dataBuffer, { max: 1 });
  const totalPages: number = probe.numpages ?? 0;
  if (totalPages === 0) return null;

  const lastPagesStart = Math.max(0, totalPages - 15);
  const collected: string[] = [];
  await pdfParse(dataBuffer, {
    pagerender: (pageData: any) => {
      const pageIndex: number = pageData.pageIndex ?? 0;
      const inRange = pageIndex < 15 || pageIndex >= lastPagesStart;
      if (!inRange) return Promise.resolve("");
      return pageData.getTextContent().then((textContent: any) => {
        const text = textContent.items.map((item: any) => item.str).join(" ");
        collected.push(text);
        return text;
      });
    },
  });

  return findIsbnInText(collected.join("\n"));
}

/** Dispatches by extension; returns null (never throws) for a format this doesn't know how to
 * read or when nothing is found. MOBI/AZW/AZW3 carry their ISBN in an EXTH header record. */
export async function extractIsbnFromBookFile(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".epub") return await extractIsbnFromEpub(filePath);
    if (ext === ".pdf") return await extractIsbnFromPdf(filePath);
    if (isMobiFile(filePath)) return readMobiIsbn(filePath);
    return null;
  } catch {
    return null;
  }
}

/** Open Library's dedicated ISBN lookup — a direct key-value fetch, not a fuzzy search, so a
 * checksum-valid ISBN match from it is trustworthy enough to apply without a confirmation step
 * (the same trust level a moviehash match gets in the subtitle picker). No API key needed. */
export async function fetchBookByIsbn(isbn: string): Promise<BookMatch | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open Library ISBN lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();
  const entry = body?.[`ISBN:${isbn}`];
  if (!entry) return null;

  return {
    title: entry.title,
    releaseDate: entry.publish_date ?? null,
    posterUrl: entry.cover?.medium ?? entry.cover?.large ?? null,
    externalId: isbn,
    externalProvider: "openlibrary",
  };
}
