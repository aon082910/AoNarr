import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { setupTestDb } from "./helpers/testDb.js";

let downloadsDir: string;

beforeAll(async () => {
  await setupTestDb();
  downloadsDir = process.env.AONARR_DOWNLOADS_DIR!;
});

function makeZip(destPath: string, files: Record<string, string>): void {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  zip.writeZip(destPath);
}

function markerFor(archivePath: string): string {
  return `${archivePath}.aonarr-extracted`;
}

describe("unpackDownloadedArchives — zip", () => {
  it("extracts a top-level zip into a sibling directory named after the archive", async () => {
    const { unpackDownloadedArchives } = await import("../src/services/archiveExtract.js");
    const archivePath = path.join(downloadsDir, "top-level-release.zip");
    makeZip(archivePath, { "movie.mkv": "fake video content" });

    await unpackDownloadedArchives();

    const destDir = path.join(downloadsDir, "top-level-release");
    expect(fs.existsSync(path.join(destDir, "movie.mkv"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "movie.mkv"), "utf-8")).toBe("fake video content");
  });

  it("drops a marker file next to the archive so a second pass doesn't re-extract it", async () => {
    const { unpackDownloadedArchives } = await import("../src/services/archiveExtract.js");
    const archivePath = path.join(downloadsDir, "marker-test-release.zip");
    makeZip(archivePath, { "episode.mkv": "original content" });
    await unpackDownloadedArchives();
    expect(fs.existsSync(markerFor(archivePath))).toBe(true);

    // Tamper with the extracted output, then run again — if the marker is respected, the tampered
    // file must survive untouched (proving no re-extraction happened).
    const extractedFile = path.join(downloadsDir, "marker-test-release", "episode.mkv");
    fs.writeFileSync(extractedFile, "tampered after first extraction");
    await unpackDownloadedArchives();

    expect(fs.readFileSync(extractedFile, "utf-8")).toBe("tampered after first extraction");
  });

  it("finds and extracts an archive nested inside a subdirectory", async () => {
    const { unpackDownloadedArchives } = await import("../src/services/archiveExtract.js");
    const subDir = path.join(downloadsDir, "nested-release-folder");
    fs.mkdirSync(subDir, { recursive: true });
    const archivePath = path.join(subDir, "nested.zip");
    makeZip(archivePath, { "album.mp3": "fake audio" });

    await unpackDownloadedArchives();

    expect(fs.existsSync(path.join(subDir, "nested", "album.mp3"))).toBe(true);
  });

  it("does not find an archive nested deeper than the max walk depth", async () => {
    const { unpackDownloadedArchives } = await import("../src/services/archiveExtract.js");
    let deepDir = path.join(downloadsDir, "too-deep-root");
    for (let i = 0; i < 6; i++) deepDir = path.join(deepDir, `level${i}`);
    fs.mkdirSync(deepDir, { recursive: true });
    const archivePath = path.join(deepDir, "unreachable.zip");
    makeZip(archivePath, { "file.txt": "content" });

    await unpackDownloadedArchives();

    expect(fs.existsSync(markerFor(archivePath))).toBe(false);
    expect(fs.existsSync(path.join(deepDir, "unreachable"))).toBe(false);
  });

  it("ignores non-archive files sitting in the downloads directory", async () => {
    const { unpackDownloadedArchives } = await import("../src/services/archiveExtract.js");
    const plainFile = path.join(downloadsDir, "not-an-archive.mkv");
    fs.writeFileSync(plainFile, "just a video file");

    await expect(unpackDownloadedArchives()).resolves.not.toThrow();

    expect(fs.existsSync(plainFile)).toBe(true);
    expect(fs.existsSync(markerFor(plainFile))).toBe(false);
  });
});

describe("unpackDownloadedArchives — unsupported/missing tooling", () => {
  it("never throws for a .rar archive when the unrar binary isn't available, and leaves no marker", async () => {
    const { unpackDownloadedArchives } = await import("../src/services/archiveExtract.js");
    const archivePath = path.join(downloadsDir, "needs-unrar-release.rar");
    fs.writeFileSync(archivePath, "not a real rar file, just needs to exist");

    await expect(unpackDownloadedArchives()).resolves.not.toThrow();

    expect(fs.existsSync(markerFor(archivePath))).toBe(false);
  });
});
