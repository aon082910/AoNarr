import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import { setupTestDb } from "./helpers/testDb.js";
import { buildMobi, writeEpub } from "./helpers/bookFixtures.js";
import { __setPdfInfoWorkerUrlForTests, cleanPdfAuthor, cleanPdfTitle } from "../src/services/bookFileMetadata.js";

const probeMediaInfo = vi.fn();
const probeAudioTags = vi.fn();
vi.mock("../src/services/ffprobe.js", () => ({
  probeMediaInfo: (...args: unknown[]) => probeMediaInfo(...args),
  probeAudioTags: (...args: unknown[]) => probeAudioTags(...args),
}));

// readBookFileMetadata's .pdf branch now runs the real pdf-parse call inside a real worker_thread
// (see bookFileMetadata.ts's readPdfInfo/runInWorkerWithTimeout and pdfInfoWorker.ts) rather than on
// this thread, so a `vi.mock("pdf-parse")` registered here can no longer reach it — a worker_thread
// loads its own separate module registry. The PDF-related tests below use
// __setPdfInfoWorkerUrlForTests (the same seam bookFileMetadata.test.ts's "via a real worker_thread"
// tests use) to point that dispatch at small throwaway worker scripts instead, written by the
// helpers declared further down (after tmpRoot exists).

const searchMetadata = vi.fn();
const fetchByExternalId = vi.fn();
const fetchSeriesEpisodesFor = vi.fn();
const fetchSeriesEpisodesForProvider = vi.fn();
const fetchSeriesSeasonsFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
const fetchCollectionChildrenFor = vi.fn();
const fetchMovieByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    isEpisodeMonitoredByDefault: actual.isEpisodeMonitoredByDefault,
    upcomingEpisodes: actual.upcomingEpisodes,
    proxyScreenscraperArtwork: actual.proxyScreenscraperArtwork,
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
    fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchSeriesEpisodesForProvider: (...args: unknown[]) => fetchSeriesEpisodesForProvider(...args),
    fetchSeriesSeasonsFor: (...args: unknown[]) => fetchSeriesSeasonsFor(...args),
    fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
    fetchCollectionChildrenFor: (...args: unknown[]) => fetchCollectionChildrenFor(...args),
    fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
  };
});

type LibraryScan = typeof import("../src/services/libraryScan.js");
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scanAndImportLibrary: LibraryScan["scanAndImportLibrary"];
let scanAndImportOneMediaItem: LibraryScan["scanAndImportOneMediaItem"];
let refreshOneMediaItem: LibraryScan["refreshOneMediaItem"];
let refreshLibraryMetadata: LibraryScan["refreshLibraryMetadata"];
let matchAdditionalProviders: LibraryScan["matchAdditionalProviders"];
let matchProvidersForLibrary: LibraryScan["matchProvidersForLibrary"];
let splitAuthorTitleFilename: LibraryScan["splitAuthorTitleFilename"];
let guessComicSeriesFromFilename: LibraryScan["guessComicSeriesFromFilename"];
let isPlaceholderParent: (typeof import("../src/services/mediaTypes.js"))["isPlaceholderParent"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({
    scanAndImportLibrary,
    scanAndImportOneMediaItem,
    refreshOneMediaItem,
    refreshLibraryMetadata,
    matchAdditionalProviders,
    matchProvidersForLibrary,
    splitAuthorTitleFilename,
    guessComicSeriesFromFilename,
  } = await import("../src/services/libraryScan.js"));
  ({ isPlaceholderParent } = await import("../src/services/mediaTypes.js"));
});

let tmpRoot: string;

beforeEach(async () => {
  await db.prepare("DELETE FROM tracks").run();
  await db.prepare("DELETE FROM episodes").run();
  await db.prepare("DELETE FROM sub_items").run();
  await db.prepare("DELETE FROM media_items").run();
  await db.prepare("DELETE FROM root_folders").run();

  probeMediaInfo.mockReset().mockResolvedValue(null);
  probeAudioTags.mockReset().mockResolvedValue(null);
  searchMetadata.mockReset().mockResolvedValue([]);
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  fetchSeriesEpisodesFor.mockReset().mockResolvedValue([]);
  fetchSeriesEpisodesForProvider.mockReset().mockResolvedValue([]);
  fetchSeriesSeasonsFor.mockReset().mockResolvedValue([]);
  fetchArtistAlbumsFor.mockReset().mockResolvedValue(null);
  fetchCollectionChildrenFor.mockReset().mockResolvedValue({ provider: null, children: [] });
  fetchMovieByTmdbId.mockReset().mockResolvedValue({});

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-looseroot-"));
  // Same default every test starts from as the old pdfParse.mockRejectedValue(new Error("not a
  // pdf")): a stray .pdf file that some future test forgets to point at its own worker script fails
  // the read (readBookFileMetadata's catch swallows it to null) instead of silently succeeding.
  // Reset here (rather than left dangling from the previous test) so this file's use of the seam
  // never leaks into whatever test runs after it.
  __setPdfInfoWorkerUrlForTests(erroringWorker());
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function insertRootFolder(mediaType: string, name = mediaType): Promise<{ id: number; path: string }> {
  const p = path.join(tmpRoot, name);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, mediaType, mediaType);
  return { id: Number(result.lastInsertRowid), path: p };
}

function writeFile(dir: string, name: string, content: string | Buffer = "fake bytes"): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function opf(title: string, creator?: string): string {
  return `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title>${
    creator ? `<dc:creator>${creator}</dc:creator>` : ""
  }</metadata></package>`;
}

async function parents(type: string): Promise<any[]> {
  return (await db.prepare("SELECT * FROM media_items WHERE type = ? ORDER BY title").all(type)) as any[];
}

async function childrenOf(mediaItemId: number): Promise<any[]> {
  return (await db.prepare("SELECT * FROM sub_items WHERE media_item_id = ? ORDER BY title").all(mediaItemId)) as any[];
}

async function insertItem(type: string, title: string, externalIds: Record<string, string> | null = null, monitored = 1): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES (?, ?, ?, ?, 1, 'unknown', ?)`)
    .run(type, title, title.toLowerCase(), monitored, externalIds ? JSON.stringify(externalIds) : null);
  return Number(result.lastInsertRowid);
}

// --- PDF worker-thread test seam --------------------------------------------------------------
// readBookFileMetadata's .pdf branch dispatches the actual pdf-parse call into a real worker_thread
// (see the note by the imports above). These helpers write small throwaway .mjs worker scripts into
// this test's own tmpRoot — a real, standalone JS file with none of tsx's/vitest's module resolution
// helping out, exactly like bookFileMetadata.test.ts's "via a real worker_thread" tests — and return
// a file:// URL for __setPdfInfoWorkerUrlForTests. Written under tmpRoot (not under any root
// folder's own path), so they're never themselves picked up by a scan, and are deleted with
// everything else in afterEach.

function writeWorkerScript(name: string, body: string): URL {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, body);
  return pathToFileURL(file);
}

// The same Title/Author cleanup parsePdfInfoTask (pdfInfoWorker.ts) applies, computed here on the
// main thread with the real cleanPdfTitle/cleanPdfAuthor. A canned worker result built from this is
// exactly what production would have produced for the same raw pdf-parse `info` object, not a
// hand-picked approximation of it.
function pdfWorkerResult(raw: { Title?: unknown; Author?: unknown }): { title: string | null; author: string | null; isbn: null } {
  return { title: cleanPdfTitle(raw.Title), author: cleanPdfAuthor(raw.Author), isbn: null };
}

const respondingWorker = (result: unknown) =>
  writeWorkerScript(
    `worker-respond-${Math.random().toString(36).slice(2)}.mjs`,
    `import { parentPort } from "node:worker_threads";\nparentPort.postMessage({ ok: true, result: ${JSON.stringify(result)} });\n`
  );

const erroringWorker = () =>
  writeWorkerScript(
    `worker-error-${Math.random().toString(36).slice(2)}.mjs`,
    `import { parentPort } from "node:worker_threads";\nparentPort.postMessage({ ok: false, error: "not a pdf" });\n`
  );

// Branches on the PDF file's own bytes (read straight off disk, exactly as pdf-parse itself would
// have read them) rather than its path — mirrors the old
// `pdfParse.mockImplementation((buf) => buf.toString().includes(...) ? A : B)` pattern used when two
// loose files in the same test got different canned info depending on which one was actually read.
function respondingWorkerByFileContent(rules: { includes: string; result: unknown }[], fallback: unknown): URL {
  const branches = rules.map((r) => `if (content.includes(${JSON.stringify(r.includes)})) result = ${JSON.stringify(r.result)};`).join("\n");
  return writeWorkerScript(
    `worker-bycontent-${Math.random().toString(36).slice(2)}.mjs`,
    `import fs from "node:fs";\nimport { parentPort, workerData } from "node:worker_threads";\nconst content = fs.readFileSync(workerData.filePath, "utf8");\nlet result = ${JSON.stringify(
      fallback
    )};\n${branches}\nparentPort.postMessage({ ok: true, result });\n`
  );
}

// A responding worker that also records each dispatch to a counter file on disk (the worker thread
// still has ordinary fs access) — the replacement for asserting on a mocked pdf-parse's call count
// (`toHaveBeenCalledTimes`/`not.toHaveBeenCalled`), now that the real dispatch happens inside a real
// worker_thread this file's old vi.mock("pdf-parse") could never reach anyway.
function countingWorker(result: unknown): { url: URL; callCount: () => number } {
  const countFile = path.join(tmpRoot, `worker-count-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(countFile, "");
  const url = writeWorkerScript(
    `worker-counting-${Math.random().toString(36).slice(2)}.mjs`,
    `import fs from "node:fs";\nimport { parentPort } from "node:worker_threads";\nfs.appendFileSync(${JSON.stringify(countFile)}, "x");\nparentPort.postMessage({ ok: true, result: ${JSON.stringify(
      result
    )} });\n`
  );
  return { url, callCount: () => fs.readFileSync(countFile, "utf8").length };
}

// ---------------------------------------------------------------------------

describe("Books: a book file loose in the root folder", () => {
  it("takes author/title from a same-basename .opf beside it", async () => {
    const folder = await insertRootFolder("author");
    const file = writeFile(folder.path, "scan0001.epub");
    writeFile(folder.path, "scan0001.opf", opf("The Left Hand of Darkness", "Ursula K. Le Guin"));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 1, skipped: 0 });
    const [author] = await parents("author");
    expect(author).toMatchObject({ title: "Ursula K. Le Guin", monitored: 1, has_file: 1, root_folder_id: folder.id });
    expect(await childrenOf(author.id)).toMatchObject([{ title: "The Left Hand of Darkness", has_file: 1, file_path: file }]);
  });

  it("never applies the root folder's own metadata.opf to a loose file", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "metadata.opf", opf("Wrong Book", "Wrong Author"));
    writeFile(folder.path, "Stephen King - The Stand.epub");

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Stephen King"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["The Stand"]);
  });

  it("reads an EPUB's embedded dc:creator/dc:title (first author of several)", async () => {
    const folder = await insertRootFolder("author");
    const file = writeEpub(path.join(folder.path, "download (3).epub"), {
      title: "Good Omens",
      creators: [{ name: "Terry Pratchett & Neil Gaiman" }],
      identifiers: ["urn:isbn:9780132350884"],
    });

    await scanAndImportLibrary("author");

    const [author] = await parents("author");
    expect(author.title).toBe("Terry Pratchett");
    expect(await childrenOf(author.id)).toMatchObject([{ title: "Good Omens", file_path: file }]);
  });

  it("reads a MOBI's EXTH author/title", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "B00ABC123.mobi", buildMobi({ fullName: "Mistborn", exth: [{ type: 100, value: "Brandon Sanderson" }] }));

    await scanAndImportLibrary("author");

    const [author] = await parents("author");
    expect(author.title).toBe("Brandon Sanderson");
    expect((await childrenOf(author.id)).map((c) => c.title)).toEqual(["Mistborn"]);
  });

  it("reads a PDF's info Author/Title, but not a software name posing as the author", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "cc.pdf", "%PDF-1.4 book");
    writeFile(folder.path, "report.pdf", "%PDF-1.4 report");
    __setPdfInfoWorkerUrlForTests(
      respondingWorkerByFileContent(
        [{ includes: "report", result: pdfWorkerResult({ Title: "Quarterly Report", Author: "Microsoft Word" }) }],
        pdfWorkerResult({ Title: "Clean Code", Author: "Robert C. Martin" })
      )
    );

    await scanAndImportLibrary("author");

    const byTitle = Object.fromEntries((await parents("author")).map((a) => [a.title, a]));
    expect(Object.keys(byTitle).sort()).toEqual(["Robert C. Martin", "Unknown Author"]);
    expect((await childrenOf(byTitle["Robert C. Martin"].id)).map((c) => c.title)).toEqual(["Clean Code"]);
    expect((await childrenOf(byTitle["Unknown Author"].id)).map((c) => c.title)).toEqual(["Quarterly Report"]);
  });

  it("falls back to an 'Author - Title' filename when the file has no readable metadata", async () => {
    const folder = await insertRootFolder("author");
    const file = writeFile(folder.path, "Stephen King & Owen King - Sleeping Beauties (2017).epub"); // not a real zip

    await scanAndImportLibrary("author");

    const [author] = await parents("author");
    expect(author.title).toBe("Stephen King");
    expect(await childrenOf(author.id)).toMatchObject([{ title: "Sleeping Beauties", file_path: file }]);
  });

  it("files unidentifiable books under one shared, unmonitored 'Unknown Author'", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "mystery.epub");
    writeFile(folder.path, "Discworld 01 - The Colour of Magic.epub"); // numbering, not an author

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const all = await parents("author");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: "Unknown Author", monitored: 0, has_file: 1 });
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Discworld 01 - The Colour of Magic", "mystery"]);
  });

  it("reuses an existing Unknown Author row on a later scan instead of creating a second one", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "first.epub");
    await scanAndImportLibrary("author");
    writeFile(folder.path, "second.epub");

    const result = await scanAndImportLibrary("author");

    expect(result.matched).toBe(1); // the first file is already tracked and never re-walked
    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Unknown Author"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["first", "second"]);
  });

  it("files a sort-order 'Last, First' creator under the existing display-order author", async () => {
    const folder = await insertRootFolder("author");
    const kingId = await insertItem("author", "Stephen King");
    const leGuinId = await insertItem("author", "Ursula K. Le Guin");
    writeEpub(path.join(folder.path, "a.epub"), { title: "The Stand", creators: [{ name: "King, Stephen" }] });
    writeEpub(path.join(folder.path, "b.epub"), { title: "A Wizard of Earthsea", creators: [{ name: "Le Guin, Ursula K." }] });

    await scanAndImportLibrary("author");

    expect((await parents("author")).map((a) => a.title)).toEqual(["Stephen King", "Ursula K. Le Guin"]);
    expect((await childrenOf(kingId)).map((c) => c.title)).toEqual(["The Stand"]);
    expect((await childrenOf(leGuinId)).map((c) => c.title)).toEqual(["A Wizard of Earthsea"]);
  });

  it("takes author and title together from the filename when the embedded metadata names no author", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "Stephen King - The Stand.mobi", buildMobi({ fullName: "Layout 1" }));
    writeFile(folder.path, "Carrie - Stephen King.pdf", "%PDF-1.4 carrie");
    __setPdfInfoWorkerUrlForTests(respondingWorker(pdfWorkerResult({ Title: "Carrie", Author: "" })));

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Stephen King"]);
    // "Carrie - Stephen King": the PDF's own title is the left half, so the name is Title - Author.
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Carrie", "The Stand"]);
  });

  it("files books by the same non-Latin author together", async () => {
    const folder = await insertRootFolder("author");
    writeEpub(path.join(folder.path, "a.epub"), { title: "Война и мир", creators: [{ name: "Лев Толстой" }] });
    writeEpub(path.join(folder.path, "b.epub"), { title: "Анна Каренина", creators: [{ name: "Лев Толстой" }] });

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Лев Толстой"]);
    expect(await childrenOf(all[0].id)).toHaveLength(2);
  });

  it("imports unrelated unidentified books that share a generic embedded title, but not a second format of one", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "x1.mobi", buildMobi({ fullName: "Introduction" }));
    writeFile(folder.path, "x1.azw3", buildMobi({ fullName: "Introduction" }));
    writeFile(folder.path, "x2.mobi", buildMobi({ fullName: "Introduction" }));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 2, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("already has a file");
    const [placeholder] = await parents("author");
    const titles = (await childrenOf(placeholder.id)).map((c) => c.title);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toBe("Introduction");
    expect(titles[1]).toMatch(/^Introduction \(x[12]\)$/);
    // Nothing new on a re-scan: every file is either tracked or still the same duplicate.
    expect(await scanAndImportLibrary("author")).toMatchObject({ matched: 0, skipped: 1 });
  });

  it("still applies the duplicate guard: a loose copy of a book that already has a file is left alone", async () => {
    const folder = await insertRootFolder("author");
    const authorId = await insertItem("author", "Stephen King");
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'The Stand', 1, 1, '/elsewhere/The Stand.epub')`).run(authorId);
    writeFile(folder.path, "Stephen King - The Stand.epub");

    const result = await scanAndImportLibrary("author");

    expect(result.skipped).toBe(1);
    expect(result.skippedFiles[0].reason).toContain('matched existing "The Stand" which already has a file');
    expect(await childrenOf(authorId)).toMatchObject([{ file_path: "/elsewhere/The Stand.epub" }]);
  });
});

describe("Books: files a Mac or a download site leaves behind", () => {
  it("never imports a macOS AppleDouble companion ('._<name>') in place of the real file", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "._Stephen King - It.epub", Buffer.alloc(4096));
    const itFile = writeFile(folder.path, "Stephen King - It.epub");
    writeFile(folder.path, "._Dune.epub", Buffer.alloc(4096));
    const dune = writeEpub(path.join(folder.path, "Dune.epub"), { title: "Dune", creators: [{ name: "Frank Herbert" }] });
    writeFile(path.join(folder.path, ".AppleDouble"), "Dune.epub", Buffer.alloc(4096));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const byTitle = Object.fromEntries((await parents("author")).map((a) => [a.title, a]));
    expect(Object.keys(byTitle).sort()).toEqual(["Frank Herbert", "Stephen King"]);
    expect(await childrenOf(byTitle["Stephen King"].id)).toMatchObject([{ title: "It", file_path: itFile }]);
    expect(await childrenOf(byTitle["Frank Herbert"].id)).toMatchObject([{ title: "Dune", file_path: dune }]);
  });

  it("skips AppleDouble companions for every media type", async () => {
    const folder = await insertRootFolder("movie");
    writeFile(path.join(folder.path, "Dune (2021)"), "._Dune (2021).mkv", Buffer.alloc(4096));
    const real = writeFile(path.join(folder.path, "Dune (2021)"), "Dune (2021).mkv");

    const result = await scanAndImportLibrary("movie");

    expect(result).toMatchObject({ created: 1, skipped: 0 });
    expect(await parents("movie")).toMatchObject([{ title: "Dune", path: real }]);
  });

  it("files two unrelated PDFs whose Author/Title a download site stamped with its own name by their filenames", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "Clean Architecture.pdf", "%PDF-1.4 one");
    writeFile(folder.path, "Other Book.pdf", "%PDF-1.4 two");
    __setPdfInfoWorkerUrlForTests(respondingWorker(pdfWorkerResult({ Title: "www.it-ebooks.info", Author: "www.it-ebooks.info" })));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Unknown Author"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Clean Architecture", "Other Book"]);
  });
});

describe("Books: embedded metadata that only half-identifies a loose book", () => {
  it("files a PDF whose Author is a default account name ('Windows User') under the unmonitored Unknown Author", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "Quarterly Handbook.pdf", "%PDF-1.4 handbook");
    __setPdfInfoWorkerUrlForTests(respondingWorker(pdfWorkerResult({ Title: "", Author: "Windows User" })));
    searchMetadata.mockResolvedValue([{ title: "Some Stranger", year: null, overview: "x", posterUrl: null, externalIds: { openlibrary: "OL1A" } }]);

    await scanAndImportLibrary("author");
    const all = await parents("author");
    expect(all).toMatchObject([{ title: "Unknown Author", monitored: 0 }]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Quarterly Handbook"]);

    await refreshLibraryMetadata("author");
    expect(searchMetadata).not.toHaveBeenCalled();
  });

  it("keeps the whole filename as the title unless one of its ' - ' halves is the embedded author", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "Deep Learning - Adaptive Computation.pdf", "%PDF-1.4 one");
    writeFile(folder.path, "Ian Goodfellow - Deep Learning Book.pdf", "%PDF-1.4 two");
    writeFile(folder.path, "Machine Learning - Ian Goodfellow.pdf", "%PDF-1.4 three");
    __setPdfInfoWorkerUrlForTests(respondingWorker(pdfWorkerResult({ Title: "Microsoft Word - dl.docx", Author: "Ian Goodfellow" })));

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Ian Goodfellow"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual([
      "Deep Learning - Adaptive Computation",
      "Deep Learning Book",
      "Machine Learning",
    ]);
  });
});

describe("Books: one book in several formats is identified once", () => {
  it("files every format in a Title folder under the author one format's metadata names", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Dune");
    const epub = writeEpub(path.join(dir, "Dune.epub"), { title: "Dune", creators: [{ name: "Frank Herbert" }] });
    const pdf = writeFile(dir, "Dune.pdf", "%PDF-1.4 no info");
    const pdfWorker = countingWorker(pdfWorkerResult({}));
    __setPdfInfoWorkerUrlForTests(pdfWorker.url);

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 1, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain('matched existing "Dune" which already has a file');
    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Frank Herbert"]);
    const children = await childrenOf(all[0].id);
    expect(children).toMatchObject([{ title: "Dune", has_file: 1 }]);
    expect([epub, pdf]).toContain(children[0].file_path);
    expect(pdfWorker.callCount()).toBe(0); // the EPUB said everything, so the PDF was never parsed
  });

  it("uses whichever format has the metadata when the first one read has none", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Dune");
    writeFile(dir, "Dune.epub", "not a zip");
    writeFile(dir, "Dune.pdf", "%PDF-1.4 dune");
    __setPdfInfoWorkerUrlForTests(respondingWorker(pdfWorkerResult({ Title: "Dune", Author: "Frank Herbert" })));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 1, skipped: 1 });
    expect((await parents("author")).map((a) => a.title)).toEqual(["Frank Herbert"]);
  });

  it("gives a loose book's formats the one title its embedded metadata gives", async () => {
    const folder = await insertRootFolder("author");
    writeEpub(path.join(folder.path, "Book.epub"), { title: "The Real Title" });
    writeFile(folder.path, "Book.pdf", "%PDF-1.4 no info");
    __setPdfInfoWorkerUrlForTests(respondingWorker(pdfWorkerResult({})));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 1, skipped: 1 });
    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Unknown Author"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["The Real Title"]);
  });

  it("a format added later joins the parent its tracked format is filed under, without reading it", async () => {
    const folder = await insertRootFolder("author");
    writeEpub(path.join(folder.path, "Dune.epub"), { title: "Dune", creators: [{ name: "Frank Herbert" }] });
    await scanAndImportLibrary("author");
    writeFile(folder.path, "Dune.pdf", "%PDF-1.4");
    const pdfWorker = countingWorker(pdfWorkerResult({ Title: "Dune", Author: "Someone Else" }));
    __setPdfInfoWorkerUrlForTests(pdfWorker.url);

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 0, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("already has a file");
    expect((await parents("author")).map((a) => a.title)).toEqual(["Frank Herbert"]);
    expect(pdfWorker.callCount()).toBe(0);
  });

  it("an upgraded library's folder-named author keeps a new format of its book (no second author)", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Dune");
    const epub = writeFile(dir, "Dune.epub");
    const legacyId = await insertItem("author", "Dune");
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Dune', 1, 1, ?)").run(legacyId, epub);
    writeFile(dir, "Dune.pdf", "%PDF-1.4");
    const pdfWorker = countingWorker(pdfWorkerResult({ Title: "Dune", Author: "Frank Herbert" }));
    __setPdfInfoWorkerUrlForTests(pdfWorker.url);

    for (let scan = 0; scan < 3; scan++) {
      const result = await scanAndImportLibrary("author");
      expect(result).toMatchObject({ matched: 0, skipped: 1 });
      expect(result.skippedFiles[0].reason).toContain('matched existing "Dune" which already has a file');
    }
    expect((await parents("author")).map((a) => a.title)).toEqual(["Dune"]);
    expect(pdfWorker.callCount()).toBe(0);
  });

  it("never re-reads a lone author folder's second format on later scans", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Stephen King");
    writeFile(dir, "Carrie.epub");
    await scanAndImportLibrary("author");
    writeFile(dir, "Carrie.pdf", "%PDF-1.4");
    const pdfWorker = countingWorker(pdfWorkerResult({ Title: "Carrie", Author: "Stephen King" }));
    __setPdfInfoWorkerUrlForTests(pdfWorker.url);

    for (let scan = 0; scan < 3; scan++) expect(await scanAndImportLibrary("author")).toMatchObject({ matched: 0, skipped: 1 });
    expect(pdfWorker.callCount()).toBe(0);
    expect((await parents("author")).map((a) => a.title)).toEqual(["Stephen King"]);
  });

  it("reads an untracked loose file that stays a duplicate only once across scans", async () => {
    const folder = await insertRootFolder("author");
    const kingId = await insertItem("author", "Stephen King");
    await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'The Stand', 1, 1, '/elsewhere/The Stand.epub')`).run(kingId);
    writeFile(folder.path, "stand.pdf", "%PDF-1.4");
    const pdfWorker = countingWorker(pdfWorkerResult({ Title: "The Stand", Author: "Stephen King" }));
    __setPdfInfoWorkerUrlForTests(pdfWorker.url);

    for (let scan = 0; scan < 3; scan++) {
      const result = await scanAndImportLibrary("author");
      expect(result).toMatchObject({ matched: 0, skipped: 1 });
    }
    expect(pdfWorker.callCount()).toBe(1);
  });
});

describe("Books: metadata.opf only applies to the one book it sits beside", () => {
  it("two books + one stray metadata.opf in an author folder keep their own filename titles", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Frank Herbert");
    writeFile(dir, "Dune.epub");
    writeFile(dir, "Dune Messiah.epub");
    writeFile(dir, "metadata.opf", opf("Children of Dune", "Frank Herbert"));

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const [author] = await parents("author");
    expect((await childrenOf(author.id)).map((c) => c.title)).toEqual(["Dune", "Dune Messiah"]);
  });

  it("still applies to a lone book (also when saved in several formats), and a per-file .opf wins over it", async () => {
    const folder = await insertRootFolder("author");
    const bookDir = path.join(folder.path, "Frank Herbert", "Dune (1965)");
    writeFile(bookDir, "Dune - Frank Herbert.epub");
    writeFile(bookDir, "Dune - Frank Herbert.mobi");
    writeFile(bookDir, "metadata.opf", opf("Dune", "Frank Herbert"));
    const otherDir = path.join(folder.path, "Frank Herbert", "Other");
    writeFile(otherDir, "x.epub");
    writeFile(otherDir, "x.opf", opf("The Dosadi Experiment", "Frank Herbert"));
    writeFile(otherDir, "metadata.opf", opf("Wrong", "Frank Herbert"));

    await scanAndImportLibrary("author");

    const [author] = await parents("author");
    const children = await childrenOf(author.id);
    // Both formats of the lone book resolve to its metadata.opf title — the second is the duplicate.
    expect(children.map((c) => c.title)).toEqual(["Dune", "The Dosadi Experiment"]);
  });
});

describe("Books: a book folder directly under the root (Root/<Book Title>/book.epub)", () => {
  it("files the book under the author its embedded metadata names when the title matches the folder", async () => {
    const folder = await insertRootFolder("author");
    const file = writeEpub(path.join(folder.path, "The Hobbit (1937)", "book.epub"), {
      title: "The Hobbit",
      creators: [{ name: "J.R.R. Tolkien" }],
    });

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["J.R.R. Tolkien"]);
    expect(await childrenOf(all[0].id)).toMatchObject([{ title: "The Hobbit", file_path: file }]);
  });

  it("uses the per-book metadata.opf for the same decision", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Neuromancer");
    writeFile(dir, "book.epub");
    writeFile(dir, "metadata.opf", opf("Neuromancer", "William Gibson"));

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["William Gibson"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Neuromancer"]);
  });

  it("an author folder of several books is never taken for a book's own folder, whatever the filenames say", async () => {
    const folder = await insertRootFolder("author");
    const dir = path.join(folder.path, "Stephen King");
    writeFile(dir, "Carrie - Stephen King.epub");
    writeFile(dir, "It - Stephen King.epub");
    writeFile(dir, "The Stand.epub");

    const result = await scanAndImportLibrary("author");

    expect(result).toMatchObject({ matched: 3, skipped: 0 });
    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Stephen King"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Carrie - Stephen King", "It - Stephen King", "The Stand"]);
  });

  it("a lone 'Title - Author' book keeps its author folder, with or without embedded metadata", async () => {
    const folder = await insertRootFolder("author");
    writeEpub(path.join(folder.path, "Frank Herbert", "Dune - Frank Herbert.epub"), { title: "Dune", creators: [{ name: "Frank Herbert" }] });
    writeFile(path.join(folder.path, "Stephen King"), "Carrie - Stephen King.epub"); // no readable metadata

    await scanAndImportLibrary("author");

    const byTitle = Object.fromEntries((await parents("author")).map((a) => [a.title, a]));
    expect(Object.keys(byTitle).sort()).toEqual(["Frank Herbert", "Stephen King"]);
    expect((await childrenOf(byTitle["Frank Herbert"].id)).map((c) => c.title)).toEqual(["Dune - Frank Herbert"]);
    expect((await childrenOf(byTitle["Stephen King"].id)).map((c) => c.title)).toEqual(["Carrie - Stephen King"]);
  });

  it("the author's per-item Scan & Import still picks those books up", async () => {
    const folder = await insertRootFolder("author");
    const kingId = await insertItem("author", "Stephen King");
    const dir = path.join(folder.path, "Stephen King");
    writeFile(dir, "Carrie - Stephen King.epub");
    writeFile(dir, "It - Stephen King.epub");

    const result = await scanAndImportOneMediaItem(kingId);

    expect(result.matched).toBe(2);
    expect((await parents("author")).map((a) => a.title)).toEqual(["Stephen King"]);
    expect(await childrenOf(kingId)).toHaveLength(2);
  });

  it("keeps the folder as the author when the book's own title doesn't match it", async () => {
    const folder = await insertRootFolder("author");
    writeEpub(path.join(folder.path, "Stephen King", "It.epub"), { title: "It", creators: [{ name: "Stephen King" }] });

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all.map((a) => a.title)).toEqual(["Stephen King"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["It"]);
  });
});

describe("Placeholder parents are never searched for or renamed", () => {
  async function scanUnknownBook(): Promise<number> {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "mystery.epub");
    await scanAndImportLibrary("author");
    const [placeholder] = await parents("author");
    expect(placeholder).toMatchObject({ title: "Unknown Author", monitored: 0 });
    return placeholder.id;
  }

  it("Refresh (per item and whole library) never searches a provider for it or renames it", async () => {
    const placeholderId = await scanUnknownBook();
    const realId = await insertItem("author", "Ursula K. Le Guin");
    searchMetadata.mockResolvedValue([{ title: "Some Stranger", year: null, overview: "x", posterUrl: null, externalIds: { openlibrary: "OL1A" } }]);

    expect(await refreshOneMediaItem(placeholderId)).toEqual({ ok: true, childrenAdded: 0 });
    expect(searchMetadata).not.toHaveBeenCalled();

    await refreshLibraryMetadata("author");
    expect(searchMetadata).toHaveBeenCalledTimes(1);
    expect(searchMetadata.mock.calls[0][1]).toBe("Ursula K. Le Guin");
    expect(realId).toBeGreaterThan(0);

    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(placeholderId)) as any;
    expect(row).toMatchObject({ title: "Unknown Author", monitored: 0 });
    expect(row.external_ids ?? null).toBeNull();
  });

  it("Match Providers never searches for it", async () => {
    const placeholderId = await scanUnknownBook();
    searchMetadata.mockResolvedValue([{ title: "Unknown Author", year: null, overview: null, posterUrl: null, externalIds: { googlebooks: "g1" } }]);

    expect(await matchAdditionalProviders(placeholderId)).toEqual([]);
    expect(await matchProvidersForLibrary("author")).toEqual({ itemsMatched: 0, providersMatched: 0 });
    expect(searchMetadata).not.toHaveBeenCalled();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(placeholderId)) as any;
    expect(row.external_ids ?? null).toBeNull();
  });

  it("a user's own 'Unknown author' folder is the same unmonitored, never-searched bucket", async () => {
    const folder = await insertRootFolder("author");
    writeFile(path.join(folder.path, "Unknown author"), "a.epub");
    writeFile(path.join(folder.path, "Unknown author"), "b.epub");
    writeFile(folder.path, "zzz.epub");

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all).toHaveLength(1);
    expect(all[0].title.toLowerCase()).toBe("unknown author");
    expect(all[0].monitored).toBe(0);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["a", "b", "zzz"]);

    searchMetadata.mockResolvedValue([{ title: "Some Stranger", year: null, overview: "x", posterUrl: null, externalIds: { openlibrary: "OL1A" } }]);
    await refreshLibraryMetadata("author");
    expect(await matchAdditionalProviders(all[0].id)).toEqual([]);
    expect(searchMetadata).not.toHaveBeenCalled();
    const row = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(all[0].id)) as any;
    expect(row.title.toLowerCase()).toBe("unknown author");
  });

  it("never files an unidentified book under a provider-matched 'Unknown Author'", async () => {
    const folder = await insertRootFolder("author");
    const matchedId = await insertItem("author", "Unknown Author", { openlibrary: "OL123A" });
    writeFile(folder.path, "mystery.epub");

    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all).toHaveLength(2);
    const placeholder = all.find((a) => a.id !== matchedId);
    expect(placeholder).toMatchObject({ title: "Unknown Author", monitored: 0 });
    expect(await childrenOf(matchedId)).toHaveLength(0);
    expect((await childrenOf(placeholder.id)).map((c) => c.title)).toEqual(["mystery"]);
  });

  it("isPlaceholderParent: placeholder title (case/punctuation-insensitive), placeholder type and no external ids", () => {
    expect(isPlaceholderParent({ type: "author", title: "Unknown Author", external_ids: null })).toBe(true);
    expect(isPlaceholderParent({ type: "author", title: "UNKNOWN AUTHOR", external_ids: null })).toBe(true);
    expect(isPlaceholderParent({ type: "author", title: "unknown-author" })).toBe(true);
    expect(isPlaceholderParent({ type: "author", title: "Unknown Authors" })).toBe(false);
    expect(isPlaceholderParent({ type: "author", title: "Unknown Author", external_ids: "{}" })).toBe(true);
    expect(isPlaceholderParent({ type: "comic", title: "Unknown Series", externalIds: "" })).toBe(true);
    expect(isPlaceholderParent({ type: "author", title: "Unknown Author", external_ids: '{"openlibrary":"OL1A"}' })).toBe(false);
    expect(isPlaceholderParent({ type: "author", title: "Unknown Series" })).toBe(false);
    expect(isPlaceholderParent({ type: "artist", title: "Unknown Author" })).toBe(false);
    expect(isPlaceholderParent({ type: "author", title: "Ursula K. Le Guin" })).toBe(false);
  });
});

describe("Comics/Manga: an issue loose in the root folder", () => {
  it("uses ComicInfo.xml's <Series> when present", async () => {
    const folder = await insertRootFolder("comic");
    const zip = new AdmZip();
    zip.addFile("ComicInfo.xml", Buffer.from(`<ComicInfo><Series>The Amazing Spider-Man</Series><Title>Issue One</Title></ComicInfo>`));
    zip.writeZip(path.join(folder.path, "asm-001.cbz"));

    await scanAndImportLibrary("comic");

    const [series] = await parents("comic");
    expect(series).toMatchObject({ title: "The Amazing Spider-Man", monitored: 1 });
    expect((await childrenOf(series.id)).map((c) => c.title)).toEqual(["Issue One"]);
  });

  it("otherwise takes the series from the filename, ignoring a bare ComicInfo.xml in the root", async () => {
    const folder = await insertRootFolder("manga");
    writeFile(folder.path, "ComicInfo.xml", `<ComicInfo><Series>Wrong Series</Series><Title>Wrong</Title></ComicInfo>`);
    writeFile(folder.path, "Saga 001 (2012).cbr");
    writeFile(folder.path, "Saga #2 (2012) [Digital].cbr");
    writeFile(folder.path, "One Piece v03.cbz");

    const result = await scanAndImportLibrary("manga");

    expect(result).toMatchObject({ matched: 3, skipped: 0 });
    expect((await parents("manga")).map((s) => s.title)).toEqual(["One Piece", "Saga"]);
  });

  it("groups scene-style dotted names with an unbracketed year into one series", async () => {
    const folder = await insertRootFolder("comic");
    writeFile(folder.path, "Saga.001.2012.cbr");
    writeFile(folder.path, "Saga.002.2012.cbr");

    await scanAndImportLibrary("comic");

    const all = await parents("comic");
    expect(all.map((s) => s.title)).toEqual(["Saga"]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["Saga 001", "Saga 002"]);
  });

  it("falls back to an unmonitored 'Unknown Series' when the filename names no series", async () => {
    const folder = await insertRootFolder("comic");
    writeFile(folder.path, "001.cbz");

    await scanAndImportLibrary("comic");

    const all = await parents("comic");
    expect(all).toMatchObject([{ title: "Unknown Series", monitored: 0 }]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["001"]);
  });

  it("a bare ComicInfo.xml in a series folder of several issues isn't applied to all of them", async () => {
    const folder = await insertRootFolder("comic");
    const dir = path.join(folder.path, "Saga");
    writeFile(dir, "Saga 001.cbr");
    writeFile(dir, "Saga 002.cbr");
    writeFile(dir, "ComicInfo.xml", `<ComicInfo><Series>Saga</Series><Title>Chapter One</Title></ComicInfo>`);

    const result = await scanAndImportLibrary("comic");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const [series] = await parents("comic");
    expect((await childrenOf(series.id)).map((c) => c.title)).toEqual(["Saga 001", "Saga 002"]);
  });

  it("guessComicSeriesFromFilename strips issue/volume/chapter numbering and year/tag groups", () => {
    expect(guessComicSeriesFromFilename("Saga 001 (2012)")).toBe("Saga");
    expect(guessComicSeriesFromFilename("Saga #12")).toBe("Saga");
    expect(guessComicSeriesFromFilename("One Piece v03")).toBe("One Piece");
    expect(guessComicSeriesFromFilename("Naruto Vol. 3")).toBe("Naruto");
    expect(guessComicSeriesFromFilename("Bleach Ch. 45")).toBe("Bleach");
    expect(guessComicSeriesFromFilename("Chainsaw Man - Chapter 045")).toBe("Chainsaw Man");
    expect(guessComicSeriesFromFilename("Invincible 012 - The Beginning")).toBe("Invincible");
    expect(guessComicSeriesFromFilename("2000 AD 001")).toBe("2000 AD");
    expect(guessComicSeriesFromFilename("Batman 66 003")).toBe("Batman 66");
    expect(guessComicSeriesFromFilename("Saga.001.2012")).toBe("Saga");
    expect(guessComicSeriesFromFilename("Saga.001.2012.Digital")).toBe("Saga");
    expect(guessComicSeriesFromFilename("Spider-Man 2099 001")).toBe("Spider-Man 2099");
    expect(guessComicSeriesFromFilename("Spider-Man 2099 2019")).toBe("Spider-Man 2099");
    expect(guessComicSeriesFromFilename("Watchmen")).toBe("Watchmen");
    expect(guessComicSeriesFromFilename("001")).toBeNull();
  });
});

describe("Audiobooks: a single audio file loose in the root folder", () => {
  it("imports it as one book whose file_path is the file itself, with one track row", async () => {
    const folder = await insertRootFolder("audiobook");
    const file = writeFile(folder.path, "Brandon Sanderson - Elantris.m4b");

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 1, skipped: 0 });
    const [author] = await parents("audiobook");
    expect(author).toMatchObject({ title: "Brandon Sanderson", monitored: 1, has_file: 1 });
    const [book] = await childrenOf(author.id);
    expect(book).toMatchObject({ title: "Elantris", has_file: 1, file_path: file });
    const tracks = (await db.prepare("SELECT * FROM tracks WHERE sub_item_id = ?").all(book.id)) as any[];
    expect(tracks).toMatchObject([{ track_number: 1, title: "Elantris", has_file: 1, file_path: file }]);

    // Re-scanning never re-imports the already-tracked file.
    expect(await scanAndImportLibrary("audiobook")).toMatchObject({ matched: 0, skipped: 0 });
  });

  it("prefers a same-basename .opf, then the file's own tags, over the filename", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "track.m4b");
    writeFile(folder.path, "other.mp3");
    writeFile(folder.path, "other.opf", opf("Leviathan Wakes", "James S. A. Corey"));
    writeFile(folder.path, "metadata.opf", opf("Never Applied", "Nobody"));
    probeAudioTags.mockImplementation(async (filePath: string) =>
      filePath.endsWith("track.m4b") ? { artist: "Unknown Artist", albumArtist: "Andy Weir", author: null, album: "Project Hail Mary", title: "Chapter 1" } : null
    );

    await scanAndImportLibrary("audiobook");

    const byTitle = Object.fromEntries((await parents("audiobook")).map((a) => [a.title, a]));
    expect(Object.keys(byTitle).sort()).toEqual(["Andy Weir", "James S. A. Corey"]);
    expect((await childrenOf(byTitle["Andy Weir"].id)).map((c) => c.title)).toEqual(["Project Hail Mary"]);
    expect((await childrenOf(byTitle["James S. A. Corey"].id)).map((c) => c.title)).toEqual(["Leviathan Wakes"]);
    expect(probeAudioTags).toHaveBeenCalledTimes(1); // other.mp3's .opf named both, so its tags were never read
  });

  it("files an unidentifiable one under an unmonitored Unknown Author", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "audiobook.mp3");

    await scanAndImportLibrary("audiobook");

    const all = await parents("audiobook");
    expect(all).toMatchObject([{ title: "Unknown Author", monitored: 0 }]);
    expect((await childrenOf(all[0].id)).map((c) => c.title)).toEqual(["audiobook"]);
  });

  it("skips chapter/track/part-named files and numbered siblings without probing them", async () => {
    const folder = await insertRootFolder("audiobook");
    for (const n of [1, 2, 3, 4]) writeFile(folder.path, `Chapter 0${n}.mp3`);
    for (const n of [1, 2]) writeFile(folder.path, `0${n} - Chapter ${n}.mp3`);
    writeFile(folder.path, "Project Hail Mary Part 1.m4b");
    writeFile(folder.path, "Dune 01.mp3");
    writeFile(folder.path, "Dune 02.mp3");
    probeAudioTags.mockResolvedValue({ artist: "Andy Weir", albumArtist: null, author: null, album: "Project Hail Mary", title: "Chapter" });

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 0, skipped: 9 });
    for (const skipped of result.skippedFiles) {
      expect(skipped.reason).toContain("multi-file audiobook");
      expect(skipped.reason).toContain('"Author/Title/"');
      // Never only "put them all in one folder": that would merge separate numbered books into one.
      expect(skipped.reason).toContain("if it is a whole book on its own");
    }
    expect(probeAudioTags).not.toHaveBeenCalled();
    expect(await parents("audiobook")).toHaveLength(0);
  });

  it("skips every loose file whose tags make it the same book as another, and imports the rest", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "phm-intro.mp3");
    writeFile(folder.path, "phm-ending.mp3");
    const martian = writeFile(folder.path, "Andy Weir - The Martian.m4b");
    probeAudioTags.mockImplementation(async (filePath: string) =>
      filePath.includes("phm-") ? { artist: "Andy Weir", albumArtist: null, author: null, album: "Project Hail Mary", title: null } : null
    );

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 1, skipped: 2 });
    expect(result.skippedFiles.map((f) => path.basename(f.path)).sort()).toEqual(["phm-ending.mp3", "phm-intro.mp3"]);
    expect(result.skippedFiles.every((f) => f.reason.includes("multi-file audiobook"))).toBe(true);
    const [author] = await parents("audiobook");
    expect(author.title).toBe("Andy Weir");
    expect(await childrenOf(author.id)).toMatchObject([{ title: "The Martian", file_path: martian }]);
    expect(probeAudioTags).toHaveBeenCalledTimes(3); // once per file, not again in the import pass
  });

  it("treats the same book in two formats as one book, and an all-number title as a whole book", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "Brandon Sanderson - Elantris.m4b");
    writeFile(folder.path, "Brandon Sanderson - Elantris.mp3");
    writeFile(folder.path, "11-22-63.m4b");
    writeFile(folder.path, "1984.mp3");

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 3, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain("already has a file");
    const byTitle = Object.fromEntries((await parents("audiobook")).map((a) => [a.title, a]));
    expect(Object.keys(byTitle).sort()).toEqual(["Brandon Sanderson", "Unknown Author"]);
    expect((await childrenOf(byTitle["Unknown Author"].id)).map((c) => c.title)).toEqual(["11-22-63", "1984"]);
  });

  it("imports numbered .m4b files as separate books, and a title that starts with a number", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "Brandon Sanderson - Mistborn 1.m4b");
    writeFile(folder.path, "Brandon Sanderson - Mistborn 2.m4b");
    writeFile(folder.path, "100 Years of Solitude.mp3");
    writeFile(folder.path, "12 Rules for Life.mp3");

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 4, skipped: 0 });
    const byTitle = Object.fromEntries((await parents("audiobook")).map((a) => [a.title, a]));
    expect(Object.keys(byTitle).sort()).toEqual(["Brandon Sanderson", "Unknown Author"]);
    expect((await childrenOf(byTitle["Brandon Sanderson"].id)).map((c) => c.title)).toEqual(["Mistborn 1", "Mistborn 2"]);
    expect((await childrenOf(byTitle["Unknown Author"].id)).map((c) => c.title)).toEqual(["100 Years of Solitude", "12 Rules for Life"]);
  });

  it("still takes zero-padded or separator-numbered names for tracks", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "007 Prologue.mp3");
    writeFile(folder.path, "3. The Beginning.mp3");
    writeFile(folder.path, "1-01 Opening.mp3");
    writeFile(folder.path, "11-22-63.mp3");

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 1, skipped: 3 });
    expect(result.skippedFiles.map((f) => path.basename(f.path)).sort()).toEqual(["007 Prologue.mp3", "1-01 Opening.mp3", "3. The Beginning.mp3"]);
    const [placeholder] = await parents("audiobook");
    expect((await childrenOf(placeholder.id)).map((c) => c.title)).toEqual(["11-22-63"]);
  });

  it("never titles a book by a chapter's own title tag", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "Project Hail Mary.mp3");
    probeAudioTags.mockResolvedValue({ artist: "Andy Weir", albumArtist: null, author: null, album: null, title: "Chapter 1" });

    await scanAndImportLibrary("audiobook");

    const [author] = await parents("audiobook");
    expect(author.title).toBe("Andy Weir");
    expect((await childrenOf(author.id)).map((c) => c.title)).toEqual(["Project Hail Mary"]);
  });

  it("imports whole books whose only tag is a placeholder album as separate books", async () => {
    const folder = await insertRootFolder("audiobook");
    writeFile(folder.path, "Project Hail Mary.m4b");
    writeFile(folder.path, "The Martian.m4b");
    probeAudioTags.mockResolvedValue({ artist: null, albumArtist: null, author: null, album: "Unknown Album", title: "Untitled" });

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const [placeholder] = await parents("audiobook");
    expect((await childrenOf(placeholder.id)).map((c) => c.title)).toEqual(["Project Hail Mary", "The Martian"]);
  });

  it("imports .m4b books sharing one generic album tag as separate books, each with its own title", async () => {
    const folder = await insertRootFolder("audiobook");
    const first = writeFile(folder.path, "Project Hail Mary.m4b");
    const second = writeFile(folder.path, "The Martian.m4b");
    probeAudioTags.mockResolvedValue({ artist: null, albumArtist: null, author: null, album: "Audiobook", title: null });

    const result = await scanAndImportLibrary("audiobook");

    expect(result).toMatchObject({ matched: 2, skipped: 0 });
    const [placeholder] = await parents("audiobook");
    const books = await childrenOf(placeholder.id);
    expect(books.map((b) => b.file_path).sort()).toEqual([first, second].sort());
    expect(books.map((b) => b.title)).toContain("Audiobook");
    expect(books.some((b) => /^Audiobook \((Project Hail Mary|The Martian)\)$/.test(b.title))).toBe(true);
  });

  it("leaves a loose copy of a book that already has a file alone", async () => {
    const folder = await insertRootFolder("audiobook");
    const authorId = await insertItem("audiobook", "Brandon Sanderson");
    await db
      .prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, 'Elantris', 1, 1, '/audiobooks/Brandon Sanderson/Elantris')`)
      .run(authorId);
    writeFile(folder.path, "Brandon Sanderson - Elantris.m4b");

    const result = await scanAndImportLibrary("audiobook");

    expect(result.skipped).toBe(1);
    expect(result.skippedFiles[0].reason).toContain("already has a file");
    const tracks = (await db.prepare("SELECT t.* FROM tracks t JOIN sub_items s ON s.id = t.sub_item_id WHERE s.media_item_id = ?").all(authorId)) as any[];
    expect(tracks).toHaveLength(0);
  });
});

describe("Types whose loose root files stay skipped say how to fix it", () => {
  it("music: points at an Artist/Album/ folder", async () => {
    const folder = await insertRootFolder("artist");
    writeFile(folder.path, "01 - Song.mp3");

    const result = await scanAndImportLibrary("artist");

    expect(result).toMatchObject({ matched: 0, skipped: 1 });
    expect(result.skippedFiles[0].reason).toContain('"Artist/Album/" folder');
    expect(await parents("artist")).toHaveLength(0);
  });

  it("online videos: points at a channel folder", async () => {
    const folder = await insertRootFolder("video");
    writeFile(folder.path, "clip.mp4");

    const result = await scanAndImportLibrary("video");

    expect(result.skipped).toBe(1);
    expect(result.skippedFiles[0].reason).toContain("channel");
  });
});

describe("Per-item Scan & Import picks up loose root files for that item", () => {
  it("imports a loose file whose derived author is the item, and leaves other loose files alone", async () => {
    const folder = await insertRootFolder("author");
    const authorId = await insertItem("author", "Stephen King");
    const file = writeFile(folder.path, "Stephen King - The Stand.epub");
    writeFile(folder.path, "Other Person - Other Book.epub");

    const result = await scanAndImportOneMediaItem(authorId);

    expect(result.matched).toBe(1);
    expect(await childrenOf(authorId)).toMatchObject([{ title: "The Stand", file_path: file }]);
    expect((await parents("author")).map((a) => a.title)).toEqual(["Stephen King"]);
  });

  it("never files a loose book whose own name gives another author under an item that only loosely matches it", async () => {
    const folder = await insertRootFolder("author");
    const kingId = await insertItem("author", "King");
    writeFile(folder.path, "Stephen King - It.epub");
    writeEpub(path.join(folder.path, "stand.epub"), { title: "The Stand", creators: [{ name: "Stephen King" }] });
    const own = writeFile(folder.path, "King - Our Book.epub");

    const result = await scanAndImportOneMediaItem(kingId);

    expect(result).toMatchObject({ matched: 1, created: 0 });
    expect(await childrenOf(kingId)).toMatchObject([{ title: "Our Book", file_path: own }]);
    expect((await parents("author")).map((a) => a.title)).toEqual(["King"]);
  });

  it("works for the Unknown Author placeholder too", async () => {
    const folder = await insertRootFolder("author");
    writeFile(folder.path, "first.epub");
    await scanAndImportLibrary("author");
    const [placeholder] = await parents("author");
    writeFile(folder.path, "second.epub");
    writeFile(folder.path, "Known Writer - Known Book.epub");

    const result = await scanAndImportOneMediaItem(placeholder.id);

    expect(result.matched).toBe(1);
    expect((await childrenOf(placeholder.id)).map((c) => c.title)).toEqual(["first", "second"]);
    expect((await parents("author")).map((a) => a.title)).toEqual(["Unknown Author"]);
  });

  it("never files unidentified books for a real item whose title is a word of the placeholder's", async () => {
    const folder = await insertRootFolder("author");
    const unknownId = await insertItem("author", "Unknown", { openlibrary: "OL9A" });
    writeFile(folder.path, "zzz.epub");
    writeFile(path.join(folder.path, "Unknown Author"), "yyy.epub");

    const result = await scanAndImportOneMediaItem(unknownId);

    expect(result).toMatchObject({ matched: 0, created: 0 });
    expect((await parents("author")).map((a) => a.title)).toEqual(["Unknown"]);
    expect(await childrenOf(unknownId)).toHaveLength(0);
  });

  it("a placeholder's per-item scan only takes its own root folder's unidentified books", async () => {
    const a = await insertRootFolder("author", "books-a");
    const b = await insertRootFolder("author", "books-b");
    writeFile(a.path, "first.epub");
    await scanAndImportLibrary("author");
    const [placeholderA] = await parents("author");
    writeFile(a.path, "second.epub");
    writeFile(b.path, "elsewhere.epub");

    const result = await scanAndImportOneMediaItem(placeholderA.id);

    expect(result.matched).toBe(1);
    expect((await childrenOf(placeholderA.id)).map((c) => c.title)).toEqual(["first", "second"]);
    expect(await parents("author")).toHaveLength(1);
    expect(placeholderA.root_folder_id).toBe(a.id);
  });
});

describe("Each root folder has its own placeholder parent", () => {
  it("files each root's unidentified books under that root's own Unknown Author, which Organize & Rename keeps in that root", async () => {
    const a = await insertRootFolder("author", "books-a");
    const b = await insertRootFolder("author", "books-b");
    const one = writeFile(a.path, "one.epub");
    const other = writeFile(b.path, "other.epub");

    await scanAndImportLibrary("author");
    writeFile(a.path, "two.epub");
    writeFile(path.join(b.path, "Unknown Author"), "three.epub");
    await scanAndImportLibrary("author");

    const all = await parents("author");
    expect(all).toHaveLength(2);
    const inA = all.find((p) => p.root_folder_id === a.id);
    const inB = all.find((p) => p.root_folder_id === b.id);
    expect(inA).toMatchObject({ title: "Unknown Author", monitored: 0 });
    expect(inB).toMatchObject({ title: "Unknown Author", monitored: 0 });
    expect((await childrenOf(inA.id)).map((c) => c.title)).toEqual(["one", "two"]);
    expect((await childrenOf(inB.id)).map((c) => c.title)).toEqual(["other", "three"]);
    expect((await childrenOf(inA.id))[0].file_path).toBe(one);
    expect((await childrenOf(inB.id))[0].file_path).toBe(other);

    const { renameOneMediaItem } = await import("../src/services/importer.js");
    const preview = await renameOneMediaItem(inB.id, undefined, true);
    expect(preview.errors).toEqual([]);
    expect(preview.renamed.length).toBeGreaterThan(0);
    for (const move of preview.renamed) expect(move.to.startsWith(b.path + path.sep)).toBe(true);
  });
});

describe("splitAuthorTitleFilename", () => {
  it("splits on the first dash and cleans the title half", () => {
    expect(splitAuthorTitleFilename("Stephen King - The Dark Tower - The Gunslinger")).toEqual({
      author: "Stephen King",
      title: "The Dark Tower - The Gunslinger",
    });
    expect(splitAuthorTitleFilename("J.R.R. Tolkien – The Hobbit (1937)")).toEqual({ author: "J.R.R. Tolkien", title: "The Hobbit" });
    expect(splitAuthorTitleFilename("Stephen_King_-_Carrie")).toEqual({ author: "Stephen King", title: "Carrie" });
    expect(splitAuthorTitleFilename("._Stephen King - It")).toEqual({ author: "Stephen King", title: "It" });
  });

  it("rejects numbering on the author side and anything without both halves", () => {
    expect(splitAuthorTitleFilename("01 - Chapter One")).toBeNull();
    expect(splitAuthorTitleFilename("Book 3 - The End")).toBeNull();
    expect(splitAuthorTitleFilename("Just A Title")).toBeNull();
    expect(splitAuthorTitleFilename("Unknown - Something")).toBeNull();
  });
});
