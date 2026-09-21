import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseComicInfoXml, findComicInfoInCbz } from "../src/services/comicInfoParser.js";

const SAMPLE_COMICINFO = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>The Amazing Spider-Man</Series>
  <Title>Say It With Songbird</Title>
  <Number>1</Number>
  <Summary>Peter Parker faces a new threat.</Summary>
  <Year>2022</Year>
  <Genre>Superhero, Action</Genre>
</ComicInfo>`;

describe("parseComicInfoXml", () => {
  it("extracts series (parent) and issue-level fields separately", async () => {
    const result = await parseComicInfoXml(SAMPLE_COMICINFO);
    expect(result.series).toBe("The Amazing Spider-Man");
    expect(result.title).toBe("Say It With Songbird");
    expect(result.issueNumber).toBe("1");
    expect(result.overview).toBe("Peter Parker faces a new threat.");
    expect(result.year).toBe(2022);
  });

  it("splits a comma-separated Genre field into an array", async () => {
    const result = await parseComicInfoXml(SAMPLE_COMICINFO);
    expect(result.genres).toEqual(["Superhero", "Action"]);
  });

  it("returns all-null/empty for XML with no <ComicInfo> root", async () => {
    const result = await parseComicInfoXml("<NotComicInfo/>");
    expect(result).toEqual({ series: null, title: null, issueNumber: null, overview: null, year: null, genres: [] });
  });
});

describe("findComicInfoInCbz", () => {
  function makeCbz(entries: Record<string, string>): string {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content, "utf-8"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-cbz-"));
    const cbzPath = path.join(dir, "issue.cbz");
    zip.writeZip(cbzPath);
    return cbzPath;
  }

  it("finds and reads an embedded ComicInfo.xml", () => {
    const cbzPath = makeCbz({ "ComicInfo.xml": SAMPLE_COMICINFO, "page01.jpg": "fake image data" });
    const xml = findComicInfoInCbz(cbzPath);
    expect(xml).toContain("The Amazing Spider-Man");
  });

  it("matches case-insensitively", () => {
    const cbzPath = makeCbz({ "comicinfo.xml": SAMPLE_COMICINFO });
    const xml = findComicInfoInCbz(cbzPath);
    expect(xml).toContain("The Amazing Spider-Man");
  });

  it("returns null when the archive has no ComicInfo.xml at all", () => {
    const cbzPath = makeCbz({ "page01.jpg": "fake image data" });
    expect(findComicInfoInCbz(cbzPath)).toBeNull();
  });

  it("returns null (never throws) for a non-.cbz file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-cbz-"));
    const rarPath = path.join(dir, "issue.cbr");
    fs.writeFileSync(rarPath, "not a real archive");
    expect(findComicInfoInCbz(rarPath)).toBeNull();
  });

  it("returns null (never throws) for a nonexistent file", () => {
    expect(findComicInfoInCbz("/definitely/does/not/exist.cbz")).toBeNull();
  });
});
