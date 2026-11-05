import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import NodeID3 from "node-id3";
import { writeAudioTags } from "../src/services/audioTagWriter.js";
import { isAudioFileLocked, resetAudioFileLocksForTests, tryLockAudioFile, unlockAudioFile } from "../src/services/audioFileLock.js";
import type { AudioTagInfo } from "../src/services/audioTagCommon.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-audiotag-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAudioFileLocksForTests();
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

describe("an MP3 whose file is replaced while its tagged copy is being made", () => {
  const info = { title: "New Title", artist: "Artist", album: "Album" };

  it("is not overwritten by the tagged copy of the bytes that were read before", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "replace-"));
    const filePath = path.join(dir, "track.mp3");
    fs.writeFileSync(filePath, Buffer.from("old mpeg frames"));
    const better = Buffer.from("the better file, from an upgrade import");
    // The import lands after the tagged copy is on disk and before it would be renamed over the path.
    const realChmod = fsp.chmod.bind(fsp);
    let replaced = false;
    vi.spyOn(fsp, "chmod").mockImplementation(async (...args: Parameters<typeof fsp.chmod>) => {
      if (!replaced && String(args[0]).includes(".aonarr-tmp-")) {
        replaced = true;
        const incoming = path.join(dir, "incoming.mp3");
        fs.writeFileSync(incoming, better);
        fs.renameSync(incoming, filePath);
      }
      return realChmod(...args);
    });

    const result = await writeAudioTags(filePath, info);

    expect(replaced).toBe(true);
    expect(result).toEqual({ outcome: "skipped", reason: "the file changed while it was being tagged", format: "MP3" });
    expect(fs.readFileSync(filePath).equals(better)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["track.mp3"]);
  });

  it("is not recreated by the tagged copy when the file is moved away in that window", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "gone-"));
    const filePath = path.join(dir, "track.mp3");
    fs.writeFileSync(filePath, Buffer.from("old mpeg frames"));
    const realChmod = fsp.chmod.bind(fsp);
    vi.spyOn(fsp, "chmod").mockImplementation(async (...args: Parameters<typeof fsp.chmod>) => {
      if (String(args[0]).includes(".aonarr-tmp-")) fs.rmSync(filePath);
      return realChmod(...args);
    });

    const result = await writeAudioTags(filePath, info);

    expect(result.outcome).toBe("skipped");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("is not written when the file was appended to in that window", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "appended-"));
    const filePath = path.join(dir, "track.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    const realChmod = fsp.chmod.bind(fsp);
    vi.spyOn(fsp, "chmod").mockImplementation(async (...args: Parameters<typeof fsp.chmod>) => {
      if (String(args[0]).includes(".aonarr-tmp-")) fs.appendFileSync(filePath, "more frames");
      return realChmod(...args);
    });

    expect(await writeAudioTags(filePath, info)).toMatchObject({ outcome: "skipped", reason: "the file changed while it was being tagged" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("mpeg framesmore frames");
    expect(fs.readdirSync(dir)).toEqual(["track.mp3"]);
  });
});

describe("one writer per file", () => {
  const info = { title: "Locked", artist: "Artist", album: "Album" };

  it("leaves an MP3 alone while an import is replacing it, and tags it once the import is done", async () => {
    const filePath = path.join(tmpDir, "locked.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    expect(tryLockAudioFile(filePath)).toBe(true);

    const busy = await writeAudioTags(filePath, info);

    expect(busy).toEqual({ outcome: "skipped", reason: "it is being replaced or tagged right now", format: "MP3" });
    expect(NodeID3.read(filePath).title).toBeUndefined();
    unlockAudioFile(filePath);
    expect((await writeAudioTags(filePath, info)).outcome).toBe("written");
    expect(isAudioFileLocked(filePath)).toBe(false);
  });

  it("a write that waits for the lock (an import's own) tags the file the import left", async () => {
    const filePath = path.join(tmpDir, "locked-wait.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    tryLockAudioFile(filePath);
    setTimeout(() => {
      fs.writeFileSync(filePath, Buffer.from("the upgraded mpeg frames"));
      unlockAudioFile(filePath);
    }, 40);

    const result = await writeAudioTags(filePath, info, { lockWaitMs: 2_000 });

    expect(result.outcome).toBe("written");
    const data = fs.readFileSync(filePath);
    expect(data.subarray(data.length - 24).toString()).toBe("the upgraded mpeg frames");
    expect(NodeID3.read(filePath).title).toBe("Locked");
  });

  it("two writes of one file at once: the second is skipped, not run over the first", async () => {
    const filePath = path.join(tmpDir, "twice.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));

    const [first, second] = await Promise.all([writeAudioTags(filePath, info), writeAudioTags(filePath, { ...info, title: "Other" })]);

    expect([first.outcome, second.outcome]).toEqual(["written", "skipped"]);
    expect(second.reason).toBe("it is being replaced or tagged right now");
    expect(NodeID3.read(filePath).title).toBe("Locked");
  });
});

describe("the old on/off switch (legacy)", () => {
  const info: AudioTagInfo = {
    title: "New Title",
    artist: "New Artist",
    albumArtist: "Album Artist",
    album: "New Album",
    trackNumber: 3,
    trackTotal: 12,
    discNumber: 1,
    year: "2021",
    date: "2021-05-04",
    genre: "Rock",
    composer: "A Narrator",
    series: "The Series",
    seriesPart: "2",
    musicbrainz: { artistId: "mb-artist", releaseGroupId: "mb-group" },
  };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);

  it("writes the five fields it always wrote and nothing else", async () => {
    const filePath = path.join(tmpDir, "legacy.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));

    const result = await writeAudioTags(filePath, info, { legacy: true });

    expect(result.outcome).toBe("written");
    const tags = NodeID3.read(filePath);
    expect(tags).toMatchObject({ title: "New Title", artist: "New Artist", album: "New Album", year: "2021" });
    // The track number is the plain number, as the old writer wrote it.
    expect(tags.trackNumber).toBe("3");
    for (const absent of ["performerInfo", "partOfSet", "genre", "composer", "contentGroup", "userDefinedText", "image"] as const) expect(tags[absent], absent).toBeUndefined();
  });

  it("leaves every other frame of the file as it is, and ignores the scrub and cover options", async () => {
    const filePath = path.join(tmpDir, "legacy-own.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    NodeID3.write(
      {
        title: "Old",
        performerInfo: "My Album Artist",
        genre: "Jazz",
        composer: "My Composer",
        partOfSet: "2/3",
        comment: { language: "eng", text: "keep me" },
        userDefinedText: [{ description: "SERIES", value: "Mine" }],
      },
      filePath
    );

    const result = await writeAudioTags(filePath, info, { legacy: true, scrub: true, cover: { data: jpeg, mime: "image/jpeg" } });

    expect(result.outcome).toBe("written");
    const tags = NodeID3.read(filePath);
    expect(tags.title).toBe("New Title");
    expect(tags).toMatchObject({ performerInfo: "My Album Artist", genre: "Jazz", composer: "My Composer", partOfSet: "2/3" });
    expect(tags.comment).toMatchObject({ text: "keep me" });
    expect(tags.userDefinedText).toEqual([{ description: "SERIES", value: "Mine" }]);
    expect(tags.image).toBeUndefined();
    // The same call a second time has nothing to do.
    expect(await writeAudioTags(filePath, info, { legacy: true })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
  });

  it("skips every other format with the reason, without starting ffprobe or ffmpeg", async () => {
    const runner = vi.fn();
    for (const [name, label] of [
      ["legacy.flac", "FLAC"],
      ["legacy.m4a", "M4A/M4B"],
      ["legacy.m4b", "M4A/M4B"],
      ["legacy.ogg", "OGG"],
      ["legacy.opus", "Opus"],
    ] as const) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, Buffer.from("not touched"));
      const result = await writeAudioTags(filePath, info, { legacy: true, runner });
      expect(result, name).toEqual({ outcome: "skipped", reason: "legacy setting: MP3 only", format: label });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("not touched");
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("without the legacy option the same call writes everything", async () => {
    const filePath = path.join(tmpDir, "not-legacy.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    await writeAudioTags(filePath, info);
    expect(NodeID3.read(filePath)).toMatchObject({ performerInfo: "Album Artist", genre: "Rock", composer: "A Narrator", trackNumber: "3/12" });
  });
});

describe("free space before a tag rewrite of an MP3", () => {
  const info = { title: "Roomy", artist: "Artist", album: "Album" };
  const free = (bytes: number) => async () => ({ bavail: Math.floor(bytes / 4096), bsize: 4096, blocks: 10_000_000 });

  it("skips the file when the folder cannot hold a copy of it and 256 MB more", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "space-"));
    const filePath = path.join(dir, "track.mp3");
    const audio = Buffer.from("mpeg frames");
    fs.writeFileSync(filePath, audio);
    const asked: string[] = [];

    const result = await writeAudioTags(filePath, info, { statfs: async (folder) => (asked.push(folder), free(100 * 1024 * 1024)()) });

    expect(result).toEqual({ outcome: "skipped", reason: "not enough free space", format: "MP3" });
    expect(asked).toEqual([dir]);
    expect(fs.readFileSync(filePath).equals(audio)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["track.mp3"]);
  });

  it("writes when the room is there, and does not ask about a file whose tags are already right", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "space-ok-"));
    const filePath = path.join(dir, "track.mp3");
    fs.writeFileSync(filePath, Buffer.from("mpeg frames"));
    expect((await writeAudioTags(filePath, info, { statfs: free(1024 * 1024 * 1024) })).outcome).toBe("written");

    const statfs = vi.fn(free(0));
    expect(await writeAudioTags(filePath, info, { statfs })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
    expect(statfs).not.toHaveBeenCalled();
  });
});
