import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { findIsbnInText, extractIsbnFromBookFile, fetchBookByIsbn } from "../src/services/bookIsbnScan.js";

// A real, checksum-valid ISBN-10/13 pair for the same book (Clean Code), so conversion tests are
// grounded in a value that's actually correct, not just internally self-consistent.
const REAL_ISBN_10 = "0132350882";
const REAL_ISBN_13 = "9780132350884";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-isbnscan-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findIsbnInText", () => {
  it("finds a labeled ISBN-13", () => {
    expect(findIsbnInText(`Copyright page. ISBN: ${REAL_ISBN_13}`)).toBe(REAL_ISBN_13);
  });

  it("finds a bare (unlabeled) ISBN-13 digit run", () => {
    expect(findIsbnInText(`Some text ${REAL_ISBN_13} more text`)).toBe(REAL_ISBN_13);
  });

  it("finds an ISBN-10 and converts it to its ISBN-13 equivalent", () => {
    expect(findIsbnInText(`ISBN-10: ${REAL_ISBN_10}`)).toBe(REAL_ISBN_13);
  });

  it("tolerates hyphens within the candidate", () => {
    expect(findIsbnInText("ISBN 978-0-13-235088-4")).toBe(REAL_ISBN_13);
  });

  it("rejects a checksum-invalid number even if it's the right length", () => {
    const invalid = REAL_ISBN_13.slice(0, -1) + (REAL_ISBN_13.endsWith("4") ? "5" : "4"); // flip the check digit
    expect(findIsbnInText(`ISBN: ${invalid}`)).toBeNull();
  });

  it("finds a labeled ISBN-13 followed by a printer's key (digits after a space)", () => {
    expect(findIsbnInText(`ISBN ${REAL_ISBN_13} 10 9 8 7 6 5 4 3 2 1`)).toBe(REAL_ISBN_13);
  });

  it("finds a bare ISBN-13 followed by a printer's key", () => {
    expect(findIsbnInText(`Printed in the United States of America ${REAL_ISBN_13} 10 9 8 7 6 5 4 3 2 1`)).toBe(REAL_ISBN_13);
  });

  it("finds an ISBN-10 followed by a printer's key and converts it", () => {
    expect(findIsbnInText(`ISBN-10: ${REAL_ISBN_10} 10 9 8 7 6 5 4 3 2 1`)).toBe(REAL_ISBN_13);
  });

  it("finds a hyphenated ISBN-10 followed by other numbers", () => {
    expect(findIsbnInText("ISBN 0-13-235088-2 10 9")).toBe(REAL_ISBN_13);
  });

  it("prefers the ISBN-10 over a longer 13-digit slice that only passes the checksum by accident", () => {
    // "0132350882" + "10" + "1" happens to satisfy the ISBN-13 checksum, but has no 978/979 prefix.
    expect(findIsbnInText(`ISBN ${REAL_ISBN_10} 10 1`)).toBe(REAL_ISBN_13);
  });

  it("returns null when there's nothing ISBN-shaped in the text", () => {
    expect(findIsbnInText("Just some ordinary book jacket copy with no numbers at all.")).toBeNull();
  });
});

describe("extractIsbnFromBookFile — epub", () => {
  function makeEpub(fileName: string, opts: { skipContainer?: boolean; identifier?: string | null } = {}): string {
    const zip = new AdmZip();
    if (!opts.skipContainer) {
      zip.addFile(
        "META-INF/container.xml",
        Buffer.from(
          `<?xml version="1.0"?>
           <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
             <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
           </container>`
        )
      );
      const identifierXml = opts.identifier === null ? "" : `<dc:identifier>${opts.identifier ?? `ISBN:${REAL_ISBN_13}`}</dc:identifier>`;
      zip.addFile(
        "OEBPS/content.opf",
        Buffer.from(
          `<?xml version="1.0"?>
           <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
             <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${identifierXml}</metadata>
           </package>`
        )
      );
    }
    const dest = path.join(tmpDir, fileName);
    zip.writeZip(dest);
    return dest;
  }

  it("extracts the ISBN from a well-formed epub's OPF metadata", async () => {
    const filePath = makeEpub("valid.epub");
    expect(await extractIsbnFromBookFile(filePath)).toBe(REAL_ISBN_13);
  });

  it("returns null (not a throw) when META-INF/container.xml is missing", async () => {
    const filePath = makeEpub("no-container.epub", { skipContainer: true });
    await expect(extractIsbnFromBookFile(filePath)).resolves.toBeNull();
  });

  it("returns null when the OPF has no usable dc:identifier", async () => {
    const filePath = makeEpub("no-identifier.epub", { identifier: null });
    expect(await extractIsbnFromBookFile(filePath)).toBeNull();
  });

  it("returns null (not a throw) for a corrupt/non-zip file with an .epub extension", async () => {
    const filePath = path.join(tmpDir, "corrupt.epub");
    fs.writeFileSync(filePath, "this is not a real zip file");
    await expect(extractIsbnFromBookFile(filePath)).resolves.toBeNull();
  });
});

describe("extractIsbnFromBookFile — other formats", () => {
  it("returns null immediately for an unsupported extension like .mobi", async () => {
    const filePath = path.join(tmpDir, "book.mobi");
    fs.writeFileSync(filePath, "fake mobi content");
    expect(await extractIsbnFromBookFile(filePath)).toBeNull();
  });

  it("returns null (not a throw) for a .pdf file that isn't actually parseable as a PDF", async () => {
    const filePath = path.join(tmpDir, "not-really.pdf");
    fs.writeFileSync(filePath, "this is not a real pdf file");
    await expect(extractIsbnFromBookFile(filePath)).resolves.toBeNull();
  });
});

describe("fetchBookByIsbn", () => {
  function mockOpenLibrary(body: unknown, ok = true, status = 200): void {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status, json: async () => body }) as any));
  }

  it("maps a found book to a BookMatch", async () => {
    mockOpenLibrary({
      [`ISBN:${REAL_ISBN_13}`]: { title: "Clean Code", publish_date: "2008", cover: { medium: "https://covers/m.jpg", large: "https://covers/l.jpg" } },
    });

    const result = await fetchBookByIsbn(REAL_ISBN_13);

    expect(result).toEqual({
      title: "Clean Code",
      releaseDate: "2008",
      posterUrl: "https://covers/m.jpg",
      externalId: REAL_ISBN_13,
      externalProvider: "openlibrary",
    });
  });

  it("falls back to the large cover when medium isn't present", async () => {
    mockOpenLibrary({ [`ISBN:${REAL_ISBN_13}`]: { title: "Clean Code", cover: { large: "https://covers/l.jpg" } } });

    const result = await fetchBookByIsbn(REAL_ISBN_13);

    expect(result?.posterUrl).toBe("https://covers/l.jpg");
  });

  it("returns a null posterUrl when there's no cover at all", async () => {
    mockOpenLibrary({ [`ISBN:${REAL_ISBN_13}`]: { title: "Clean Code" } });

    const result = await fetchBookByIsbn(REAL_ISBN_13);

    expect(result?.posterUrl).toBeNull();
    expect(result?.releaseDate).toBeNull();
  });

  it("returns null when the isbn isn't found in Open Library", async () => {
    mockOpenLibrary({});

    expect(await fetchBookByIsbn(REAL_ISBN_13)).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    mockOpenLibrary({}, false, 503);

    await expect(fetchBookByIsbn(REAL_ISBN_13)).rejects.toThrow(/HTTP 503/);
  });
});
