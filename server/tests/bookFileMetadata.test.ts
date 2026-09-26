import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildMobi, writeEpub } from "./helpers/bookFixtures.js";

const pdfParse = vi.fn();
vi.mock("pdf-parse", () => ({ default: (...args: unknown[]) => pdfParse(...args) }));

import {
  cleanEmbeddedAuthor,
  cleanPdfAuthor,
  cleanPdfTitle,
  firstAuthor,
  MAX_EMBEDDED_READ_BYTES,
  parseMobiMetadata,
  PDF_INFO_TIMEOUT_MS,
  readBookFileMetadata,
  readEpubPackage,
} from "../src/services/bookFileMetadata.js";

const REAL_ISBN_13 = "9780132350884";

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-bookmeta-"));
});
beforeEach(() => {
  pdfParse.mockReset();
});

describe("firstAuthor", () => {
  it("keeps a single author as-is", () => {
    expect(firstAuthor("J.R.R. Tolkien")).toBe("J.R.R. Tolkien");
  });

  it("takes the first of several authors joined by &, ;, 'and' or /", () => {
    expect(firstAuthor("Terry Pratchett & Neil Gaiman")).toBe("Terry Pratchett");
    expect(firstAuthor("Terry Pratchett; Neil Gaiman")).toBe("Terry Pratchett");
    expect(firstAuthor("Stephen King and Owen King")).toBe("Stephen King");
    expect(firstAuthor("Stephen King/Owen King")).toBe("Stephen King");
  });

  it("splits a comma list of display-order names, taking the first", () => {
    expect(firstAuthor("Neil Gaiman, Terry Pratchett")).toBe("Neil Gaiman");
    expect(firstAuthor("Stephen King, Owen King")).toBe("Stephen King");
    expect(firstAuthor("Terry Pratchett, J.R.R. Tolkien")).toBe("Terry Pratchett");
    expect(firstAuthor("Neil Gaiman, Terry Pratchett, Someone Else")).toBe("Neil Gaiman");
  });

  it("inverts a sort-order 'Last, First' name, keeping multi-word surnames whole", () => {
    expect(firstAuthor("Le Guin, Ursula K.")).toBe("Ursula K. Le Guin");
    expect(firstAuthor("King, Stephen")).toBe("Stephen King");
    expect(firstAuthor("De Camp, L. Sprague")).toBe("L. Sprague De Camp");
    expect(firstAuthor("Van Vogt, A. E.")).toBe("A. E. Van Vogt");
    expect(firstAuthor("du Maurier, Daphne")).toBe("Daphne du Maurier");
    expect(firstAuthor("Garcia Marquez, Gabriel")).toBe("Gabriel Garcia Marquez");
    expect(firstAuthor("Tolkien, J.R.R.")).toBe("J.R.R. Tolkien");
    expect(firstAuthor("King, Stephen (Author)")).toBe("Stephen King");
    expect(firstAuthor("King, Stephen & Straub, Peter")).toBe("Stephen King");
    expect(firstAuthor("Gaiman, Neil, Pratchett, Terry")).toBe("Neil Gaiman");
    expect(firstAuthor("Dumas, Alexandre, 1802-1870")).toBe("Alexandre Dumas");
  });

  it("keeps a name whose part after the comma is a suffix", () => {
    expect(firstAuthor("Martin Luther King, Jr.")).toBe("Martin Luther King, Jr.");
    expect(firstAuthor("Harry Connick, Jr")).toBe("Harry Connick, Jr");
  });

  it("never starts a name with leftover punctuation (a macOS '._' companion's name)", () => {
    expect(firstAuthor(". Stephen King")).toBe("Stephen King");
    expect(firstAuthor("._Stephen King")).toBe("Stephen King");
    expect(firstAuthor("- Frank Herbert")).toBe("Frank Herbert");
    expect(firstAuthor("J.R.R. Tolkien")).toBe("J.R.R. Tolkien");
  });

  it("drops a trailing role and rejects placeholders or letterless values", () => {
    expect(firstAuthor("Stephen King (Author)")).toBe("Stephen King");
    expect(firstAuthor("Unknown")).toBeNull();
    expect(firstAuthor("Unknown Artist")).toBeNull();
    expect(firstAuthor("Various Artists")).toBeNull();
    expect(firstAuthor("01")).toBeNull();
    expect(firstAuthor("  ")).toBeNull();
    expect(firstAuthor(null)).toBeNull();
  });
});

describe("readEpubPackage / readBookFileMetadata — EPUB", () => {
  it("reads title, the first credited author and the ISBN from the OPF container.xml points at", async () => {
    const file = writeEpub(path.join(tmpDir, "whatever-name.epub"), {
      title: "Good Omens",
      creators: [
        { name: "Some Illustrator", role: "ill" },
        { name: "Terry Pratchett", role: "aut" },
        { name: "Neil Gaiman", role: "aut" },
      ],
      identifiers: ["urn:uuid:1234-5678", `urn:isbn:${REAL_ISBN_13}`],
      opfPath: "content/package.opf",
    });

    const pkg = await readEpubPackage(file);
    expect(pkg?.creators.map((c) => c.name)).toEqual(["Some Illustrator", "Terry Pratchett", "Neil Gaiman"]);

    expect(await readBookFileMetadata(file)).toEqual({ title: "Good Omens", author: "Terry Pratchett", isbn: REAL_ISBN_13 });
  });

  it("uses the first creator when none declares a role, splitting 'A & B'", async () => {
    const file = writeEpub(path.join(tmpDir, "norole.epub"), { title: "Good Omens", creators: [{ name: "Terry Pratchett & Neil Gaiman" }] });
    expect(await readBookFileMetadata(file)).toMatchObject({ title: "Good Omens", author: "Terry Pratchett", isbn: null });
  });

  it("treats Calibre's 'Unknown' title/author as absent", async () => {
    const file = writeEpub(path.join(tmpDir, "unknown.epub"), { title: "Unknown", creators: [{ name: "Unknown" }] });
    expect(await readBookFileMetadata(file)).toEqual({ title: null, author: null, isbn: null });
  });

  it("returns null (never throws) for a file that isn't a zip at all", async () => {
    const file = path.join(tmpDir, "garbage.epub");
    fs.writeFileSync(file, "definitely not a zip");
    await expect(readBookFileMetadata(file)).resolves.toBeNull();
  });
});

describe("parseMobiMetadata", () => {
  it("reads author (EXTH 100), updated title (EXTH 503) and ISBN (EXTH 104)", () => {
    const buf = buildMobi({
      palmName: "The_Stand",
      fullName: "The Stand",
      exth: [
        { type: 100, value: "Stephen King" },
        { type: 104, value: `978-0-13-235088-4` },
        { type: 503, value: "The Stand: Complete & Uncut" },
      ],
    });
    expect(parseMobiMetadata(buf)).toEqual({ title: "The Stand: Complete & Uncut", author: "Stephen King", isbn: REAL_ISBN_13 });
  });

  it("uses the first of several EXTH 100 authors", () => {
    const buf = buildMobi({ fullName: "Good Omens", exth: [{ type: 100, value: "Terry Pratchett" }, { type: 100, value: "Neil Gaiman" }] });
    expect(parseMobiMetadata(buf)?.author).toBe("Terry Pratchett");
  });

  it("falls back to the MOBI full name, then the PalmDB name, for the title", () => {
    expect(parseMobiMetadata(buildMobi({ palmName: "Short_Name", fullName: "The Full Name" }))?.title).toBe("The Full Name");
    expect(parseMobiMetadata(buildMobi({ palmName: "Short_Name" }))).toEqual({ title: "Short Name", author: null, isbn: null });
  });

  it("decodes a Latin-1 (CP1252) header", () => {
    const buf = buildMobi({ fullName: "Café Society", exth: [{ type: 100, value: "José Saramago" }], latin1: true });
    expect(parseMobiMetadata(buf)).toMatchObject({ title: "Café Society", author: "José Saramago" });
  });

  it("decodes CP1252's curly quotes and dashes rather than leaving C1 control characters", () => {
    const cp1252 = (...parts: (string | number)[]) =>
      Buffer.concat(parts.map((p) => (typeof p === "number" ? Buffer.from([p]) : Buffer.from(p, "latin1"))));
    const buf = buildMobi({
      fullName: cp1252("Don", 0x92, "t Panic ", 0x96, " ", 0x93, "Guide", 0x94),
      exth: [{ type: 100, value: cp1252("Douglas Adams", 0x81) }],
      latin1: true,
    });
    const meta = parseMobiMetadata(buf);
    expect(meta?.title).toBe("Don\u2019t Panic \u2013 \u201CGuide\u201D");
    expect(meta?.author).toBe("Douglas Adams");
    expect(meta?.title).not.toMatch(/[\u0080-\u009f]/);
  });

  it("returns null for something that isn't a MOBI/PalmDOC file", () => {
    expect(parseMobiMetadata(Buffer.from("fake mobi content"))).toBeNull();
    expect(parseMobiMetadata(buildMobi({ typeCreator: "SOMETHIN" }))).toBeNull();
  });

  it("never throws on a buffer truncated at any length", () => {
    const full = buildMobi({
      palmName: "Truncated",
      fullName: "Truncated Book",
      exth: [
        { type: 100, value: "Some Author" },
        { type: 503, value: "Truncated Book Updated" },
      ],
    });
    for (let length = 0; length <= full.length; length++) {
      expect(() => parseMobiMetadata(full.subarray(0, length))).not.toThrow();
    }
  });

  it("never throws on corrupted header fields (huge offsets/lengths/record counts)", () => {
    const base = buildMobi({ fullName: "Corrupt", exth: [{ type: 100, value: "Someone" }] });
    const mobiStart = base.readUInt32BE(78) + 16;
    for (const offset of [76, 78, 86, mobiStart + 4, mobiStart + 0x44, mobiStart + 0x48, mobiStart + 0x70]) {
      for (const value of [0, 1, 0x7fffffff, 0xffffffff]) {
        const buf = Buffer.from(base);
        if (offset === 76) buf.writeUInt16BE(value & 0xffff, offset);
        else buf.writeUInt32BE(value >>> 0, offset);
        expect(() => parseMobiMetadata(buf)).not.toThrow();
      }
    }
    const exthStart = mobiStart + 232;
    for (const offset of [exthStart + 4, exthStart + 8, exthStart + 12, exthStart + 16]) {
      const buf = Buffer.from(base);
      buf.writeUInt32BE(0xffffffff, offset);
      expect(() => parseMobiMetadata(buf)).not.toThrow();
    }
  });

  it("is what readBookFileMetadata uses for .mobi/.azw3 files on disk", async () => {
    const file = path.join(tmpDir, "book.azw3");
    fs.writeFileSync(file, buildMobi({ fullName: "Mistborn", exth: [{ type: 100, value: "Brandon Sanderson" }] }));
    expect(await readBookFileMetadata(file)).toEqual({ title: "Mistborn", author: "Brandon Sanderson", isbn: null });
  });
});

describe("PDF info", () => {
  it("rejects placeholder/login/software authors", () => {
    for (const junk of ["", "  ", "unknown", "Admin", "Administrator", "user", "Microsoft Word", "Microsoft Office User", "Adobe Acrobat Pro", "calibre (6.2.1)", "LaTeX with hyperref", "pdfTeX-1.40.21", "jdoe@example.com"]) {
      expect(cleanPdfAuthor(junk)).toBeNull();
    }
    expect(cleanPdfAuthor(undefined)).toBeNull();
  });

  it("keeps a real author, first of several", () => {
    expect(cleanPdfAuthor("Robert C. Martin")).toBe("Robert C. Martin");
    expect(cleanPdfAuthor("Tex Avery")).toBe("Tex Avery");
    expect(cleanPdfAuthor("Harold Abelson and Gerald Jay Sussman")).toBe("Harold Abelson");
  });

  it("rejects default account, login and PC-maker names", () => {
    for (const junk of [
      "Windows User",
      "User1",
      "Microsoft Office User",
      "Default User",
      "Lenovo User",
      "HP",
      "hp",
      "Dell",
      "Dell Inc.",
      "Apple Inc.",
      "Hewlett-Packard",
      "pc",
      "Home PC",
      "Customer",
      "Valued Customer",
      "Owner",
      "Owner1",
      "admin1",
      "HP_Administrator",
      "jsmith42",
      "Your Name",
      "n/a",
    ]) {
      expect(cleanEmbeddedAuthor(junk), junk).toBeNull();
    }
  });

  it("keeps real names that merely share a word with a default account name", () => {
    expect(cleanEmbeddedAuthor("Mac Barnett")).toBe("Mac Barnett");
    expect(cleanEmbeddedAuthor("H.P. Lovecraft")).toBe("H.P. Lovecraft");
    expect(cleanEmbeddedAuthor("HP Lovecraft")).toBe("HP Lovecraft");
    expect(cleanEmbeddedAuthor("Jean-Paul Sartre")).toBe("Jean-Paul Sartre");
    expect(cleanEmbeddedAuthor("Sony Labou Tansi")).toBe("Sony Labou Tansi");
    expect(cleanEmbeddedAuthor("莫言")).toBe("莫言");
  });

  it("applies the same filter to EPUB creators and MOBI EXTH authors", async () => {
    const wordExport = writeEpub(path.join(tmpDir, "word-export.epub"), { title: "Field Notes", creators: [{ name: "Windows User" }] });
    expect(await readBookFileMetadata(wordExport)).toMatchObject({ title: "Field Notes", author: null });
    const withReal = writeEpub(path.join(tmpDir, "word-export-2.epub"), {
      title: "Field Notes",
      creators: [{ name: "Windows User" }, { name: "Jane Goodall" }],
    });
    expect(await readBookFileMetadata(withReal)).toMatchObject({ author: "Jane Goodall" });

    expect(parseMobiMetadata(buildMobi({ fullName: "Notes", exth: [{ type: 100, value: "Owner" }] }))?.author).toBeNull();
    expect(
      parseMobiMetadata(buildMobi({ fullName: "Notes", exth: [{ type: 100, value: "Windows User" }, { type: 100, value: "Stephen King" }] }))?.author
    ).toBe("Stephen King");
  });

  it("rejects word-processor/office placeholder titles", () => {
    for (const junk of [
      "Microsoft Word - chapter1.docx",
      "Microsoft PowerPoint - deck.pptx",
      "Microsoft Excel - budget.xlsx",
      "Microsoft Office Word - notes",
      "deck.pptx",
      "sheet.xls",
      "Untitled",
      "report.pdf",
      "Layout 1",
      "Slide 1",
      "Presentation1",
      "PowerPoint Presentation",
    ]) {
      expect(cleanPdfTitle(junk)).toBeNull();
    }
    expect(cleanPdfTitle("Clean Code")).toBe("Clean Code");
    expect(cleanPdfTitle("Microsoft Excel 2019 Data Analysis and Business Modeling")).toBe("Microsoft Excel 2019 Data Analysis and Business Modeling");
  });

  it("rejects a download site's URL, domain or name stamped into the Author or Title", () => {
    for (const stamp of [
      "www.it-ebooks.info",
      "WWW.IT-EBOOKS.INFO",
      "Amazon.com",
      "libgen.rs",
      "z-lib.org",
      "Z-Library",
      "Library Genesis",
      "http://www.allitebooks.com/some-book",
      "https://example.org",
      "Scanned by Foxtrot",
      "Converted by someone",
      "Uploaded by JohnDoe",
      "Downloaded from ebook3000",
    ]) {
      expect(cleanEmbeddedAuthor(stamp), stamp).toBeNull();
      expect(cleanPdfTitle(stamp), stamp).toBeNull();
    }
  });

  it("keeps real titles and names that merely contain a dot", () => {
    expect(cleanPdfTitle("ASP.NET Core in Action")).toBe("ASP.NET Core in Action");
    expect(cleanPdfTitle("ASP.NET")).toBe("ASP.NET");
    expect(cleanPdfTitle("Node.js")).toBe("Node.js");
    expect(cleanPdfTitle("Dr. Jekyll and Mr. Hyde")).toBe("Dr. Jekyll and Mr. Hyde");
    expect(cleanEmbeddedAuthor("H.P. Lovecraft")).toBe("H.P. Lovecraft");
    expect(cleanEmbeddedAuthor("E.L.James")).toBe("E.L.James");
  });

  it("rejects the same site stamps in EPUB and MOBI metadata", async () => {
    const epub = writeEpub(path.join(tmpDir, "stamped.epub"), { title: "www.it-ebooks.info", creators: [{ name: "www.it-ebooks.info" }] });
    expect(await readBookFileMetadata(epub)).toMatchObject({ title: null, author: null });
    expect(parseMobiMetadata(buildMobi({ fullName: "Amazon.com", exth: [{ type: 100, value: "libgen.rs" }] }))).toMatchObject({ author: null });
    expect(parseMobiMetadata(buildMobi({ palmName: "x", fullName: "Amazon.com" }))?.title).toBe("x");
  });

  it("reads Author/Title from one single-page pdf-parse pass", async () => {
    const file = path.join(tmpDir, "scan.pdf");
    fs.writeFileSync(file, "%PDF-1.4 fake");
    pdfParse.mockResolvedValue({ numpages: 400, info: { Title: "Clean Code", Author: "Robert C. Martin" } });

    expect(await readBookFileMetadata(file)).toEqual({ title: "Clean Code", author: "Robert C. Martin", isbn: null });
    expect(pdfParse).toHaveBeenCalledTimes(1);
    expect(pdfParse.mock.calls[0][1]).toEqual({ max: 1 });
  });

  it("drops a junk author but keeps a usable title", async () => {
    const file = path.join(tmpDir, "junk.pdf");
    fs.writeFileSync(file, "%PDF-1.4 fake");
    pdfParse.mockResolvedValue({ numpages: 1, info: { Title: "Real Title", Author: "Microsoft Word" } });
    expect(await readBookFileMetadata(file)).toEqual({ title: "Real Title", author: null, isbn: null });
  });

  it("returns null (never throws) when pdf-parse rejects", async () => {
    const file = path.join(tmpDir, "broken.pdf");
    fs.writeFileSync(file, "not a pdf");
    pdfParse.mockRejectedValue(new Error("Invalid PDF structure"));
    await expect(readBookFileMetadata(file)).resolves.toBeNull();
  });

  it("gives up (null) on a parse that never finishes", async () => {
    const file = path.join(tmpDir, "stuck.pdf");
    fs.writeFileSync(file, "%PDF-1.4 fake");
    pdfParse.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = readBookFileMetadata(file);
      await vi.advanceTimersByTimeAsync(PDF_INFO_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readBookFileMetadata — size cap", () => {
  // Sparse files: the reported size is past the cap without writing that many bytes.
  function sparseFile(name: string, size: number): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, "");
    fs.truncateSync(file, size);
    return file;
  }

  it("never loads a PDF or EPUB larger than the cap", async () => {
    pdfParse.mockResolvedValue({ numpages: 1, info: { Title: "Huge", Author: "Someone Real" } });
    expect(await readBookFileMetadata(sparseFile("huge.pdf", MAX_EMBEDDED_READ_BYTES[".pdf"] + 1))).toBeNull();
    expect(await readBookFileMetadata(sparseFile("huge.epub", MAX_EMBEDDED_READ_BYTES[".epub"] + 1))).toBeNull();
    expect(pdfParse).not.toHaveBeenCalled();
  });

  it("still reads a PDF under the cap", async () => {
    pdfParse.mockResolvedValue({ numpages: 1, info: { Title: "Fits", Author: "Someone Real" } });
    expect(await readBookFileMetadata(sparseFile("fits.pdf", 1024))).toEqual({ title: "Fits", author: "Someone Real", isbn: null });
  });
});
