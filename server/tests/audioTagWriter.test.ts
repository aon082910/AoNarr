import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import NodeID3 from "node-id3";
import { writeAudioTags } from "../src/services/audioTagWriter.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-audiotag-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeAudioTags", () => {
  it("writes real, readable ID3v2 tags into an mp3 file", async () => {
    const filePath = path.join(tmpDir, "track.mp3");
    fs.writeFileSync(filePath, "");

    await writeAudioTags(filePath, { title: "Test Title", artist: "Test Artist", album: "Test Album", trackNumber: 3, year: "2021" });

    const tags = await NodeID3.Promise.read(filePath);
    expect(tags.title).toBe("Test Title");
    expect(tags.artist).toBe("Test Artist");
    expect(tags.album).toBe("Test Album");
    expect(tags.trackNumber).toBe("3");
    expect(tags.year).toBe("2021");
  });

  it("leaves a file of a format that cannot be tagged completely untouched, and says so", async () => {
    const filePath = path.join(tmpDir, "track.wav");
    fs.writeFileSync(filePath, "original wav bytes, not touched");

    const result = await writeAudioTags(filePath, { title: "Should Not Apply", artist: "Nobody", album: "Nothing" });

    expect(result).toMatchObject({ outcome: "skipped", format: "WAV" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original wav bytes, not touched");
  });

  it("leaves a FLAC file that is not audio untouched and leaves no temp file behind", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "notflac-"));
    const filePath = path.join(dir, "track.flac");
    fs.writeFileSync(filePath, "original flac bytes, not touched");

    // Whether ffmpeg is installed here or not, the answer is the same: not written, nothing changed.
    const result = await writeAudioTags(filePath, { title: "Should Not Apply", artist: "Nobody", album: "Nothing" });

    expect(result.outcome).toBe("failed");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("original flac bytes, not touched");
    expect(fs.readdirSync(dir)).toEqual(["track.flac"]);
  });

  it("never throws when the target mp3 file doesn't exist", async () => {
    const filePath = path.join(tmpDir, "does-not-exist.mp3");

    await expect(writeAudioTags(filePath, { title: "X", artist: "Y", album: "Z" })).resolves.toMatchObject({ outcome: "skipped" });
  });

  it("omits trackNumber/year when they aren't provided, without erroring", async () => {
    const filePath = path.join(tmpDir, "no-optional-fields.mp3");
    fs.writeFileSync(filePath, "");

    await writeAudioTags(filePath, { title: "Minimal Tags", artist: "Someone", album: "Something" });

    const tags = await NodeID3.Promise.read(filePath);
    expect(tags.title).toBe("Minimal Tags");
    expect(tags.trackNumber).toBeUndefined();
  });

  it("tags a file of its own by replacing it, keeping the audio and its permissions", async () => {
    const filePath = path.join(tmpDir, "own-copy.mp3");
    const audio = Buffer.from("pretend mpeg audio frames");
    fs.writeFileSync(filePath, audio);
    fs.chmodSync(filePath, 0o640);
    const before = fs.statSync(filePath);

    await writeAudioTags(filePath, { title: "Own Copy", artist: "Artist", album: "Album" });

    const after = fs.statSync(filePath);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
    const data = fs.readFileSync(filePath);
    expect(data.subarray(data.length - audio.length).equals(audio)).toBe(true);
    expect((await NodeID3.Promise.read(filePath)).title).toBe("Own Copy");
  });

  it("writes the tagged copy without blocking file calls, leaving no temp file beside it", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "async-"));
    const filePath = path.join(dir, "audiobook.mp3");
    const audio = Buffer.alloc(4 * 1024 ** 2, 0x55);
    fs.writeFileSync(filePath, audio);
    const syncCalls = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "renameSync"), vi.spyOn(fs, "chmodSync")];

    await writeAudioTags(filePath, { title: "Long Audiobook", artist: "Narrator", album: "Book" });

    for (const spy of syncCalls) expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(["audiobook.mp3"]);
    const data = fs.readFileSync(filePath);
    expect(data.subarray(data.length - audio.length).equals(audio)).toBe(true);
    expect((await NodeID3.Promise.read(filePath)).title).toBe("Long Audiobook");
  });

  it("flushes the tagged copy to disk and closes it before renaming it over the original", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "durable-"));
    const filePath = path.join(dir, "track.mp3");
    fs.writeFileSync(filePath, Buffer.from("original audio"));
    const events: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await realOpen(...args);
      const realSync = fh.sync.bind(fh);
      const realClose = fh.close.bind(fh);
      fh.sync = async () => {
        events.push("sync");
        return realSync();
      };
      fh.close = async () => {
        events.push("close");
        return realClose();
      };
      return fh;
    });
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      events.push("rename");
      return realRename(from, to);
    });

    await writeAudioTags(filePath, { title: "Durable", artist: "Artist", album: "Album" });

    expect(events).toEqual(["sync", "close", "rename"]);
    expect(fs.readdirSync(dir)).toEqual(["track.mp3"]);
    expect((await NodeID3.Promise.read(filePath)).title).toBe("Durable");
  });

  it("keeps the original and removes its temp file when the replace fails", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "failed-"));
    const filePath = path.join(dir, "track.mp3");
    const audio = Buffer.from("original audio");
    fs.writeFileSync(filePath, audio);
    vi.spyOn(fsp, "rename").mockRejectedValue(new Error("EXDEV: cross-device link not permitted"));

    await expect(writeAudioTags(filePath, { title: "X", artist: "Y", album: "Z" })).resolves.toMatchObject({ outcome: "failed" });

    expect(fs.readdirSync(dir)).toEqual(["track.mp3"]);
    expect(fs.readFileSync(filePath).equals(audio)).toBe(true);
  });

  it("leaves an MP3 too large to hold in memory alone, and says so", async () => {
    const filePath = path.join(tmpDir, "huge.mp3");
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, 600 * 1024 * 1024); // sparse: no disk is used

    const result = await writeAudioTags(filePath, { title: "X", artist: "Y", album: "Z" });

    expect(result).toMatchObject({ outcome: "skipped", format: "MP3" });
    expect(result.reason).toMatch(/over 512 MB/);
    expect(fs.statSync(filePath).size).toBe(600 * 1024 * 1024);
    fs.rmSync(filePath);
  });

  it("scrubs an MP3's other tags, keeps its picture, and a second pass has nothing to do", async () => {
    const filePath = path.join(tmpDir, "scrub.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    const picture = { mime: "image/jpeg", type: { id: 3 }, description: "Front", imageBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
    NodeID3.write({ title: "Old", comment: { language: "eng", text: "remove me" }, copyright: "(c)", image: picture }, filePath);

    const first = await writeAudioTags(filePath, { title: "New", artist: "A", album: "B" }, { scrub: true });

    expect(first.outcome).toBe("written");
    const tags = NodeID3.read(filePath);
    expect(tags.title).toBe("New");
    expect(tags.comment).toBeUndefined();
    expect(tags.copyright).toBeUndefined();
    expect((tags.image as { imageBuffer: Buffer }).imageBuffer.equals(picture.imageBuffer)).toBe(true);
    expect(await writeAudioTags(filePath, { title: "New", artist: "A", album: "B" }, { scrub: true })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
  });

  it("puts a cover in an MP3 that has none, but not over the one it has", async () => {
    const filePath = path.join(tmpDir, "cover.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    const info = { title: "T", artist: "A", album: "B" };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8, 1)]);

    expect(await writeAudioTags(filePath, info, { cover: { data: jpeg, mime: "image/jpeg" } })).toMatchObject({ outcome: "written" });
    expect((NodeID3.read(filePath).image as { mime: string }).mime).toBe("image/jpeg");
    const other = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8, 2)]);
    expect(await writeAudioTags(filePath, info, { cover: { data: other, mime: "image/png" } })).toMatchObject({ outcome: "skipped" });
    expect((NodeID3.read(filePath).image as { mime: string }).mime).toBe("image/jpeg");
  });

  it("writes the album artist, disc, genre, composer, series and MusicBrainz ids an audiobook or album carries", async () => {
    const filePath = path.join(tmpDir, "full.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));

    await writeAudioTags(filePath, {
      title: "T",
      artist: "A",
      albumArtist: "AA",
      album: "B",
      trackNumber: 2,
      trackTotal: 9,
      discNumber: 1,
      discTotal: 2,
      year: "2018",
      genre: "Rock",
      composer: "Narrator",
      series: "Series",
      seriesPart: "4",
      musicbrainz: { artistId: "artist-1", releaseGroupId: "group-1" },
    });

    const tags = NodeID3.read(filePath);
    expect(tags).toMatchObject({ performerInfo: "AA", trackNumber: "2/9", partOfSet: "1/2", year: "2018", genre: "Rock", composer: "Narrator", contentGroup: "Series" });
    expect(tags.userDefinedText).toEqual(
      expect.arrayContaining([
        { description: "SERIES", value: "Series" },
        { description: "SERIES-PART", value: "4" },
        { description: "MusicBrainz Artist Id", value: "artist-1" },
        { description: "MusicBrainz Release Group Id", value: "group-1" },
      ])
    );
  });

  it("leaves a hardlinked import and the download it shares data with byte-identical", async () => {
    const download = path.join(tmpDir, "seeding.mp3");
    const library = path.join(tmpDir, "hardlinked.mp3");
    const audio = Buffer.from("seeding torrent payload");
    fs.writeFileSync(download, audio);
    fs.linkSync(download, library);

    await writeAudioTags(library, { title: "Should Not Apply", artist: "Nobody", album: "Nothing" });

    expect(fs.readFileSync(download).equals(audio)).toBe(true);
    expect(fs.readFileSync(library).equals(audio)).toBe(true);
    expect(fs.statSync(library).ino).toBe(fs.statSync(download).ino);
  });

  it("leaves a symlinked import and the file it points at byte-identical", async () => {
    const download = path.join(tmpDir, "mounted.mp3");
    const library = path.join(tmpDir, "symlinked.mp3");
    const audio = Buffer.from("file on the download mount");
    fs.writeFileSync(download, audio);
    fs.symlinkSync(download, library);

    await writeAudioTags(library, { title: "Should Not Apply", artist: "Nobody", album: "Nothing" });

    expect(fs.readFileSync(download).equals(audio)).toBe(true);
    expect(fs.lstatSync(library).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(library).equals(audio)).toBe(true);
  });
});
