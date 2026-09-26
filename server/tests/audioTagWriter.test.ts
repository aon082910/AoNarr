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

  it("leaves a non-mp3 file completely untouched", async () => {
    const filePath = path.join(tmpDir, "track.flac");
    fs.writeFileSync(filePath, "original flac bytes, not touched");

    await writeAudioTags(filePath, { title: "Should Not Apply", artist: "Nobody", album: "Nothing" });

    expect(fs.readFileSync(filePath, "utf-8")).toBe("original flac bytes, not touched");
  });

  it("never throws when the target mp3 file doesn't exist", async () => {
    const filePath = path.join(tmpDir, "does-not-exist.mp3");

    await expect(writeAudioTags(filePath, { title: "X", artist: "Y", album: "Z" })).resolves.not.toThrow();
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

    await expect(writeAudioTags(filePath, { title: "X", artist: "Y", album: "Z" })).resolves.toBeUndefined();

    expect(fs.readdirSync(dir)).toEqual(["track.mp3"]);
    expect(fs.readFileSync(filePath).equals(audio)).toBe(true);
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
