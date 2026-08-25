import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseStringPromise } from "xml2js";
import pdfParse from "pdf-parse";

export interface BookMatch {
  title: string;
  releaseDate: string | null;
  posterUrl: string | null;
  externalId: string;
  externalProvider: "openlibrary";
}

function isValidIsbn10(digits: string): boolean {
  if (digits.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    if (!/\d/.test(digits[i])) return false;
    sum += Number(digits[i]) * (10 - i);
  }
  const last = digits[9].toUpperCase();
  const lastVal = last === "X" ? 10 : Number(last);
  if (Number.isNaN(lastVal)) return false;
  sum += lastVal;
  return sum % 11 === 0;
}

function isValidIsbn13(digits: string): boolean {
  if (digits.length !== 13 || !/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

/** Converts an ISBN-10 to its ISBN-13 equivalent (978 prefix + recomputed check digit) — Open
 * Library's lookup accepts either, but normalizing to 13 keeps the returned id consistent
 * regardless of which one the book's own metadata happened to print. */
function isbn10To13(isbn10: string): string {
  const core = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

/**
 * Scans free text for the first plausible, checksum-valid ISBN — tries a labeled "ISBN ..."
 * occurrence first (most reliable, since a book's own copyright page nearly always prints the
 * label), then falls back to any bare 10/13-digit run that passes its checksum. Hyphens/spaces
 * within a candidate are tolerated (real ISBNs are almost always printed with them) and stripped
 * before validation.
 */
export function findIsbnInText(text: string): string | null {
  const labeled = text.match(/ISBN(?:-1[03])?\s*:?\s*([\dXx][\dXx\- ]{8,16}[\dXx])/gi);
  const candidates: string[] = [];
  if (labeled) {
    for (const m of labeled) {
      const digits = m.replace(/^ISBN(?:-1[03])?\s*:?\s*/i, "");
      candidates.push(digits);
    }
  }
  // Bare digit runs, whether or not a label was found nearby — plenty of scanned/OCR'd copyright
  // pages lose the "ISBN" label itself but keep the number.
  const bare = text.match(/\b(?:97[89][\d\- ]{10,17}|[\dXx][\dXx\- ]{8,16}[\dXx])\b/g);
  if (bare) candidates.push(...bare);

  for (const raw of candidates) {
    const cleaned = raw.replace(/[^\dXx]/g, "").toUpperCase();
    if (cleaned.length === 13 && isValidIsbn13(cleaned)) return cleaned;
    if (cleaned.length === 10 && isValidIsbn10(cleaned)) return isbn10To13(cleaned);
  }
  return null;
}

/** EPUB is a zip archive; its OPF manifest (found via META-INF/container.xml) carries the book's
 * metadata including a dc:identifier — nearly always an ISBN for anything with an ISBN at all, so
 * this needs no page-scanning heuristics the way PDF does. */
async function extractIsbnFromEpub(filePath: string): Promise<string | null> {
  const zip = new AdmZip(filePath);
  const containerEntry = zip.getEntry("META-INF/container.xml");
  if (!containerEntry) return null;
  const container = await parseStringPromise(containerEntry.getData().toString("utf-8"));
  const opfPath = container?.container?.rootfiles?.[0]?.rootfile?.[0]?.$?.["full-path"];
  if (!opfPath) return null;

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) return null;
  const opf = await parseStringPromise(opfEntry.getData().toString("utf-8"));
  const identifiers: any[] = opf?.package?.metadata?.[0]?.["dc:identifier"] ?? [];

  for (const id of identifiers) {
    const value = typeof id === "string" ? id : id._;
    if (!value) continue;
    const found = findIsbnInText(String(value));
    if (found) return found;
  }
  return null;
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
 * read (.mobi, .azw3 — no practical pure-JS parser for either) or when nothing is found. */
export async function extractIsbnFromBookFile(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".epub") return await extractIsbnFromEpub(filePath);
    if (ext === ".pdf") return await extractIsbnFromPdf(filePath);
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
