import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import { setupTestDb } from "./helpers/testDb.js";

let downloadsDir: string;
let unpackDownloadedArchives: (typeof import("../src/services/archiveExtract.js"))["unpackDownloadedArchives"];
let tableCrc32: (typeof import("../src/services/archiveExtract.js"))["tableCrc32"];
let log: (typeof import("../src/services/logger.js"))["log"];

beforeAll(async () => {
  await setupTestDb();
  downloadsDir = process.env.AONARR_DOWNLOADS_DIR!;
  ({ unpackDownloadedArchives, tableCrc32 } = await import("../src/services/archiveExtract.js"));
  ({ log } = await import("../src/services/logger.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeZip(destPath: string, files: Record<string, string | Buffer>): void {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, typeof content === "string" ? Buffer.from(content) : content);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  zip.writeZip(destPath);
}

function zipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

interface RawEntry {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  /** Uncompressed size written into the headers, when it should differ from the real one. */
  declaredSize?: number;
  flags?: number;
  /** CRC-32 written into the headers, when it should differ from the real one. */
  crc?: number;
}

/** Hand-assembled zip, for archives adm-zip won't write: lying sizes or checksums, unsafe names,
 * encryption flags, zip64 records. */
function buildZip(entries: RawEntry[], opts: { zip64?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const payload = method === 8 ? zlib.deflateRawSync(data) : data;
    const size = e.declaredSize ?? data.length;
    const name = Buffer.from(e.name, "utf8");
    const flags = e.flags ?? 0x800;
    const crc = e.crc ?? zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, payload);

    let extra = Buffer.alloc(0);
    if (opts.zip64) {
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(payload.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 45, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(opts.zip64 ? 0xffffffff : payload.length, 20);
    central.writeUInt32LE(opts.zip64 ? 0xffffffff : size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((e.name.endsWith("/") ? 0o040755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const tail: Buffer[] = [cd];
  if (opts.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : cdOffset, 16);
  tail.push(eocd);
  return Buffer.concat([...parts, ...tail]);
}

function writeFile(filePath: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function markerFor(archivePath: string): string {
  return `${archivePath}.aonarr-extracted`;
}

/** Runs `fn` with PATH pointing at `dir` only, so the external tools are exactly what the test puts there. */
async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

// These call with no scope, which sweeps the whole downloads directory — kept first, before the
// other blocks leave deliberately-unextracted archives lying around in it.
describe("unpackDownloadedArchives — no scope (whole downloads directory)", () => {
  it("extracts a top-level zip into a sibling directory named after the archive", async () => {
    const archivePath = path.join(downloadsDir, "top-level-release.zip");
    makeZip(archivePath, { "movie.mkv": "fake video content" });

    const result = await unpackDownloadedArchives();

    const destDir = path.join(downloadsDir, "top-level-release");
    expect(fs.readFileSync(path.join(destDir, "movie.mkv"), "utf-8")).toBe("fake video content");
    expect(result.extracted).toContain(archivePath);
  });

  it("drops a marker file next to the archive so a second pass doesn't re-extract it", async () => {
    const archivePath = path.join(downloadsDir, "marker-test-release.zip");
    makeZip(archivePath, { "episode.mkv": "original content" });
    await unpackDownloadedArchives();
    expect(fs.existsSync(markerFor(archivePath))).toBe(true);

    const extractedFile = path.join(downloadsDir, "marker-test-release", "episode.mkv");
    fs.writeFileSync(extractedFile, "tampered after first extraction");
    await unpackDownloadedArchives();

    expect(fs.readFileSync(extractedFile, "utf-8")).toBe("tampered after first extraction");
  });

  it("finds and extracts an archive nested inside a subdirectory", async () => {
    const subDir = path.join(downloadsDir, "nested-release-folder");
    const archivePath = path.join(subDir, "nested.zip");
    makeZip(archivePath, { "album.mp3": "fake audio" });

    await unpackDownloadedArchives();

    expect(fs.existsSync(path.join(subDir, "nested", "album.mp3"))).toBe(true);
  });

  it("does not find an archive nested deeper than the max walk depth", async () => {
    let deepDir = path.join(downloadsDir, "too-deep-root");
    for (let i = 0; i < 6; i++) deepDir = path.join(deepDir, `level${i}`);
    const archivePath = path.join(deepDir, "unreachable.zip");
    makeZip(archivePath, { "file.txt": "content" });

    await unpackDownloadedArchives();

    expect(fs.existsSync(markerFor(archivePath))).toBe(false);
    expect(fs.existsSync(path.join(deepDir, "unreachable"))).toBe(false);
  });

  it("ignores non-archive files sitting in the downloads directory", async () => {
    const plainFile = writeFile(path.join(downloadsDir, "not-an-archive.mkv"), "just a video file");

    await expect(unpackDownloadedArchives()).resolves.toBeDefined();

    expect(fs.existsSync(plainFile)).toBe(true);
    expect(fs.existsSync(markerFor(plainFile))).toBe(false);
  });
});

describe("unpackDownloadedArchives — only the download being imported", () => {
  it("unpacks archives in the download's own folder and nothing elsewhere in downloads", async () => {
    const releaseDir = path.join(downloadsDir, "Show.Name.S01E01.1080p.WEB-GRP");
    const own = path.join(releaseDir, "show.name.s01e01.zip");
    makeZip(own, { "show.name.s01e01.mkv": "episode" });
    const otherApps = path.join(downloadsDir, "Some.Other.Download", "other.zip");
    makeZip(otherApps, { "other.bin": "someone else's" });

    const result = await unpackDownloadedArchives({ downloadPath: releaseDir, releaseTitle: "Show.Name.S01E01.1080p.WEB-GRP", mediaType: "series" });

    expect(result).toEqual({ extracted: [own], failed: [] });
    expect(fs.readFileSync(path.join(releaseDir, "show.name.s01e01", "show.name.s01e01.mkv"), "utf-8")).toBe("episode");
    expect(fs.existsSync(markerFor(otherApps))).toBe(false);
    expect(fs.existsSync(path.join(downloadsDir, "Some.Other.Download", "other"))).toBe(false);
  });

  it("unpacks only the reported archive when the client reports a single file", async () => {
    const reported = path.join(downloadsDir, "loose", "Loose.Release.2020.1080p.WEB-GRP.zip");
    makeZip(reported, { "movie.mkv": "loose movie" });
    const neighbour = path.join(downloadsDir, "loose", "Neighbour.Release.2020.zip");
    makeZip(neighbour, { "x.mkv": "x" });

    const result = await unpackDownloadedArchives({ downloadPath: reported, releaseTitle: "Loose.Release.2020.1080p.WEB-GRP" });

    expect(result.extracted).toEqual([reported]);
    expect(fs.existsSync(markerFor(neighbour))).toBe(false);
  });

  it("in a shared category folder, unpacks only the archives named for this release", async () => {
    const category = path.join(downloadsDir, "tv");
    const mine = path.join(category, "Show.Alpha.S01E01.1080p.WEB-GRP", "a.zip");
    const theirs = path.join(category, "Show.Beta.S01E01.1080p.WEB-GRP", "b.zip");
    makeZip(mine, { "a.mkv": "a" });
    makeZip(theirs, { "b.mkv": "b" });

    const result = await unpackDownloadedArchives({ downloadPath: category, releaseTitle: "Show.Alpha.S01E01.1080p.WEB-GRP", mediaType: "series" });

    expect(result.extracted).toEqual([mine]);
    expect(fs.existsSync(markerFor(theirs))).toBe(false);
  });

  it("recognises a shared category folder even when the release title has no usable lead words", async () => {
    const category = path.join(downloadsDir, "movies");
    const mine = path.join(category, "1917.2019.1080p.BluRay-GRP", "1917.2019.1080p.bluray-grp.zip");
    const theirs = path.join(category, "Other.Movie.2020.1080p.WEB-GRP", "other.zip");
    makeZip(mine, { "1917.mkv": "war" });
    makeZip(theirs, { "other.mkv": "other" });

    const result = await unpackDownloadedArchives({ downloadPath: category, releaseTitle: "1917.2019.1080p.BluRay-GRP", mediaType: "movie" });

    expect(result.extracted).toEqual([mine]);
    expect(fs.existsSync(markerFor(theirs))).toBe(false);
  });

  it("still unpacks everything in the release's own folder when its title has no usable lead words", async () => {
    const releaseDir = path.join(downloadsDir, "Up.2009.720p.BluRay.x264-GRP");
    const part = path.join(releaseDir, "subs.zip");
    makeZip(part, { "up.srt": "subs" });

    const result = await unpackDownloadedArchives({ downloadPath: releaseDir, releaseTitle: "Up.2009.720p.BluRay.x264-GRP", mediaType: "movie" });

    expect(result.extracted).toEqual([part]);
  });

  it("with no usable download path, finds the release's archives by name", async () => {
    const mine = path.join(downloadsDir, "Movie.Title.2021.1080p.BluRay.x264-GRP.zip");
    const sameGroupOtherFilm = path.join(downloadsDir, "Another.Film.2021.1080p.BluRay.x264-GRP.zip");
    makeZip(mine, { "movie.mkv": "m" });
    makeZip(sameGroupOtherFilm, { "movie.mkv": "o" });

    const result = await unpackDownloadedArchives({
      downloadPath: path.join(downloadsDir, "no-longer-there"),
      releaseTitle: "Movie Title 2021 1080p BluRay x264-GRP",
      mediaType: "movie",
    });

    expect(result.extracted).toEqual([mine]);
    expect(fs.existsSync(markerFor(sameGroupOtherFilm))).toBe(false);
  });

  it("with no usable download path, leaves the same show's other episodes and season packs alone", async () => {
    const mine = path.join(downloadsDir, "Name.Show.S01E01.1080p.WEB-GRP", "name.show.s01e01.zip");
    const otherEpisode = path.join(downloadsDir, "Name.Show.S01E05.1080p.WEB-GRP", "name.show.s01e05.zip");
    const seasonPack = path.join(downloadsDir, "Name.Show.S01.1080p.WEB-GRP", "name.show.s01.zip");
    for (const archive of [mine, otherEpisode, seasonPack]) makeZip(archive, { "episode.mkv": path.basename(archive) });

    const result = await unpackDownloadedArchives({ downloadPath: null, releaseTitle: "Name.Show.S01E01.1080p.WEB-GRP", mediaType: "series" });

    expect(result).toEqual({ extracted: [mine], failed: [] });
    expect(fs.existsSync(markerFor(otherEpisode))).toBe(false);
    expect(fs.existsSync(markerFor(seasonPack))).toBe(false);
  });

  it("in a shared category folder, tells a daily show's episodes apart by air date", async () => {
    const category = path.join(downloadsDir, "tv-daily");
    const mine = path.join(category, "Late.Night.Talk.2021.03.04.720p.WEB-GRP", "talk.zip");
    const nextNight = path.join(category, "Late.Night.Talk.2021.03.05.720p.WEB-GRP", "talk.zip");
    makeZip(mine, { "talk.mkv": "thursday" });
    makeZip(nextNight, { "talk.mkv": "friday" });

    const result = await unpackDownloadedArchives({ downloadPath: category, releaseTitle: "Late.Night.Talk.2021.03.04.720p.WEB-GRP", mediaType: "series" });

    expect(result.extracted).toEqual([mine]);
    expect(fs.existsSync(markerFor(nextNight))).toBe(false);
  });

  it("tells a film with a short title apart from other films sharing its year and tags", async () => {
    const category = path.join(downloadsDir, "films");
    const mine = path.join(category, "It.2017.1080p.BluRay.x264-GRP", "it.2017.zip");
    const other = path.join(category, "Another.Movie.2017.1080p.BluRay.x264-GRP", "another.zip");
    makeZip(mine, { "it.mkv": "clown" });
    makeZip(other, { "another.mkv": "other" });

    const result = await unpackDownloadedArchives({ downloadPath: category, releaseTitle: "It.2017.1080p.BluRay.x264-GRP", mediaType: "movie" });

    expect(result.extracted).toEqual([mine]);
    expect(fs.existsSync(markerFor(other))).toBe(false);
  });

  it("leaves a ROM download's .zip alone, since ROMs are imported as zips", async () => {
    const romDir = path.join(downloadsDir, "Game (USA)");
    const romZip = path.join(romDir, "Game (USA).zip");
    makeZip(romZip, { "Game (USA).nes": "rom bytes" });

    const result = await unpackDownloadedArchives({ downloadPath: romDir, releaseTitle: "Game (USA)", mediaType: "rom" });

    expect(result).toEqual({ extracted: [], failed: [] });
    expect(fs.existsSync(path.join(romDir, "Game (USA)"))).toBe(false);
    expect(fs.existsSync(markerFor(romZip))).toBe(false);
  });

  it("never unpacks an archive that came out of an earlier extraction", async () => {
    const releaseDir = path.join(downloadsDir, "Nested.Archive.Release.2020");
    const outer = path.join(releaseDir, "outer.zip");
    makeZip(outer, { "inner.zip": zipBuffer({ "deep.txt": "deep" }), "readme.txt": "hi" });
    const scope = { downloadPath: releaseDir, releaseTitle: "Nested.Archive.Release.2020" };

    await unpackDownloadedArchives(scope);
    const second = await unpackDownloadedArchives(scope);

    expect(fs.existsSync(path.join(releaseDir, "outer", "inner.zip"))).toBe(true);
    expect(second).toEqual({ extracted: [], failed: [] });
    expect(fs.existsSync(path.join(releaseDir, "outer", "inner"))).toBe(false);
  });
});

describe("unpackDownloadedArchives — zip safety", () => {
  function scopeFor(dir: string) {
    return { downloadPath: dir, releaseTitle: path.basename(dir) };
  }

  it("streams a deflated, folder-structured zip64 archive out intact", async () => {
    const dir = path.join(downloadsDir, "Zip64.Release.2022");
    const archive = writeFile(
      path.join(dir, "big.zip"),
      buildZip(
        [
          { name: "Sub/", data: Buffer.alloc(0) },
          { name: "Sub/episode.mkv", data: Buffer.from("x".repeat(50_000)), method: 8 },
          { name: "notes.txt", data: Buffer.from("stored entry") },
        ],
        { zip64: true }
      )
    );

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result).toEqual({ extracted: [archive], failed: [] });
    expect(fs.readFileSync(path.join(dir, "big", "Sub", "episode.mkv"), "utf-8")).toBe("x".repeat(50_000));
    expect(fs.readFileSync(path.join(dir, "big", "notes.txt"), "utf-8")).toBe("stored entry");
  });

  it("refuses an archive whose contents would expand far beyond its own size", async () => {
    const dir = path.join(downloadsDir, "Bomb.Declared.Release");
    const archive = writeFile(path.join(dir, "bomb.zip"), buildZip([{ name: "zeros.bin", data: Buffer.alloc(10), declaredSize: 0xfff00000 }]));

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: expect.stringMatching(/would unpack to/) }]);
    expect(fs.existsSync(path.join(dir, "bomb"))).toBe(false);
    expect(fs.existsSync(markerFor(archive))).toBe(false);
  });

  it("refuses an archive with more entries than the limit", async () => {
    const dir = path.join(downloadsDir, "Many.Entries.Release");
    const entries = Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}.txt` }));
    const archive = writeFile(path.join(dir, "many.zip"), buildZip(entries));

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: expect.stringMatching(/10001 entries/) }]);
    expect(fs.existsSync(path.join(dir, "many"))).toBe(false);
  });

  it("stops an entry that inflates past its declared size, and removes the partial output", async () => {
    const dir = path.join(downloadsDir, "Lying.Header.Release");
    const archive = writeFile(
      path.join(dir, "liar.zip"),
      buildZip([
        { name: "ok.txt", data: Buffer.from("fine") },
        { name: "liar.bin", data: Buffer.alloc(1_000_000), method: 8, declaredSize: 100 },
      ])
    );

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: expect.stringMatching(/more than its declared 100 bytes/) }]);
    expect(fs.existsSync(path.join(dir, "liar"))).toBe(false);
  });

  it("refuses entries that would be written outside the extraction folder", async () => {
    const dir = path.join(downloadsDir, "Zip.Slip.Release");
    const archive = writeFile(path.join(dir, "slip.zip"), buildZip([{ name: "../escaped.txt", data: Buffer.from("nope") }]));

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: expect.stringMatching(/outside its folder/) }]);
    expect(fs.existsSync(path.join(dir, "escaped.txt"))).toBe(false);
  });

  it("reports a password-protected zip instead of writing garbage", async () => {
    const dir = path.join(downloadsDir, "Encrypted.Release");
    const archive = writeFile(path.join(dir, "locked.zip"), buildZip([{ name: "movie.mkv", data: Buffer.from("ciphertext"), flags: 0x801 }]));

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: "archive is password-protected" }]);
    expect(fs.existsSync(path.join(dir, "locked"))).toBe(false);
  });

  it.each([
    { method: 0 as const, label: "stored" },
    { method: 8 as const, label: "deflated" },
  ])("reports a $label entry whose bytes don't match its CRC instead of unpacking it", async ({ method, label }) => {
    const dir = path.join(downloadsDir, `Bad.Crc.${label}.Release`);
    const archive = writeFile(path.join(dir, "damaged.zip"), buildZip([{ name: "movie.mkv", data: Buffer.from("damaged video bytes"), method, crc: 0x12345678 }]));

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: 'archive entry "movie.mkv" failed its CRC check' }]);
    expect(fs.existsSync(path.join(dir, "damaged"))).toBe(false);
    expect(fs.existsSync(markerFor(archive))).toBe(false);
  });

  it("remembers a failed archive instead of retrying it every pass, until the file changes", async () => {
    const dir = path.join(downloadsDir, "Corrupt.Zip.Release");
    const archive = writeFile(path.join(dir, "corrupt.zip"), "this is not a zip file at all");
    const warn = vi.spyOn(log, "warn");

    const first = await unpackDownloadedArchives(scopeFor(dir));
    const second = await unpackDownloadedArchives(scopeFor(dir));

    expect(first.failed).toHaveLength(1);
    expect(second.failed).toEqual(first.failed);
    expect(warn).toHaveBeenCalledTimes(1);

    makeZip(archive, { "fixed.mkv": "repaired download" });
    const third = await unpackDownloadedArchives(scopeFor(dir));
    expect(third.extracted).toEqual([archive]);
    expect(fs.readFileSync(path.join(dir, "corrupt", "fixed.mkv"), "utf-8")).toBe("repaired download");
  });
});

describe("unpackDownloadedArchives — zip checksums", () => {
  function scopeFor(dir: string) {
    return { downloadPath: dir, releaseTitle: path.basename(dir) };
  }

  it("computes the same CRC-32 as zlib without it, whole and in chunks", () => {
    for (const sample of [Buffer.alloc(0), Buffer.from("The quick brown fox"), crypto.randomBytes(200_000)]) {
      const expected = zlib.crc32(sample);
      expect(tableCrc32(sample)).toBe(expected);
      let running = 0;
      for (let i = 0; i < sample.length; i += 7_001) running = tableCrc32(sample.subarray(i, i + 7_001), running);
      expect(running).toBe(expected);
      const half = Math.floor(sample.length / 2);
      expect(tableCrc32(sample.subarray(half), zlib.crc32(sample.subarray(0, half)))).toBe(expected);
    }
  });

  it("unpacks and checks entries on a Node without zlib.crc32", async () => {
    const payload = crypto.randomBytes(300_000);
    const goodDir = path.join(downloadsDir, "No.Zlib.Crc.Good.2023");
    const good = writeFile(
      path.join(goodDir, "good.zip"),
      buildZip([
        { name: "stored.bin", data: payload },
        { name: "deflated.bin", data: payload, method: 8 },
      ])
    );
    const badDir = path.join(downloadsDir, "No.Zlib.Crc.Bad.2023");
    const bad = writeFile(path.join(badDir, "bad.zip"), buildZip([{ name: "movie.mkv", data: payload, crc: 0x12345678 }]));
    const mutableZlib = zlib as unknown as { crc32: unknown };
    const original = mutableZlib.crc32;
    mutableZlib.crc32 = undefined;
    try {
      const goodResult = await unpackDownloadedArchives(scopeFor(goodDir));
      const badResult = await unpackDownloadedArchives(scopeFor(badDir));

      expect(goodResult).toEqual({ extracted: [good], failed: [] });
      expect(fs.readFileSync(path.join(goodDir, "good", "stored.bin")).equals(payload)).toBe(true);
      expect(fs.readFileSync(path.join(goodDir, "good", "deflated.bin")).equals(payload)).toBe(true);
      expect(badResult.failed).toEqual([{ archive: bad, reason: 'archive entry "movie.mkv" failed its CRC check' }]);
    } finally {
      mutableZlib.crc32 = original;
    }
  });

  it("fails the archive instead of hanging when the checksum step throws", async () => {
    const dir = path.join(downloadsDir, "Crc.Throws.Release.2023");
    const archive = writeFile(path.join(dir, "movie.zip"), buildZip([{ name: "movie.mkv", data: Buffer.from("video bytes"), method: 8 }]));
    vi.spyOn(zlib, "crc32").mockImplementation(() => {
      throw new TypeError("zlib.crc32 is not a function");
    });

    const result = await unpackDownloadedArchives(scopeFor(dir));

    expect(result.failed).toEqual([{ archive, reason: "zlib.crc32 is not a function" }]);
    expect(fs.existsSync(path.join(dir, "movie"))).toBe(false);
    expect(fs.existsSync(markerFor(archive))).toBe(false);
  });
});

describe("unpackDownloadedArchives — rar/7z tools", () => {
  let toolDir: string;
  let callLog: string;

  beforeAll(() => {
    toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-fake-unrar-"));
    callLog = path.join(toolDir, "calls.log");
    process.env.FAKE_UNRAR_LOG = callLog;
    process.env.FAKE_UNRAR_SIZE = "1000";
    // Stands in for unrar: a technical listing for "lt" ($FAKE_UNRAR_LISTING, or one file of
    // $FAKE_UNRAR_SIZE bytes, plus $FAKE_UNRAR_LT_STDERR on stderr, or a small entry, then
    // $FAKE_UNRAR_LT_PAD bytes of padding, then a huge one), one extracted file for "x", and a
    // failure when $FAKE_UNRAR_FAIL is set: its text on stderr, exit code $FAKE_UNRAR_FAIL_CODE (3).
    fs.writeFileSync(
      path.join(toolDir, "unrar"),
      [
        "#!/bin/sh",
        'echo "$@" >> "$FAKE_UNRAR_LOG"',
        'if [ -n "$FAKE_UNRAR_FAIL" ]; then',
        '  echo "$FAKE_UNRAR_FAIL" >&2',
        '  exit "${FAKE_UNRAR_FAIL_CODE:-3}"',
        "fi",
        'if [ "$1" = "lt" ] && [ -n "$FAKE_UNRAR_LT_STDERR" ]; then',
        '  echo "$FAKE_UNRAR_LT_STDERR" >&2',
        "fi",
        'if [ "$1" = "lt" ] && [ -n "$FAKE_UNRAR_LT_PAD" ]; then',
        '  printf "Archive: x\\n\\n        Name: movie.mkv\\n        Type: File\\n        Size: 1000\\n"',
        "  head -c \"$FAKE_UNRAR_LT_PAD\" /dev/zero | tr '\\0' ' '",
        '  printf "\\n        Name: bomb.bin\\n        Type: File\\n        Size: 214748364800\\n"',
        "  exit 0",
        "fi",
        'if [ "$1" = "lt" ] && [ -n "$FAKE_UNRAR_LISTING" ]; then',
        '  echo "$FAKE_UNRAR_LISTING"',
        "  exit 0",
        "fi",
        'if [ "$1" = "lt" ]; then',
        '  printf "Archive: x\\n\\n        Name: movie.mkv\\n        Type: File\\n        Size: %s\\n Packed size: 900\\n" "$FAKE_UNRAR_SIZE"',
        "  exit 0",
        "fi",
        'if [ "$1" = "x" ]; then',
        '  for a in "$@"; do dest="$a"; done',
        '  echo video > "${dest}movie.mkv"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    // Stands in for p7zip's 7z, printing what 7-Zip really does: an "l -slt" listing of one file
    // ("Encrypted = +" when $FAKE_7Z_ENCRYPTED is set), one extracted file for "x", and 7-Zip's
    // wrong-password failure for an archive with encrypted file names when $FAKE_7Z_ENCRYPTED_NAMES is set.
    fs.writeFileSync(
      path.join(toolDir, "7z"),
      [
        "#!/bin/sh",
        'echo "$@" >> "$FAKE_UNRAR_LOG"',
        'for a in "$@"; do last="$a"; done',
        'if [ -n "$FAKE_7Z_ENCRYPTED_NAMES" ]; then',
        '  printf "\\nERROR: %s : Cannot open encrypted archive. Wrong password?\\n\\nERRORS:\\nHeaders Error\\n\\n" "$last" >&2',
        "  exit 2",
        "fi",
        'if [ "$1" = "l" ]; then',
        "  encrypted=-",
        '  [ -n "$FAKE_7Z_ENCRYPTED" ] && encrypted=+',
        '  printf "%s\\nPath = %s\\nType = 7z\\nPhysical Size = 900\\n\\n%s\\nPath = movie.mkv\\nSize = 1000\\nPacked Size = 900\\nEncrypted = %s\\n\\n" "--" "$last" "----------" "$encrypted"',
        "  exit 0",
        "fi",
        'if [ "$1" = "x" ]; then',
        '  dest="${4#-o}"',
        '  mkdir -p "$dest" && echo video > "$dest/movie.mkv"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    fs.rmSync(callLog, { force: true });
    process.env.FAKE_UNRAR_SIZE = "1000";
    delete process.env.FAKE_UNRAR_FAIL;
    delete process.env.FAKE_UNRAR_FAIL_CODE;
    delete process.env.FAKE_UNRAR_LISTING;
    delete process.env.FAKE_UNRAR_LT_STDERR;
    delete process.env.FAKE_UNRAR_LT_PAD;
    delete process.env.FAKE_7Z_ENCRYPTED;
    delete process.env.FAKE_7Z_ENCRYPTED_NAMES;
  });

  function withFakeUnrar<T>(fn: () => Promise<T>): Promise<T> {
    return withPath(`${toolDir}${path.delimiter}${process.env.PATH}`, fn);
  }

  /** An `unrar lt -v` listing: one "Archive:" block per volume, each naming the entries it holds. */
  function unrarListing(volumes: { archive: string; entries: { name: string; size: number; ratio?: string }[] }[]): string {
    return volumes
      .map((v) =>
        [
          `Archive: ${v.archive}`,
          "Details: RAR 5, volume",
          ...v.entries.flatMap((e) => ["", `        Name: ${e.name}`, "        Type: File", `        Size: ${e.size}`, ` Packed size: 100`, `       Ratio: ${e.ratio ?? "1%"}`]),
        ].join("\n")
      )
      .join("\n\n");
  }

  it("fails explicitly, once, when unrar isn't installed", async () => {
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-no-tools-"));
    const dir = path.join(downloadsDir, "Needs.Unrar.Release");
    const archive = writeFile(path.join(dir, "needs.rar"), "not a real rar");
    const warn = vi.spyOn(log, "warn");

    const first = await withPath(emptyPath, () => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Needs.Unrar.Release" }));
    const second = await withPath(emptyPath, () => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Needs.Unrar.Release" }));

    expect(first.failed).toEqual([{ archive, reason: expect.stringMatching(/"unrar" program isn't installed/) }]);
    expect(second.failed).toEqual(first.failed);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(markerFor(archive))).toBe(false);
    expect(fs.existsSync(path.join(dir, "needs"))).toBe(false);
  });

  it("hands unrar only the first volume of a part set, with password prompts disabled", async () => {
    const dir = path.join(downloadsDir, "Movie.Rar.Release.2020.1080p");
    const part1 = writeFile(path.join(dir, "movie.part01.rar"), "volume one");
    writeFile(path.join(dir, "movie.part02.rar"), "volume two");

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Movie.Rar.Release.2020.1080p" }));

    expect(result).toEqual({ extracted: [part1], failed: [] });
    expect(fs.readFileSync(path.join(dir, "movie", "movie.mkv"), "utf-8").trim()).toBe("video");
    const calls = fs.readFileSync(callLog, "utf-8").trim().split("\n");
    expect(calls).toEqual([`lt -v -p- ${part1}`, `x -y -p- ${part1} ${path.join(dir, "movie")}${path.sep}`]);
  });

  it("refuses a rar whose listing would unpack to far more than the archive's size, without extracting", async () => {
    const dir = path.join(downloadsDir, "Rar.Bomb.Release");
    const archive = writeFile(path.join(dir, "bomb.rar"), "tiny");
    process.env.FAKE_UNRAR_SIZE = String(200 * 1024 ** 3);

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Rar.Bomb.Release" }));

    expect(result.failed).toEqual([{ archive, reason: expect.stringMatching(/would unpack to/) }]);
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([`lt -v -p- ${archive}`]);
  });

  it("counts an entry that only starts in a later volume against the limits", async () => {
    const dir = path.join(downloadsDir, "Hidden.Volume.Bomb.2022");
    const part1 = writeFile(path.join(dir, "hidden.part1.rar"), "v1");
    writeFile(path.join(dir, "hidden.part2.rar"), "v2");
    process.env.FAKE_UNRAR_LISTING = unrarListing([
      { archive: "hidden.part1.rar", entries: [{ name: "movie.mkv", size: 1000 }] },
      { archive: "hidden.part2.rar", entries: [{ name: "info.nfo", size: 200 * 1024 ** 3 }] },
    ]);

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Hidden.Volume.Bomb.2022" }));

    expect(result.failed).toEqual([{ archive: part1, reason: expect.stringMatching(/would unpack to/) }]);
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([`lt -v -p- ${part1}`]);
    expect(fs.existsSync(path.join(dir, "hidden"))).toBe(false);
  });

  it("counts a file split across volumes once, not once per volume", async () => {
    const dir = path.join(downloadsDir, "Split.Entry.Rar.2022");
    const part1 = writeFile(path.join(dir, "split.part1.rar"), "v1");
    writeFile(path.join(dir, "split.part2.rar"), "v2");
    writeFile(path.join(dir, "split.part3.rar"), "v3");
    // Under the allowance for an archive this small once, over it three times over.
    const size = 40 * 1024 ** 2;
    process.env.FAKE_UNRAR_LISTING = unrarListing([
      { archive: "split.part1.rar", entries: [{ name: "movie.mkv", size, ratio: "-->" }] },
      { archive: "split.part2.rar", entries: [{ name: "movie.mkv", size, ratio: "<->" }] },
      { archive: "split.part3.rar", entries: [{ name: "movie.mkv", size, ratio: "<--" }] },
    ]);

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Split.Entry.Rar.2022" }));

    expect(result).toEqual({ extracted: [part1], failed: [] });
  });

  it("tries a failed RAR set again once a later volume changes, though the first volume doesn't", async () => {
    const dir = path.join(downloadsDir, "Still.Downloading.Rar.2022");
    const part1 = writeFile(path.join(dir, "set.part1.rar"), "volume one");
    const part2 = writeFile(path.join(dir, "set.part2.rar"), "half of volume tw");
    const scope = { downloadPath: dir, releaseTitle: "Still.Downloading.Rar.2022" };
    process.env.FAKE_UNRAR_FAIL = "Bad archive set.part1.rar";

    const first = await withFakeUnrar(() => unpackDownloadedArchives(scope));
    expect(first.failed).toEqual([{ archive: part1, reason: expect.stringMatching(/Bad archive/) }]);

    delete process.env.FAKE_UNRAR_FAIL;
    fs.rmSync(callLog, { force: true });
    const unchanged = await withFakeUnrar(() => unpackDownloadedArchives(scope));
    expect(unchanged).toEqual(first);
    expect(fs.existsSync(callLog)).toBe(false);

    fs.appendFileSync(part2, "o");
    writeFile(path.join(dir, "set.part3.rar"), "volume three");
    const finished = await withFakeUnrar(() => unpackDownloadedArchives(scope));
    expect(finished).toEqual({ extracted: [part1], failed: [] });
    expect(fs.readFileSync(path.join(dir, "set", "movie.mkv"), "utf-8").trim()).toBe("video");
  });

  it("refuses a RAR set with a missing volume though unrar's listing exits 0, and tries again once it arrives", async () => {
    const dir = path.join(downloadsDir, "Missing.Volume.Rar.2023");
    const part1 = writeFile(path.join(dir, "x.part1.rar"), "volume one");
    writeFile(path.join(dir, "x.part3.rar"), "volume three");
    const scope = { downloadPath: dir, releaseTitle: "Missing.Volume.Rar.2023" };
    process.env.FAKE_UNRAR_LT_STDERR = "Cannot find volume x.part2.rar";

    const first = await withFakeUnrar(() => unpackDownloadedArchives(scope));

    expect(first.failed).toEqual([{ archive: part1, reason: "the RAR set is incomplete (Cannot find volume x.part2.rar)" }]);
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([`lt -v -p- ${part1}`]);
    expect(fs.existsSync(path.join(dir, "x"))).toBe(false);

    delete process.env.FAKE_UNRAR_LT_STDERR;
    writeFile(path.join(dir, "x.part2.rar"), "volume two");
    const complete = await withFakeUnrar(() => unpackDownloadedArchives(scope));
    expect(complete).toEqual({ extracted: [part1], failed: [] });
    expect(fs.readFileSync(path.join(dir, "x", "movie.mkv"), "utf-8").trim()).toBe("video");
  });

  it("refuses an archive whose listing is too long to check whole, without extracting", async () => {
    const dir = path.join(downloadsDir, "Long.Listing.Rar.2023");
    const archive = writeFile(path.join(dir, "long.rar"), "volume one");
    // Past the 64 MiB the listing is read up to; the huge entry comes after the padding.
    process.env.FAKE_UNRAR_LT_PAD = String(70_000_000);

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Long.Listing.Rar.2023" }));

    expect(result).toEqual({ extracted: [], failed: [{ archive, reason: "the archive's listing is more than 64 MiB, too large to check" }] });
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([`lt -v -p- ${archive}`]);
    expect(fs.existsSync(path.join(dir, "long"))).toBe(false);
  });

  it("reports a RAR with encrypted files as password-protected, without extracting", async () => {
    const dir = path.join(downloadsDir, "Encrypted.Files.Rar.2024");
    const archive = writeFile(path.join(dir, "enc.rar"), "volume one");
    process.env.FAKE_UNRAR_LISTING = [
      "Archive: enc.rar",
      "Details: RAR 5",
      "",
      "        Name: movie.mkv",
      "        Type: File",
      "        Size: 1000",
      " Packed size: 1032",
      "       Flags: encrypted ",
    ].join("\n");

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Encrypted.Files.Rar.2024" }));

    expect(result).toEqual({ extracted: [], failed: [{ archive, reason: "archive is password-protected" }] });
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([`lt -v -p- ${archive}`]);
    expect(fs.existsSync(path.join(dir, "enc"))).toBe(false);
  });

  it("reports a RAR with encrypted file names as password-protected (unrar exits 11 on a wrong password)", async () => {
    const dir = path.join(downloadsDir, "Encrypted.Names.Rar.2024");
    const archive = writeFile(path.join(dir, "henc.rar"), "volume one");
    process.env.FAKE_UNRAR_FAIL = "Incorrect password for henc.rar";
    process.env.FAKE_UNRAR_FAIL_CODE = "11";

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Encrypted.Names.Rar.2024" }));

    expect(result.failed).toEqual([{ archive, reason: "archive is password-protected" }]);
  });

  it("lists and unpacks a 7z archive with the arguments p7zip's 7z takes, with password prompts disabled", async () => {
    const dir = path.join(downloadsDir, "Seven.Zip.Release.2024");
    const archive = writeFile(path.join(dir, "movie.7z"), "7z bytes");

    const result = await withFakeUnrar(() => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Seven.Zip.Release.2024" }));

    expect(result).toEqual({ extracted: [archive], failed: [] });
    expect(fs.readFileSync(path.join(dir, "movie", "movie.mkv"), "utf-8").trim()).toBe("video");
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([
      `l -slt -p ${archive}`,
      `x -y -p -o${path.join(dir, "movie")} ${archive}`,
    ]);
  });

  it("reports an encrypted 7z archive as password-protected, whether or not its file names are encrypted too", async () => {
    const dir = path.join(downloadsDir, "Encrypted.Seven.Zip.2024");
    const archive = writeFile(path.join(dir, "enc.7z"), "7z bytes");
    const scope = { downloadPath: dir, releaseTitle: "Encrypted.Seven.Zip.2024" };
    process.env.FAKE_7Z_ENCRYPTED = "1";

    const contents = await withFakeUnrar(() => unpackDownloadedArchives(scope));
    expect(contents).toEqual({ extracted: [], failed: [{ archive, reason: "archive is password-protected" }] });
    expect(fs.readFileSync(callLog, "utf-8").trim().split("\n")).toEqual([`l -slt -p ${archive}`]);

    delete process.env.FAKE_7Z_ENCRYPTED;
    process.env.FAKE_7Z_ENCRYPTED_NAMES = "1";
    fs.appendFileSync(archive, " re-downloaded");
    const names = await withFakeUnrar(() => unpackDownloadedArchives(scope));
    expect(names.failed).toEqual([{ archive, reason: "archive is password-protected" }]);
    expect(fs.existsSync(path.join(dir, "enc"))).toBe(false);
  });

  it("fails explicitly when 7z isn't installed", async () => {
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-no-tools-"));
    const dir = path.join(downloadsDir, "Needs.Seven.Zip.2024");
    const archive = writeFile(path.join(dir, "needs.7z"), "not a real 7z");

    const result = await withPath(emptyPath, () => unpackDownloadedArchives({ downloadPath: dir, releaseTitle: "Needs.Seven.Zip.2024" }));

    expect(result.failed).toEqual([{ archive, reason: expect.stringMatching(/^7z archives can't be unpacked: the "7z" program isn't installed/) }]);
  });
});
