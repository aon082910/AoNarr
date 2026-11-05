import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";
import { chooseFilePerBook, matchBookFiles, type BookFile, type MatchableBook } from "../src/services/bookCollectionImport.js";

const notifyImported = vi.fn();
const notifyManualInteractionRequired = vi.fn();
vi.mock("../src/services/notifications.js", () => ({
  notifyImported: (...args: unknown[]) => notifyImported(...args),
  notifyUpgraded: vi.fn(),
  notifyManualInteractionRequired: (...args: unknown[]) => notifyManualInteractionRequired(...args),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
}));

const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

const removeQueueItemDownload = vi.fn();
const markDownloadImported = vi.fn();
vi.mock("../src/services/downloadClient.js", () => ({
  removeQueueItemDownload: (...args: unknown[]) => removeQueueItemDownload(...args),
  markDownloadImported: (...args: unknown[]) => markDownloadImported(...args),
}));

vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));

// ---- The matching of files to books (pure) -----------------------------------------------------------------------------

function mb(id: number, title: string, extra: Partial<MatchableBook> = {}): MatchableBook {
  return { id, title, seriesName: null, seriesPosition: null, target: true, ...extra };
}

function bookFile(name: string, ext = ".epub", extra: Partial<BookFile> = {}): BookFile {
  return { path: `/dl/release/${name}${ext}`, name, ext, size: 1000, folder: null, ...extra };
}

const PRATCHETT = [
  mb(1, "The Colour of Magic (Discworld, #1)", { seriesName: "Discworld", seriesPosition: 1 }),
  mb(2, "The Light Fantastic", { seriesName: "Discworld", seriesPosition: 2 }),
  mb(3, "Mort", { seriesName: "Discworld", seriesPosition: 4 }),
  mb(4, "Guards! Guards!", { seriesName: "Discworld", seriesPosition: 8 }),
  mb(5, "Good Omens"),
  mb(6, "Nation"),
];

function matched(files: BookFile[], author: string, books: MatchableBook[]): Record<string, number | string> {
  const result = matchBookFiles(files, author, books);
  return Object.fromEntries(files.map((file) => {
    const m = result.get(file.path)!;
    return [file.name, m.kind === "book" ? m.bookId : m.kind];
  }));
}

describe("telling the files of a collection apart", () => {
  it.each([
    ["Terry Pratchett - Discworld 01 - The Colour of Magic (1983)", 1],
    ["Terry Pratchett - Discworld #1 - The Colour of Magic", 1],
    ["Discworld 01 - The Colour of Magic", 1],
    ["Discworld 01 The Colour of Magic", 1],
    ["01 - The Colour of Magic", 1],
    ["01. The Colour of Magic", 1],
    ["Book 1 - The Colour of Magic", 1],
    ["Pratchett, Terry - The Colour of Magic", 1],
    ["The Colour of Magic - Terry Pratchett", 1],
    ["The Colour of Magic by Terry Pratchett", 1],
    ["Terry.Pratchett.The.Colour.of.Magic", 1],
    ["Colour of Magic", 1],
    ["The Colour of Magic (Discworld 1) [retail]", 1],
    ["Pratchett - Mort", 3],
    ["Mort", 3],
    ["Mort (1987)", 3],
    ["Mort 1987", 3],
    ["Discworld 04 - Mort", 3],
    ["Terry Pratchett - Mort - 1987", 3],
    ["Terry Pratchett - Guards! Guards!", 4],
    ["Guards Guards", 4],
    ["Terry Pratchett - The Light Fantastic [EPUB]", 2],
  ])("reads %s as book %s", (name, bookId) => {
    expect(matched([bookFile(name)], "Terry Pratchett", PRATCHETT)[name]).toBe(bookId);
  });

  it.each([
    "Mortimer",
    "Mort Part Two",
    "Mort - A Study Guide",
    "The Colour of Magic Companion",
    "Light Fantastic Summary",
    "Terry Pratchett - Discworld Companion",
    "Terry Pratchett - Nation and Other Stories",
    "Discworld",
    "Terry Pratchett",
    "cover",
    "book",
    "Neil Gaiman - American Gods",
    "The Colour of Magic Light Fantastic",
  ])("leaves %s alone", (name) => {
    expect(matched([bookFile(name)], "Terry Pratchett", PRATCHETT)[name]).toBe("unmatched");
  });

  it("takes a title that is also its series' name, and a title that is a year", () => {
    const dune = [mb(1, "Dune", { seriesName: "Dune", seriesPosition: 1 }), mb(2, "Dune Messiah", { seriesName: "Dune", seriesPosition: 2 })];
    expect(matched([bookFile("Frank Herbert - Dune")], "Frank Herbert", dune)["Frank Herbert - Dune"]).toBe(1);
    expect(matched([bookFile("Dune 02 - Dune Messiah")], "Frank Herbert", dune)["Dune 02 - Dune Messiah"]).toBe(2);
    expect(matched([bookFile("Dune - Dune Messiah")], "Frank Herbert", dune)["Dune - Dune Messiah"]).toBe(2);
    expect(matched([bookFile("Dune Chronicles")], "Frank Herbert", dune)["Dune Chronicles"]).toBe("unmatched");
    const orwell = [mb(1, "1984"), mb(2, "Animal Farm")];
    expect(matched([bookFile("George Orwell - 1984")], "George Orwell", orwell)["George Orwell - 1984"]).toBe(1);
    expect(matched([bookFile("1984 - George Orwell")], "George Orwell", orwell)["1984 - George Orwell"]).toBe(1);
    expect(matched([bookFile("1984")], "George Orwell", orwell)["1984"]).toBe(1);
    expect(matched([bookFile("Orwell - Animal Farm (1945)")], "George Orwell", orwell)["Orwell - Animal Farm (1945)"]).toBe(2);
  });

  it("takes the part of a title before its subtitle only when no other book has it", () => {
    const sapiens = [mb(1, "Sapiens: A Brief History of Humankind"), mb(2, "Homo Deus")];
    expect(matched([bookFile("Yuval Noah Harari - Sapiens")], "Yuval Noah Harari", sapiens)["Yuval Noah Harari - Sapiens"]).toBe(1);
    const twoSapiens = [...sapiens, mb(3, "Sapiens: A Graphic History")];
    expect(matched([bookFile("Yuval Noah Harari - Sapiens")], "Yuval Noah Harari", twoSapiens)["Yuval Noah Harari - Sapiens"]).toBe("unmatched");
    expect(matched([bookFile("Sapiens - A Brief History of Humankind")], "Yuval Noah Harari", twoSapiens)["Sapiens - A Brief History of Humankind"]).toBe(1);
  });

  it("takes a subtitle alone when the part before it is the book's series", () => {
    const mistborn = [
      mb(1, "Mistborn: The Final Empire", { seriesName: "Mistborn", seriesPosition: 1 }),
      mb(2, "Mistborn: The Well of Ascension", { seriesName: "Mistborn", seriesPosition: 2 }),
    ];
    const names = ["Brandon Sanderson - The Final Empire", "Mistborn 2 - The Well of Ascension", "Mistborn"];
    const result = matched(names.map((n) => bookFile(n)), "Brandon Sanderson", mistborn);
    expect(result["Brandon Sanderson - The Final Empire"]).toBe(1);
    expect(result["Mistborn 2 - The Well of Ascension"]).toBe(2);
    expect(result["Mistborn"]).toBe("unmatched");
  });

  it("reads roman and arabic numerals alike", () => {
    expect(matched([bookFile("Final Fantasy 7")], "Author", [mb(1, "Final Fantasy VII")])["Final Fantasy 7"]).toBe(1);
  });

  it("does not choose between two books of one title", () => {
    const result = matchBookFiles([bookFile("Mort")], "Terry Pratchett", [mb(1, "Mort"), mb(2, "Mort")]);
    expect(result.get("/dl/release/Mort.epub")).toMatchObject({ kind: "ambiguous" });
  });

  it("marks whether the book was wanted from the download", () => {
    const result = matchBookFiles([bookFile("Mort")], "Terry Pratchett", [mb(3, "Mort", { target: false })]);
    expect(result.get("/dl/release/Mort.epub")).toEqual({ kind: "book", bookId: 3, target: false });
  });

  it("takes the title from the folder of a book that has one of its own, when its file's name says none", () => {
    const folder = { folder: "Mort (1987)" };
    const result = matchBookFiles([bookFile("book", ".epub", { path: "/dl/release/Mort (1987)/book.epub", ...folder }), bookFile("book", ".mobi", { path: "/dl/release/Mort (1987)/book.mobi", ...folder })], "Terry Pratchett", PRATCHETT);
    expect(result.get("/dl/release/Mort (1987)/book.epub")).toMatchObject({ kind: "book", bookId: 3 });
    expect(result.get("/dl/release/Mort (1987)/book.mobi")).toMatchObject({ kind: "book", bookId: 3 });
    // A folder that holds several works names none of them.
    const shared = { folder: "Mort" };
    const several = matchBookFiles([bookFile("a", ".epub", { path: "/dl/release/Mort/a.epub", ...shared }), bookFile("b", ".epub", { path: "/dl/release/Mort/b.epub", ...shared })], "Terry Pratchett", PRATCHETT);
    expect(several.get("/dl/release/Mort/a.epub")).toMatchObject({ kind: "unmatched" });
  });

  it("prefers the file's own name to its folder's", () => {
    const result = matchBookFiles([bookFile("Mort", ".epub", { path: "/dl/release/Discworld/Mort.epub", folder: "Discworld" })], "Terry Pratchett", PRATCHETT);
    expect(result.get("/dl/release/Discworld/Mort.epub")).toMatchObject({ kind: "book", bookId: 3 });
  });

  it("picks one file per book: the best format, then the larger", () => {
    const files = [
      bookFile("Mort", ".pdf", { size: 9000 }),
      bookFile("Mort", ".mobi", { size: 2000 }),
      bookFile("Mort", ".epub", { size: 500, path: "/dl/release/a/Mort.epub" }),
      bookFile("Mort", ".epub", { size: 800, path: "/dl/release/b/Mort.epub" }),
      bookFile("Nation", ".pdf", { size: 100 }),
    ];
    const chosen = chooseFilePerBook(files, matchBookFiles(files, "Terry Pratchett", PRATCHETT));
    expect(chosen.get(3)!.chosen.path).toBe("/dl/release/b/Mort.epub");
    expect(chosen.get(3)!.others).toHaveLength(3);
    expect(chosen.get(6)!.chosen.ext).toBe(".pdf");
  });
});

// ---- The import -------------------------------------------------------------------------------------------------------------------

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let backoff: typeof import("../src/services/searchBackoff.js");
let scheduler: typeof import("../src/services/scheduler.js");
let downloadsDir: string;
let libraryDir: string;
let rootFolder: { id: number; path: string };

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  backoff = await import("../src/services/searchBackoff.js");
  scheduler = await import("../src/services/scheduler.js");
  downloadsDir = path.join(config.downloadsDir, "test-book-collection");
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "recycle_bin", "queue", "download_clients", "tracks", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  notifyImported.mockReset();
  notifyManualInteractionRequired.mockReset().mockResolvedValue(undefined);
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  removeQueueItemDownload.mockReset().mockResolvedValue(undefined);
  markDownloadImported.mockReset().mockResolvedValue(undefined);
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-bookcollection-library-"));
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("removeCompletedDownloads", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
  const p = path.join(libraryDir, "books");
  fs.mkdirSync(p, { recursive: true });
  rootFolder = { id: Number((await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'author', 'books')").run(p)).lastInsertRowid), path: p };
});

afterEach(() => {
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

const RELEASE = "Terry Pratchett - Complete Collection (Books 1-5) [EPUB]";

function writeBook(release: string, relative: string, content?: string): string {
  const file = path.join(downloadsDir, release, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content ?? `book ${relative}`);
  return file;
}

async function terry(): Promise<{ authorId: number; books: Record<string, number> }> {
  // A library that has files recorded in it holds something: an empty root would read as a share that is not mounted.
  fs.writeFileSync(path.join(rootFolder.path, ".library-in-use"), "");
  const authorId = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author', 'Terry Pratchett', 'terry pratchett', ?, 1, 0, 'missing')")
        .run(rootFolder.id)
    ).lastInsertRowid
  );
  const add = async (title: string, date: string, position: number | null, hasFile = 0) =>
    Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file, series_name, series_position) VALUES (?, ?, ?, 1, ?, ?, ?)")
          .run(authorId, title, date, hasFile, position == null ? null : "Discworld", position)
      ).lastInsertRowid
    );
  return {
    authorId,
    books: {
      colour: await add("The Colour of Magic", "1983-11-24", 1),
      fantastic: await add("The Light Fantastic", "1986-06-01", 2),
      equal: await add("Equal Rites", "1987-10-01", 3),
      mort: await add("Mort", "1987-11-12", 4),
      sourcery: await add("Sourcery", "1988-05-05", 5),
    },
  };
}

async function queueCollection(authorId: number, targets: number[], overrides: { downloadPath?: string | null; title?: string } = {}): Promise<number> {
  const downloadPath = overrides.downloadPath === undefined ? path.join(downloadsDir, RELEASE) : overrides.downloadPath;
  const queueId = Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, download_path, quality, status, grab_source) VALUES (?, ?, ?, NULL, 'completed', 'auto')")
        .run(authorId, overrides.title ?? RELEASE, downloadPath)
    ).lastInsertRowid
  );
  for (const id of targets) await db.prepare("INSERT INTO queue_targets (queue_id, sub_item_id) VALUES (?, ?)").run(queueId, id);
  return queueId;
}

async function bookRow(id: number): Promise<any> {
  return db.prepare("SELECT * FROM sub_items WHERE id = ?").get(id);
}

const queueRow = async (id: number) => db.prepare("SELECT * FROM queue WHERE id = ?").get(id);
const targetsLeft = async (queueId: number) =>
  ((await db.prepare("SELECT sub_item_id FROM queue_targets WHERE queue_id = ? ORDER BY sub_item_id").all(queueId)) as any[]).map((r) => Number(r.sub_item_id));

describe("importing a collection of books", () => {
  it("files each wanted book's file under that book and leaves the rest of the download untouched", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Terry Pratchett - Discworld 01 - The Colour of Magic (1983).epub");
    writeBook(RELEASE, "Terry Pratchett - Discworld 02 - The Light Fantastic (1986).epub");
    writeBook(RELEASE, "Terry Pratchett - Discworld 04 - Mort (1987).epub");
    const extra = writeBook(RELEASE, "Terry Pratchett - Nation (2008).epub");
    const unknown = writeBook(RELEASE, "Terry Pratchett - The Discworld Companion.epub");
    const queueId = await queueCollection(authorId, [books.colour, books.fantastic, books.mort]);

    await importer.importQueueItem(queueId);

    expect(await queueRow(queueId)).toBeUndefined();
    for (const key of ["colour", "fantastic", "mort"] as const) {
      const row = await bookRow(books[key]);
      expect(row.has_file, key).toBe(1);
      expect(row.file_path.startsWith(rootFolder.path), key).toBe(true);
      expect(fs.existsSync(row.file_path), key).toBe(true);
      expect(path.extname(row.file_path), key).toBe(".epub");
      expect(row.file_release_title).toBe(RELEASE);
    }
    expect(path.basename((await bookRow(books.mort)).file_path)).toContain("Mort");
    // Not wanted from this download: untouched, and so is a file that is no book of the author's.
    expect((await bookRow(books.equal)).has_file).toBe(0);
    expect(fs.existsSync(extra)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
    const imported = (await db.prepare("SELECT data FROM history WHERE event_type = 'imported'").all()) as any[];
    expect(imported.map((h) => JSON.parse(h.data).subItemId).sort()).toEqual([books.colour, books.fantastic, books.mort].sort());
    expect(notifyImported).toHaveBeenCalledTimes(3);
  });

  it("keeps the download in the client when files of it are left, and lets it go when only another format of an imported book is", async () => {
    setSetting("removeCompletedDownloads", "1");
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort.epub");
    writeBook(RELEASE, "Mort.mobi");
    writeBook(RELEASE, "Mort.pdf");
    const left = writeBook(RELEASE, "Nation.epub");
    const first = await queueCollection(authorId, [books.mort]);

    await importer.importQueueItem(first);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
    expect(fs.existsSync(left)).toBe(true);

    removeQueueItemDownload.mockClear();
    fs.rmSync(left);
    const secondTitle = "Terry Pratchett - Complete Collection (Books 6-9) [EPUB]";
    const second = await queueCollection(authorId, [books.fantastic], { title: secondTitle, downloadPath: path.join(downloadsDir, secondTitle) });
    writeBook(secondTitle, "The Light Fantastic.epub");
    writeBook(secondTitle, "The Light Fantastic.pdf");
    await importer.importQueueItem(second);
    expect(removeQueueItemDownload).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(true);
  });

  it("places the best format of a book that comes in several, and never the others", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort.pdf");
    writeBook(RELEASE, "Mort.mobi");
    writeBook(RELEASE, "Mort.epub");
    const queueId = await queueCollection(authorId, [books.mort]);

    await importer.importQueueItem(queueId);

    expect(path.extname((await bookRow(books.mort)).file_path)).toBe(".epub");
    expect(notifyImported).toHaveBeenCalledTimes(1);
  });

  it("files a book that has a folder of its own, named by the folder when the file is not", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort (1987)/book.epub");
    writeBook(RELEASE, "Mort (1987)/cover.jpg");
    writeBook(RELEASE, "Discworld/Equal Rites.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal]);

    await importer.importQueueItem(queueId);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect((await bookRow(books.equal)).has_file).toBe(1);
  });

  it("matches strictly: a name that merely contains a title is not that book", async () => {
    setSetting("removeCompletedDownloads", "1");
    const { authorId, books } = await terry();
    const near = [writeBook(RELEASE, "Mortimer.epub"), writeBook(RELEASE, "Mort - A Study Guide.epub"), writeBook(RELEASE, "Sourcery Summary.epub")];
    writeBook(RELEASE, "Mort.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.sourcery]);

    await importer.importQueueItem(queueId);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect((await bookRow(books.sourcery)).has_file).toBe(0);
    for (const file of near) expect(fs.existsSync(file)).toBe(true);
    // The one book it did not hold is searched on its own; the release is not held against the others it filled.
    expect(removeQueueItemDownload.mock.calls[0][1]).toBe(false);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
  });

  it("settles a book the release did not hold without blocklisting it: the book is woken and the row goes", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort.epub");
    writeBook(RELEASE, "The Light Fantastic.epub");
    await db.prepare("UPDATE sub_items SET auto_search_misses = 5").run();
    await backoff.recordSeasonSearch(authorId, -2, false);
    const queueId = await queueCollection(authorId, [books.mort, books.fantastic, books.sourcery]);

    await importer.importQueueItem(queueId);

    expect(await queueRow(queueId)).toBeUndefined();
    expect(await targetsLeft(queueId)).toEqual([]);
    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect((await bookRow(books.fantastic)).has_file).toBe(1);
    const sourcery = await bookRow(books.sourcery);
    expect(sourcery.has_file).toBe(0);
    expect(Number(sourcery.auto_search_misses)).toBe(0);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
  });

  it("leaves the row and its books when no file is a wanted book, and blocklists nothing", async () => {
    const { authorId, books } = await terry();
    const file = writeBook(RELEASE, "Neil Gaiman - American Gods.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.sourcery]);

    await expect(importer.importQueueItem(queueId)).rejects.toThrow(/No book of .* could be imported/);

    expect(await queueRow(queueId)).toBeDefined();
    expect(await targetsLeft(queueId)).toEqual([books.mort, books.sourcery].sort((a, b) => a - b));
    expect(fs.existsSync(file)).toBe(true);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
  });

  it("parks the row, and holds the book, when a book's file is found and cannot be placed", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort.epub");
    writeBook(RELEASE, "The Light Fantastic.epub");
    // The place the file would go is taken by a folder.
    fs.mkdirSync(path.join(rootFolder.path, "Terry Pratchett", "Mort.epub"), { recursive: true });
    fs.writeFileSync(path.join(rootFolder.path, "Terry Pratchett", "Mort.epub", "keep"), "x");
    const queueId = await queueCollection(authorId, [books.mort, books.fantastic]);

    await expect(importer.importQueueItem(queueId)).rejects.toThrow(/Imported 1 book\(s\).*1 could not be placed/);

    expect((await bookRow(books.fantastic)).has_file).toBe(1);
    expect((await bookRow(books.mort)).has_file).toBe(0);
    expect(await queueRow(queueId)).toBeDefined();
    expect(await targetsLeft(queueId)).toEqual([books.mort]);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "Mort.epub"))).toBe(true);
    expect(await scheduler.isAlreadyQueued(authorId, null, books.mort)).toBe(true);
  });

  it("does not replace a book that gained a file in a better format while the collection downloaded", async () => {
    const { authorId, books } = await terry();
    const existing = path.join(rootFolder.path, "Terry Pratchett", "Mort.epub");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "the library's own copy");
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = 'Unknown' WHERE id = ?").run(existing, books.mort);
    writeBook(RELEASE, "Mort.pdf");
    writeBook(RELEASE, "The Light Fantastic.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.fantastic]);

    await importer.importQueueItem(queueId);

    expect(fs.readFileSync(existing, "utf8")).toBe("the library's own copy");
    expect((await bookRow(books.mort)).file_path).toBe(existing);
    expect((await bookRow(books.fantastic)).has_file).toBe(1);
    expect(await queueRow(queueId)).toBeUndefined();
    // The pdf was not wanted: it stays.
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "Mort.pdf"))).toBe(true);
  });

  it("never puts a book that is not wanted over the library's, even in a better format", async () => {
    const { authorId, books } = await terry();
    const existing = path.join(rootFolder.path, "Terry Pratchett", "Mort.pdf");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "pdf copy");
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ? WHERE id = ?").run(existing, books.mort);
    writeBook(RELEASE, "Mort.epub");
    writeBook(RELEASE, "Equal Rites.epub");
    const queueId = await queueCollection(authorId, [books.equal]);

    await importer.importQueueItem(queueId);

    expect(fs.readFileSync(existing, "utf8")).toBe("pdf copy");
    expect((await bookRow(books.mort)).file_path).toBe(existing);
    expect(fs.existsSync(path.join(downloadsDir, RELEASE, "Mort.epub"))).toBe(true);
  });

  it("keeps seeding when the strategy is hardlink: the download stays whole and is marked imported", async () => {
    setSetting("importStrategy", "hardlink");
    const { authorId, books } = await terry();
    const source = writeBook(RELEASE, "Mort.epub");
    writeBook(RELEASE, "Equal Rites.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal]);

    await importer.importQueueItem(queueId);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect(fs.existsSync(source)).toBe(true);
    expect(markDownloadImported).toHaveBeenCalledTimes(1);
    expect(removeQueueItemDownload).not.toHaveBeenCalled();
  });

  it("finds the folder of the collection itself when the client reported none", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort.epub");
    writeBook(RELEASE, "Equal Rites.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal], { downloadPath: null });

    await importer.importQueueItem(queueId);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect((await bookRow(books.equal)).has_file).toBe(1);
  });

  it("does not take books from a folder shared with other downloads, and takes them by hand", async () => {
    const { authorId, books } = await terry();
    writeBook("Some Other Stuff", "Mort.epub");
    writeBook("Some Other Stuff", "Equal Rites.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal], { downloadPath: path.join(downloadsDir, "Some Other Stuff") });

    await expect(importer.importQueueItem(queueId)).rejects.toThrow(/shared with other downloads/);
    expect((await bookRow(books.mort)).has_file).toBe(0);

    await importer.importQueueItem(queueId, path.join(downloadsDir, "Some Other Stuff", "Mort.epub"));
    expect((await bookRow(books.mort)).has_file).toBe(1);
  });

  it("says so when none of the books it was for is left", async () => {
    const { authorId, books } = await terry();
    writeBook(RELEASE, "Mort.epub");
    const queueId = await queueCollection(authorId, [books.mort]);
    await db.prepare("DELETE FROM sub_items WHERE id = ?").run(books.mort);

    await expect(importer.importQueueItem(queueId)).rejects.toThrow(/none of the books it was for is left/);
  });

  it("clears the row of a collection a restart cut off after its books were filed", async () => {
    const { authorId, books } = await terry();
    const queueId = await queueCollection(authorId, [books.mort, books.equal]);
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = '/x/y.epub', file_release_title = ? WHERE id IN (?, ?)").run(RELEASE, books.mort, books.equal);
    fs.mkdirSync(path.join(downloadsDir, RELEASE), { recursive: true });

    await importer.importQueueItem(queueId);

    expect(await queueRow(queueId)).toBeUndefined();
  });
});

describe("importing one file of a collection by hand", () => {
  it("imports the book the file is, keeps the row for the rest, and finishes when the last is done", async () => {
    const { authorId, books } = await terry();
    const mort = writeBook(RELEASE, "Mort.epub");
    const equal = writeBook(RELEASE, "Equal Rites.epub");
    const other = writeBook(RELEASE, "Sourcery.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal, books.sourcery]);
    await db.prepare("UPDATE queue SET import_started_at = CURRENT_TIMESTAMP, import_resume_state = 3 WHERE id = ?").run(queueId);

    await importer.importQueueItem(queueId, mort);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect((await bookRow(books.equal)).has_file).toBe(0);
    expect(fs.existsSync(equal)).toBe(true);
    const row = (await queueRow(queueId)) as any;
    expect(row).toBeDefined();
    expect(await targetsLeft(queueId)).toEqual([books.equal, books.sourcery].sort((a, b) => a - b));
    // Parked like any import left for the admin: not "importing", and with the reason.
    expect(row.import_started_at).toBeNull();
    expect(row.import_skipped_reason).toMatch(/2 book\(s\) of .* are still to be imported/);
    expect(Number(row.import_resume_state)).toBe(0);

    await importer.importQueueItem(queueId, equal);
    expect(await targetsLeft(queueId)).toEqual([books.sourcery]);
    await importer.importQueueItem(queueId, other);
    expect(await queueRow(queueId)).toBeUndefined();
    expect((await bookRow(books.sourcery)).has_file).toBe(1);
  });

  it("previews it as books filed when the download is imported, not as an error", async () => {
    const { authorId, books } = await terry();
    const mort = writeBook(RELEASE, "Mort.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal]);

    const preview = await importer.previewQueueManualImport(queueId, mort);

    expect(preview.error).toBeUndefined();
    expect(preview.note).toMatch(/books this download holds are filed when it is imported/);
    expect(fs.existsSync(mort)).toBe(true);
  });

  it("takes a file whose name says no book for the one book left", async () => {
    const { authorId, books } = await terry();
    const odd = writeBook(RELEASE, "Terry Pratchett - Collection - Part 7.epub");
    const queueId = await queueCollection(authorId, [books.mort]);

    await importer.importQueueItem(queueId, odd);

    expect((await bookRow(books.mort)).has_file).toBe(1);
    expect(await queueRow(queueId)).toBeUndefined();
  });

  it("does not guess among several books for a file whose name says none", async () => {
    const { authorId, books } = await terry();
    const odd = writeBook(RELEASE, "Terry Pratchett - Collection - Part 7.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.sourcery]);

    await expect(importer.importQueueItem(queueId, odd)).rejects.toThrow(/No book of .* could be imported/);

    expect((await bookRow(books.mort)).has_file).toBe(0);
    expect(await targetsLeft(queueId)).toEqual([books.mort, books.sourcery].sort((a, b) => a - b));
  });

  it("trusts the folder the file is in, whatever it is called, but not the downloads folder itself", async () => {
    const { authorId, books } = await terry();
    const mort = writeBook("pratchett-stuff", "Mort.epub");
    writeBook("pratchett-stuff", "Equal Rites.epub");
    const queueId = await queueCollection(authorId, [books.mort, books.equal], { downloadPath: path.join(downloadsDir, "pratchett-stuff") });

    await importer.importQueueItem(queueId, mort);
    expect((await bookRow(books.mort)).has_file).toBe(1);

    const loose = path.join(config.downloadsDir, "Equal Rites.epub");
    fs.writeFileSync(loose, "loose");
    try {
      await db.prepare("UPDATE queue SET download_path = ? WHERE id = ?").run(config.downloadsDir, queueId);
      await expect(importer.importQueueItem(queueId, loose)).rejects.toThrow(/shared with other downloads/);
    } finally {
      fs.rmSync(loose, { force: true });
    }
  });

  it("replaces a file the admin picked a book's file for, in any format, since the pick is the admin's", async () => {
    const { authorId, books } = await terry();
    const existing = path.join(rootFolder.path, "Terry Pratchett", "Mort.epub");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "old epub");
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ?, quality = 'Unknown' WHERE id = ?").run(existing, books.mort);
    const pdf = writeBook(RELEASE, "Mort.pdf", "new pdf");
    const queueId = await queueCollection(authorId, [books.mort]);

    await importer.importQueueItem(queueId, pdf);

    const row = await bookRow(books.mort);
    expect(row.has_file).toBe(1);
    expect(path.extname(row.file_path)).toBe(".pdf");
  });
});
