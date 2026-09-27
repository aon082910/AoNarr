import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import AdmZip from "adm-zip";
import { parseStringPromise } from "xml2js";
import { findIsbnInIdentifiers } from "./isbn.js";

/**
 * Title/author/ISBN read from inside an ebook file itself — for a book that has no folder or
 * sidecar to say who wrote it (a file loose in a library root). Every reader here is best-effort
 * and returns null rather than throwing on an unreadable, truncated or DRM'd file.
 */
export interface EmbeddedBookMetadata {
  title: string | null;
  author: string | null;
  isbn: string | null;
}

export interface EpubPackageMetadata {
  title: string | null;
  /** Every dc:creator in document order, with its role (EPUB 2 opf:role or an EPUB 3 refining
   * <meta property="role">) when one is declared. */
  creators: { name: string; role: string | null }[];
  identifiers: string[];
}

// A container.xml or OPF is a few KB; an entry that inflates far past that is not metadata.
const MAX_EPUB_XML_BYTES = 2 * 1024 * 1024;
// Record 0 (PalmDOC + MOBI + EXTH headers) sits right after the record list at the very start of
// the file — a real book's is well inside this, and the whole book never needs reading.
const MOBI_HEAD_BYTES = 1024 * 1024;
const MOBI_EXTENSIONS = new Set([".mobi", ".azw", ".azw3", ".prc"]);

const stripNamespace = (name: string) => name.replace(/^.*:/, "");

function parseXml(xml: string): Promise<any> {
  return parseStringPromise(xml, {
    explicitArray: true,
    mergeAttrs: true,
    tagNameProcessors: [stripNamespace],
    attrNameProcessors: [stripNamespace],
  });
}

function xmlText(value: unknown): string | null {
  if (Array.isArray(value)) return xmlText(value[0]);
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || null;
  if (value && typeof value === "object" && "_" in value) return xmlText((value as { _: unknown })._);
  return null;
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

// Windows-1252's printable characters in 0x80-0x9F (curly quotes, dashes, €, ™...), where Latin-1
// has invisible C1 controls. The five codes 1252 leaves undefined stay controls and are dropped by
// cleanText. A lookup rather than TextDecoder("windows-1252"), which a small-ICU Node build lacks.
const CP1252_HIGH =
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F" +
  "\u0090‘’“”•–—˜™š›œ\u009DžŸ";

function decodeCp1252(buf: Buffer, start: number, end: number): string {
  return buf.toString("latin1", start, end).replace(/[\u0080-\u009f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
}

// Download sites stamp their own URL or name into the Author/Title fields of the files they serve
// ("www.it-ebooks.info", "Amazon.com", "libgen.rs", "Scanned by ..."). Taken at face value, every
// book from one site landed under one "author" named after it, each titled after the site too, and
// all but the first were skipped as copies of it.
const SITE_STAMP = /:\/\/|\bwww\.|^(?:scanned|converted|uploaded|ripped|downloaded|shared|provided|brought to you)\s+(?:by|from|at|via)\b/i;
const SITE_NAME = /^(?:z-?lib(?:rary)?|lib\s?gen(?:esis)?|library genesis|anna['’]?s archive|pdf\s?drive)$/i;
// One token ending in a common top-level domain. Lowercase only, so "ASP.NET" stays a title.
const DOMAIN_NAME =
  /^[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*\.(?:com|net|org|info|biz|io|me|cc|co|to|ru|rs|su|se|is|li|lt|lv|ly|gs|ws|pw|tk|ml|ga|cf|gq|xyz|top|site|online|club|lol|store|shop|app|in|us|uk|de|fr|es|it|nl|eu|pl|cz|ro|ua|by|kz|cn|jp|kr|tw|hk|vn|id|br|ar|mx|ca|au|nz|za|onion)$/u;

function isSiteStamp(value: string): boolean {
  return SITE_STAMP.test(value) || SITE_NAME.test(value) || DOMAIN_NAME.test(value);
}

/** Calibre (and most converters) write "Unknown" into an untitled book's own metadata; audio
 * taggers write "Unknown Album"/"Untitled". */
function cleanBookTitle(raw: string | null | undefined): string | null {
  const value = cleanText(raw);
  if (!value || !/[\p{L}\p{N}]/u.test(value) || /^(?:unknown|untitled)(?:\s+(?:album|title|book|audiobook|track))?$/i.test(value)) return null;
  if (isSiteStamp(value)) return null;
  return value;
}

/** An embedded title (ebook metadata, an audio file's album/title tag) worth naming a book after. */
export const cleanEmbeddedTitle = cleanBookTitle;

const PLACEHOLDER_AUTHOR = /^(?:unknown(?:\s+(?:author|artist))?|various(?:\s+(?:authors|artists))?|n\/a|none)$/i;

// Lowercase words that open a surname ("Le Guin", "de Camp", "van Vogt", "St. John").
const SURNAME_PARTICLES = new Set([
  "le", "la", "les", "de", "del", "della", "der", "den", "des", "di", "da", "das", "do", "dos", "du",
  "van", "von", "ter", "ten", "st", "st.", "saint", "mac", "bin", "ibn", "al", "el",
]);
const NAME_SUFFIX = /^(?:jr|sr|[ivx]{1,4}|ph\.?\s?d|md|esq)\.?$/i;
const NAME_WORD = /^\p{L}[\p{L}'’-]*$/u;
const NAME_INITIALS = /^(?:\p{L}\.){1,4}$|^\p{Lu}$/u;

function looksLikeSurname(text: string): boolean {
  const words = text.split(/\s+/);
  if (!words.every((w) => NAME_WORD.test(w) || SURNAME_PARTICLES.has(w.toLowerCase()))) return false;
  return words.length === 1 || (words.length <= 4 && words.slice(0, -1).every((w) => SURNAME_PARTICLES.has(w.toLowerCase())));
}

function looksLikeGivenNames(text: string): boolean {
  const words = text.split(/\s+/);
  return words.length <= 3 && !NAME_SUFFIX.test(text) && words.every((w) => NAME_WORD.test(w) || NAME_INITIALS.test(w));
}

/**
 * A name with commas in it, as one display-order name. "King, Stephen" / "Le Guin, Ursula K." /
 * "Garcia Marquez, Gabriel" are a single sort-order name and come back inverted ("Stephen King") so
 * they match the same author filed under a folder or provider name; "Neil Gaiman, Terry Pratchett"
 * is a list of display-order names and comes back as its first. "Martin Luther King, Jr." keeps its
 * suffix. Anything else is kept whole.
 */
function commaNameToDisplay(value: string): string {
  const parts = value.split(/\s*,\s*/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? value;
  const [before, after] = parts;
  if (parts.length === 2 && NAME_SUFFIX.test(after)) return value;
  const beforeWords = before.split(/\s+/).length;
  const afterWords = after.split(/\s+/).length;
  // A lone given name after a two-word surname with no particle ("Garcia Marquez, Gabriel") is still
  // sort order; two display-order names are "First Last, First Last".
  if (looksLikeGivenNames(after) && (looksLikeSurname(before) || (afterWords === 1 && beforeWords === 2))) return `${after} ${before}`;
  if (beforeWords > 1 && (parts.length > 2 || afterWords > 1)) return before;
  return value;
}

/**
 * The first of possibly several credited authors ("A & B", "A; B", "A and B", "A/B", or
 * "First Last, First Last"), in display order (a sort-order "Last, First" is inverted, see
 * commaNameToDisplay), trimmed of a trailing role like "(Author)". Null for a placeholder
 * ("Unknown", "Various Artists") or anything with no letters in it.
 */
export function firstAuthor(raw: string | null | undefined): string | null {
  let value = cleanText(raw);
  if (!value) return null;
  value = value.split(/\s*(?:[&;/]|\band\b)\s*/i)[0] ?? "";
  value = value
    .replace(/\s*[([][^()[\]]*[)\]]\s*$/, "")
    .replace(/[\s,;:-]+$/, "")
    .replace(/^[\s.,;:!?_~*•·\-–—]+/, "")
    .trim();
  value = commaNameToDisplay(value);
  if (!/\p{L}/u.test(value) || PLACEHOLDER_AUTHOR.test(value)) return null;
  return value;
}

function readZipText(zip: AdmZip, entryName: string): string | null {
  const entry = zip.getEntry(entryName);
  if (!entry || entry.isDirectory || entry.header.size > MAX_EPUB_XML_BYTES) return null;
  return entry.getData().toString("utf-8");
}

/** An EPUB's own package document (the OPF that META-INF/container.xml points at). Throws on a
 * file that isn't a readable zip — callers wanting "never throws" use readBookFileMetadata. */
export async function readEpubPackage(filePath: string): Promise<EpubPackageMetadata | null> {
  const zip = new AdmZip(filePath);
  const containerXml = readZipText(zip, "META-INF/container.xml");
  if (!containerXml) return null;
  const container = await parseXml(containerXml);
  const opfPath = xmlText(container?.container?.rootfiles?.[0]?.rootfile?.[0]?.["full-path"]);
  if (!opfPath) return null;
  const opfXml = readZipText(zip, opfPath);
  if (!opfXml) return null;
  const opf = await parseXml(opfXml);
  const metadata = opf?.package?.metadata?.[0];
  if (!metadata || typeof metadata !== "object") return { title: null, creators: [], identifiers: [] };

  const roleById = new Map<string, string>();
  for (const meta of Array.isArray(metadata.meta) ? metadata.meta : []) {
    const refines = xmlText(meta?.refines);
    const role = xmlText(meta);
    if (xmlText(meta?.property) === "role" && refines && role) roleById.set(refines.replace(/^#/, ""), role.toLowerCase());
  }
  const creators: EpubPackageMetadata["creators"] = [];
  for (const entry of Array.isArray(metadata.creator) ? metadata.creator : []) {
    const name = xmlText(entry);
    if (!name) continue;
    const id = xmlText(entry?.id);
    const role = xmlText(entry?.role)?.toLowerCase() ?? (id ? roleById.get(id) : undefined) ?? null;
    creators.push({ name, role });
  }
  const identifiers = (Array.isArray(metadata.identifier) ? metadata.identifier : [])
    .map((entry: unknown) => xmlText(entry))
    .filter((value: string | null): value is string => !!value);

  return { title: xmlText(metadata.title), creators, identifiers };
}

/** The first creator credited as an author — an illustrator/editor/translator listed ahead of
 * them isn't who the book is filed under. Falls back to the creators with no role at all, then any
 * other; a placeholder/account-name creator ("Windows User") is passed over. */
function epubAuthor(creators: EpubPackageMetadata["creators"]): string | null {
  const ordered = [...creators.filter((c) => c.role === "aut"), ...creators.filter((c) => !c.role), ...creators.filter((c) => c.role && c.role !== "aut")];
  for (const creator of ordered) {
    const author = cleanEmbeddedAuthor(creator.name);
    if (author) return author;
  }
  return null;
}

/**
 * Title/author/ISBN from a MOBI/AZW/AZW3 file's headers: the PalmDB header's record list locates
 * record 0, whose MOBI header carries the book's full name and (when flagged) an EXTH block —
 * record 100 is an author, 503 the publisher's updated title, 104 an ISBN. Every read is
 * bounds-checked against `buf`, so a truncated or garbage buffer yields null or a partial result,
 * never a throw. `buf` only needs to hold the start of the file.
 */
export function parseMobiMetadata(buf: Buffer): EmbeddedBookMetadata | null {
  const u16 = (off: number) => (off >= 0 && off + 2 <= buf.length ? buf.readUInt16BE(off) : null);
  const u32 = (off: number) => (off >= 0 && off + 4 <= buf.length ? buf.readUInt32BE(off) : null);
  const ascii = (off: number, len: number) => (off >= 0 && off + len <= buf.length ? buf.toString("latin1", off, off + len) : null);

  if (buf.length < 78) return null;
  const typeCreator = ascii(60, 8);
  if (typeCreator !== "BOOKMOBI" && typeCreator !== "TEXtREAd") return null;
  // PalmDB names are single-byte, NUL-padded, capped at 31 characters and often use "_" for spaces.
  const palmName = cleanBookTitle(decodeCp1252(buf, 0, 32).split("\0")[0].replace(/_/g, " "));
  const fallback: EmbeddedBookMetadata = { title: palmName, author: null, isbn: null };

  const recordCount = u16(76);
  const record0 = u32(78);
  if (!recordCount || record0 == null) return fallback;
  const record1 = recordCount > 1 ? u32(86) : null;
  const record0End = record1 != null && record1 > record0 && record1 <= buf.length ? record1 : buf.length;

  const mobi = record0 + 16; // past the 16-byte PalmDOC header
  if (ascii(mobi, 4) !== "MOBI") return fallback;
  const headerLength = u32(mobi + 4);
  // 65001 is UTF-8; the only other encoding Mobipocket writes is 1252.
  const utf8 = u32(mobi + 12) === 65001;
  const decode = (start: number, end: number) =>
    start >= 0 && start < end && end <= record0End
      ? cleanText(utf8 ? buf.toString("utf8", start, end) : decodeCp1252(buf, start, end))
      : null;

  let fullName: string | null = null;
  const fullNameOffset = u32(mobi + 0x44);
  const fullNameLength = u32(mobi + 0x48);
  if (fullNameOffset != null && fullNameLength != null && fullNameLength > 0 && fullNameLength <= 4096) {
    fullName = cleanBookTitle(decode(record0 + fullNameOffset, record0 + fullNameOffset + fullNameLength));
  }

  let author: string | null = null;
  let updatedTitle: string | null = null;
  let isbn: string | null = null;
  const exthFlags = u32(mobi + 0x70);
  if (headerLength != null && headerLength >= 0x74 && exthFlags != null && exthFlags & 0x40) {
    const exth = mobi + headerLength;
    if (ascii(exth, 4) === "EXTH") {
      const exthLength = u32(exth + 4);
      const exthEnd = exthLength != null && exthLength >= 12 ? Math.min(record0End, exth + exthLength) : record0End;
      const count = u32(exth + 8) ?? 0;
      let p = exth + 12;
      for (let i = 0; i < count && i < 4096 && p + 8 <= exthEnd; i++) {
        const type = u32(p);
        const length = u32(p + 4);
        if (type == null || length == null || length < 8 || p + length > exthEnd) break;
        const value = decode(p + 8, p + length);
        if (type === 100 && !author) author = cleanEmbeddedAuthor(value);
        else if (type === 503 && value) updatedTitle = cleanBookTitle(value);
        else if (type === 104 && !isbn && value) isbn = findIsbnInIdentifiers([value]);
        p += length;
      }
    }
  }

  return { title: updatedTitle ?? fullName ?? palmName, author, isbn };
}

function readFileHead(filePath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, maxBytes));
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

const JUNK_AUTHOR_VALUES = new Set(["n/a", "none", "null", "-"]);
// What authoring software stamps into an Author field when nobody filled it in.
const SOFTWARE_AUTHOR =
  /^microsoft\b|^tex$|\b(?:adobe|acrobat|distiller|calibre|latex|pdftex|xetex|luatex|miktex|libreoffice|openoffice|ghostscript|wkhtmltopdf|abbyy|finereader|itext|pscript\d*|dvips|indesign|framemaker|quarkxpress|princexml|pdfcreator)\b/i;
// The words a computer's account name or owner field is made of when it was never set to a person:
// "Windows User", "Owner", "Administrator", "HP", "Dell Inc.", "Default", "Your Name".
const ACCOUNT_NAME_WORDS = new Set([
  "unknown", "admin", "administrator", "user", "users", "owner", "author", "default", "none", "anonymous", "guest", "test",
  "customer", "valued", "your", "my", "name", "home", "office", "system", "root", "local", "standard",
  "windows", "microsoft", "pc", "computer", "laptop", "desktop", "mac", "macintosh", "apple",
  "hp", "hewlett", "packard", "dell", "lenovo", "acer", "asus", "toshiba", "sony", "samsung", "compaq", "fujitsu", "gateway", "msi",
  "inc", "ltd", "llc", "corp", "corporation", "company",
]);

/** A default account/owner name rather than a person: every word is one of ACCOUNT_NAME_WORDS
 * ("Windows User", "HP", "Owner"), it mentions a user/customer ("Microsoft Office User", "Valued
 * Customer"), or it's a login ("admin1", "owner2", "jsmith42", "HP_Administrator"). */
function isAccountName(name: string): boolean {
  if (name.includes("_") || /^\p{L}+[.-]?\d+$/u.test(name)) return true;
  const withoutDigits = name.toLowerCase().replace(/\d+/g, " ");
  if (/\b(?:user|customer)s?\b/.test(withoutDigits)) return true;
  const words = withoutDigits.split(/[\s.,-]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => ACCOUNT_NAME_WORDS.has(w));
}

/** An embedded Author/creator field (PDF info, EPUB dc:creator, MOBI EXTH 100, an audio file's
 * artist tag) worth filing a book under, as its first author — null for an empty/placeholder value,
 * a default account or login name ("Windows User", which Word also writes into the ebooks it
 * exports), an email address, a download site's URL or name, or the name of the software that
 * produced the file. */
export function cleanEmbeddedAuthor(raw: unknown): string | null {
  const value = typeof raw === "string" ? cleanText(raw) : null;
  if (!value || !/\p{L}/u.test(value)) return null;
  if (JUNK_AUTHOR_VALUES.has(value.toLowerCase()) || SOFTWARE_AUTHOR.test(value)) return null;
  if (value.includes("@") || value.includes("\\") || value.includes("://")) return null;
  const first = firstAuthor(value);
  return first && !isAccountName(first) && !isSiteStamp(first) ? first : null;
}

export const cleanPdfAuthor = cleanEmbeddedAuthor;

// The placeholder/file-name titles authoring software fills in: "Microsoft Word - ch1.docx",
// "Microsoft PowerPoint - deck.pptx", "Presentation1", "Layout 1", "Slide 1", a bare file name.
const JUNK_PDF_TITLE = new RegExp(
  "^(?:untitled(?:\\s+document)?|document\\s*\\d*|title|unknown|" +
    "(?:layout|slide|page)\\s*\\d+|(?:powerpoint\\s+)?presentation\\s*\\d*|" +
    "microsoft\\s+(?:office\\s+)?(?:word|excel|powerpoint|publisher|visio|onenote|access|outlook)\\s*-.*|" +
    ".*\\.(?:docx?|dotx?|rtf|odt|ods|odp|tex|txt|html?|indd|qxd|pdf|ps|dvi|pptx?|ppsx?|xlsx?|xlsm|csv|key|pages|numbers|pub))$",
  "i"
);

/** A PDF Title field worth using — null for the placeholder/file-name values word processors fill in. */
export function cleanPdfTitle(raw: unknown): string | null {
  const value = typeof raw === "string" ? cleanBookTitle(raw) : null;
  if (!value || JUNK_PDF_TITLE.test(value)) return null;
  return value;
}

// adm-zip and pdf.js both hold the whole file in memory, and a scheduled scan reads every new loose
// book this way — a huge scanned PDF or illustrated EPUB is identified from its filename instead.
export const MAX_EMBEDDED_READ_BYTES: Record<string, number> = { ".epub": 200 * 1024 * 1024, ".pdf": 100 * 1024 * 1024 };
// pdf.js runs its parse to completion on whatever thread calls it, with no opportunity for a same-
// thread timer to preempt it — a same-thread Promise.race can only fire between event-loop turns, so
// it does nothing against a pathological/malicious PDF that keeps pdf.js in one long *synchronous*
// loop. Only another thread's forced termination can stop that, so the actual parse runs in a
// worker_thread (see pdfInfoWorker.ts) that gets killed outright if it overruns this timeout, instead
// of freezing the whole server for as long as pdf.js keeps running.
export const PDF_INFO_TIMEOUT_MS = 15_000;

type WorkerOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

// The worker script the PDF parse actually runs in. Resolved by extension so this finds
// pdfInfoWorker.ts directly under `tsx watch` (dev) as well as the pdfInfoWorker.js it becomes under
// dist/ (production build) — pdfInfoWorker.ts imports its own sibling with a "./bookFileMetadata.js"
// specifier exactly like every other file in this project, and only tsx's loader (or the real
// compiled dist/ layout) can resolve that back to a .ts file; plain `vitest run` cannot, so a worker
// spawned from a test would fail to load it. That's why bookFileMetadata.test.ts uses
// __setPdfInfoWorkerUrlForTests to point runInWorkerWithTimeout at small throwaway worker scripts
// instead of this one, rather than mocking pdf-parse across a real worker boundary.
let pdfInfoWorkerUrl: string | URL = new URL(`./pdfInfoWorker${path.extname(import.meta.url)}`, import.meta.url);

/** Test-only seam letting bookFileMetadata.test.ts redirect readPdfInfo's worker dispatch to a
 * throwaway script instead of the real pdf-parse-based one. Never called from production code. */
export function __setPdfInfoWorkerUrlForTests(url: string | URL): void {
  pdfInfoWorkerUrl = url;
}

/**
 * Runs `workerPath` as a real worker_thread with `workerData`, and forcibly terminates it — an
 * OS-level kill that a synchronous infinite loop cannot resist — if it hasn't posted a `{ok, ...}`
 * response within `timeoutMs`. Exported (rather than folded into readPdfInfo) so a test can point it
 * at a deliberately hanging worker script with a short timeout, to confirm termination actually
 * happens without waiting out the real production timeout.
 */
export function runInWorkerWithTimeout<T>(workerPath: string | URL, workerData: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Wait for terminate() itself to settle (it resolves once the worker thread has actually
      // stopped) before rejecting, so a caller never sees "timed out" while the killed worker's
      // busy loop is still tearing down in the background.
      worker.terminate().finally(() => reject(new Error(`timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (message: WorkerOutcome<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().finally(() => (message.ok ? resolve(message.result) : reject(new Error(message.error))));
    });
    worker.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`pdf info worker exited with code ${code} before responding`));
    });
  });
}

/** The PDF's document-info Author/Title from one cheap single-page parse, run in a worker_thread
 * (see PDF_INFO_TIMEOUT_MS above) so a pathological or malicious PDF can be killed outright instead
 * of freezing the whole server. */
export async function readPdfInfo(filePath: string): Promise<EmbeddedBookMetadata> {
  return runInWorkerWithTimeout<EmbeddedBookMetadata>(pdfInfoWorkerUrl, { filePath }, PDF_INFO_TIMEOUT_MS);
}

/** Embedded title/author/ISBN for an EPUB, MOBI/AZW/AZW3 or PDF — null for any other format, one
 * that can't be read, or an EPUB/PDF too large to load (see MAX_EMBEDDED_READ_BYTES). */
export async function readBookFileMetadata(filePath: string): Promise<EmbeddedBookMetadata | null> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const maxBytes = MAX_EMBEDDED_READ_BYTES[ext];
    if (maxBytes != null && fs.statSync(filePath).size > maxBytes) return null;
    if (ext === ".epub") {
      const pkg = await readEpubPackage(filePath);
      if (!pkg) return null;
      return { title: cleanBookTitle(pkg.title), author: epubAuthor(pkg.creators), isbn: findIsbnInIdentifiers(pkg.identifiers) };
    }
    if (MOBI_EXTENSIONS.has(ext)) return parseMobiMetadata(readFileHead(filePath, MOBI_HEAD_BYTES));
    if (ext === ".pdf") return await readPdfInfo(filePath);
  } catch {
    return null;
  }
  return null;
}

/** MOBI/AZW/AZW3 EXTH ISBN, for callers that only want the ISBN (bookIsbnScan). */
export function readMobiIsbn(filePath: string): string | null {
  return parseMobiMetadata(readFileHead(filePath, MOBI_HEAD_BYTES))?.isbn ?? null;
}

export function isMobiFile(filePath: string): boolean {
  return MOBI_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
