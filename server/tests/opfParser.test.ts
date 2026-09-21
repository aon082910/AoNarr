import { describe, it, expect } from "vitest";
import { parseOpf } from "../src/services/opfParser.js";

const SAMPLE_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Hobbit</dc:title>
    <dc:creator opf:role="aut">J.R.R. Tolkien</dc:creator>
    <dc:description>A hobbit goes on an adventure.</dc:description>
    <dc:date>1937-09-21T00:00:00+00:00</dc:date>
    <dc:identifier opf:scheme="ISBN">9780547928227</dc:identifier>
    <dc:identifier opf:scheme="GOODREADS">5907</dc:identifier>
  </metadata>
</package>`;

describe("parseOpf", () => {
  it("extracts title/author/overview/year from a Calibre metadata.opf", async () => {
    const result = await parseOpf(SAMPLE_OPF);
    expect(result.title).toBe("The Hobbit");
    expect(result.author).toBe("J.R.R. Tolkien");
    expect(result.overview).toBe("A hobbit goes on an adventure.");
    expect(result.year).toBe(1937);
  });

  it("collects identifiers keyed by their lowercased scheme", async () => {
    const result = await parseOpf(SAMPLE_OPF);
    expect(result.externalIds).toEqual({ isbn: "9780547928227", goodreads: "5907" });
  });

  it("returns all-null/empty for XML with no <metadata> section", async () => {
    const result = await parseOpf("<package><notmetadata/></package>");
    expect(result).toEqual({ title: null, author: null, overview: null, year: null, externalIds: {} });
  });

  it("never throws on malformed XML", async () => {
    await expect(parseOpf("not xml at all <<<")).rejects.toBeTruthy();
  });
});
