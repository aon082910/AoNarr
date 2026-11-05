import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileAlbumTags } from "../src/services/discographyTags.js";
import { probeAudioTags } from "../src/services/ffprobe.js";

// Round 30h: the tags a folder is identified by are read with the real ffprobe here, so that the tag names the code looks for
// (album_artist, disc, date and the disc total of each format) are the ones ffprobe really gives. The node image has no ffmpeg:
// run this in a container that installs it (apt-get install ffmpeg); without it the cases skip themselves.
const hasFfmpeg = ["ffmpeg", "ffprobe"].every((tool) => !spawnSync(tool, ["-version"]).error);

describe.skipIf(!hasFfmpeg)("reading album tags with the real ffprobe", () => {
  let dir: string;

  /** A tenth of a second of silence in the format the extension names, with the tags given. */
  function makeAudio(name: string, tags: Record<string, string>): string {
    const file = path.join(dir, name);
    const args = ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.1"];
    for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
    const made = spawnSync("ffmpeg", [...args, "-y", file]);
    if (made.status !== 0) throw new Error(`ffmpeg could not make ${name}: ${made.stderr?.toString()}`);
    return file;
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-tags-ffprobe-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the album, album artist, year and disc of a FLAC file", async () => {
    const file = makeAudio("one.flac", { album: "A Night at the Opera", album_artist: "Queen", artist: "Queen feat. Guest", date: "1975-11-21", discnumber: "2", disctotal: "3" });
    expect(await readFileAlbumTags(file)).toEqual({ album: "A Night at the Opera", artist: "Queen", year: 1975, disc: 2, discTotal: 3 });
  });

  it("reads an MP3 file's disc as 'n/m' and its date", async () => {
    const file = makeAudio("one.mp3", { album: "Queen II", album_artist: "Queen", artist: "Queen", date: "1974", disc: "1/2" });
    expect(await readFileAlbumTags(file)).toEqual({ album: "Queen II", artist: "Queen", year: 1974, disc: 1, discTotal: 2 });
  });

  it("reads a track's number and the track total of its disc, as 'n/m' or as a separate tag (L11)", async () => {
    const flac = makeAudio("track.flac", { album: "Queen II", album_artist: "Queen", tracknumber: "3", tracktotal: "11" });
    expect(await readFileAlbumTags(flac)).toMatchObject({ track: 3, trackTotal: 11 });
    const mp3 = makeAudio("track.mp3", { album: "Queen II", album_artist: "Queen", track: "4/12" });
    expect(await readFileAlbumTags(mp3)).toMatchObject({ track: 4, trackTotal: 12 });
    const bare = makeAudio("notrack.flac", { album: "Queen II", album_artist: "Queen" });
    const read = await readFileAlbumTags(bare);
    expect(read?.track).toBeUndefined();
    expect(read?.trackTotal).toBeUndefined();
  });

  it("reads an M4A file's tags", async () => {
    const file = makeAudio("one.m4a", { album: "Sheer Heart Attack", album_artist: "Queen", date: "1974-11-08", disc: "1/1" });
    expect(await readFileAlbumTags(file)).toMatchObject({ album: "Sheer Heart Attack", artist: "Queen", year: 1974, disc: 1, discTotal: 1 });
  });

  it("gives a file with no tags an empty answer, a file that is not audio no album, and a missing file none", async () => {
    const bare = makeAudio("bare.flac", {});
    expect(await readFileAlbumTags(bare)).toEqual({ album: null, artist: null, year: null, disc: null, discTotal: null });
    const text = path.join(dir, "notes.flac");
    fs.writeFileSync(text, "this is not audio");
    // ffprobe may or may not make something of a text file; either way it names no album.
    expect((await readFileAlbumTags(text))?.album ?? null).toBeNull();
    expect(await readFileAlbumTags(path.join(dir, "gone.flac"))).toBeNull();
  });

  it("still gives the original five fields to the callers that use only those", async () => {
    const file = makeAudio("old.flac", { album: "Queen II", album_artist: "Queen", artist: "Freddie", title: "Procession" });
    expect(await probeAudioTags(file)).toMatchObject({ artist: "Freddie", albumArtist: "Queen", album: "Queen II", title: "Procession", author: null });
  });
});

// Without ffprobe (the node image): the step gives no answer and says nothing, so an import goes on by the folders' names.
describe.skipIf(hasFfmpeg)("reading album tags without ffprobe", () => {
  it("gives no answer and does not throw", async () => {
    expect(await readFileAlbumTags("/downloads/a/01.flac")).toBeNull();
  });
});
