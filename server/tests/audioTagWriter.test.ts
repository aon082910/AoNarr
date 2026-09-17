import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import NodeID3 from "node-id3";
import { writeAudioTags } from "../src/services/audioTagWriter.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-audiotag-"));
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
});
