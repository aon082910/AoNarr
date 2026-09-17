import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { setupTestDb } from "./helpers/testDb.js";

type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
let ffmpegShouldFail = false;

vi.mock("node:child_process", () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    if (ffmpegShouldFail) {
      callback(new Error("ffmpeg failed to encode"));
      return;
    }
    const outPath = args[args.length - 1];
    // A real (if tiny) file standing in for whatever ffmpeg would have actually produced — its
    // exact bytes don't matter, only that convertComicImages faithfully round-trips them into
    // the rewritten zip entry under the new name/extension.
    fs.writeFileSync(outPath, `re-encoded:${path.basename(outPath)}`);
    callback(null, { stdout: "", stderr: "" });
  },
}));

let convertComicImages: (typeof import("../src/services/comicImageConvert.js"))["convertComicImages"];
let convertComicImagesBestEffort: (typeof import("../src/services/comicImageConvert.js"))["convertComicImagesBestEffort"];
let tmpDir: string;

beforeAll(async () => {
  // comicImageConvert.ts imports logger.js, which touches config.js/db/index.js transitively —
  // must load after setupTestDb() has set the env vars those modules read at first import.
  await setupTestDb();
  ({ convertComicImages, convertComicImagesBestEffort } = await import("../src/services/comicImageConvert.js"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-comicconvert-"));
});

afterEach(() => {
  ffmpegShouldFail = false;
});

function makeCbz(fileName: string, entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  const dest = path.join(tmpDir, fileName);
  zip.writeZip(dest);
  return dest;
}

function readZipEntries(filePath: string): { name: string; content: string }[] {
  const zip = new AdmZip(filePath);
  return zip.getEntries().map((e) => ({ name: e.entryName, content: e.getData().toString("utf-8") }));
}

describe("convertComicImages", () => {
  it("throws for a non-cbz extension", async () => {
    const filePath = path.join(tmpDir, "not-a-cbz.cbr");
    fs.writeFileSync(filePath, "fake cbr content");

    await expect(convertComicImages(filePath, "webp", 80)).rejects.toThrow(/Only CBZ archives/);
  });

  it("leaves an archive with no image entries completely unchanged", async () => {
    const filePath = makeCbz("no-images.cbz", { "ComicInfo.xml": "<ComicInfo></ComicInfo>" });
    const before = fs.statSync(filePath).size;

    const result = await convertComicImages(filePath, "webp", 80);

    expect(result).toEqual({ originalBytes: before, newBytes: before });
    expect(readZipEntries(filePath)).toEqual([{ name: "ComicInfo.xml", content: "<ComicInfo></ComicInfo>" }]);
  });

  it("re-encodes each page to webp and renames its extension", async () => {
    const filePath = makeCbz("webp-convert.cbz", { "page01.png": "fake png bytes", "page02.jpg": "fake jpg bytes" });

    await convertComicImages(filePath, "webp", 80);

    const entries = readZipEntries(filePath);
    expect(entries.map((e) => e.name).sort()).toEqual(["page01.webp", "page02.webp"]);
    expect(entries.find((e) => e.name === "page01.webp")!.content).toContain("re-encoded:out.webp");
  });

  it("re-encodes each page to jpeg when that format is requested", async () => {
    const filePath = makeCbz("jpeg-convert.cbz", { "page01.png": "fake png bytes" });

    await convertComicImages(filePath, "jpeg", 80);

    const entries = readZipEntries(filePath);
    expect(entries.map((e) => e.name)).toEqual(["page01.jpg"]);
  });

  it("leaves non-image entries (e.g. ComicInfo.xml) untouched alongside converted pages", async () => {
    const filePath = makeCbz("mixed-entries.cbz", { "page01.png": "fake png bytes", "ComicInfo.xml": "<ComicInfo></ComicInfo>" });

    await convertComicImages(filePath, "webp", 80);

    const entries = readZipEntries(filePath);
    expect(entries.map((e) => e.name).sort()).toEqual(["ComicInfo.xml", "page01.webp"]);
    expect(entries.find((e) => e.name === "ComicInfo.xml")!.content).toBe("<ComicInfo></ComicInfo>");
  });

  it("disambiguates two pages that would otherwise collide on the same output name", async () => {
    // page01.png and page01.jpg both map to page01.webp — the second one converted must not
    // silently overwrite the first.
    const filePath = makeCbz("collision.cbz", { "page01.png": "png version", "page01.jpg": "jpg version" });

    await convertComicImages(filePath, "webp", 80);

    const entries = readZipEntries(filePath);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name).sort()).toEqual(["page01-2.webp", "page01.webp"]);
  });

  it("reports smaller newBytes reflecting the rewritten archive", async () => {
    const filePath = makeCbz("size-check.cbz", { "page01.png": "a".repeat(10_000) }); // large original page
    const before = fs.statSync(filePath).size;

    const result = await convertComicImages(filePath, "webp", 80);

    expect(result.originalBytes).toBe(before);
    expect(result.newBytes).toBe(fs.statSync(filePath).size);
    expect(result.newBytes).toBeLessThan(result.originalBytes); // the tiny fake "re-encoded" page is much smaller
  });
});

describe("convertComicImagesBestEffort", () => {
  it("resolves without throwing on success", async () => {
    const filePath = makeCbz("best-effort-success.cbz", { "page01.png": "fake png bytes" });

    await expect(convertComicImagesBestEffort(filePath, "webp", 80)).resolves.toBeUndefined();

    expect(readZipEntries(filePath).map((e) => e.name)).toEqual(["page01.webp"]);
  });

  it("swallows a failure (e.g. an unsupported extension) instead of throwing", async () => {
    const filePath = path.join(tmpDir, "best-effort-failure.cbr");
    fs.writeFileSync(filePath, "fake cbr content");

    await expect(convertComicImagesBestEffort(filePath, "webp", 80)).resolves.toBeUndefined();
  });

  it("swallows an ffmpeg failure mid-conversion instead of throwing", async () => {
    const filePath = makeCbz("ffmpeg-failure.cbz", { "page01.png": "fake png bytes" });
    ffmpegShouldFail = true;

    await expect(convertComicImagesBestEffort(filePath, "webp", 80)).resolves.toBeUndefined();
  });
});
