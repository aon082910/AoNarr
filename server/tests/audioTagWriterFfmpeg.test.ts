import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAudioTags } from "../src/services/audioTagWriter.js";
import { resetEmbedFailuresForTests } from "../src/services/audioTagFfmpeg.js";
import type { AudioTagInfo, CoverImage } from "../src/services/audioTagCommon.js";

// The real thing: tiny audio files made with ffmpeg itself, tagged by the writer, read back with ffprobe. Skipped when ffmpeg
// is not installed (the node image CI uses has none; the product image does).
const hasTool = (name: string) => spawnSync(name, ["-version"]).status === 0;
const available = hasTool("ffmpeg") && hasTool("ffprobe");

let dir: string;
let jpeg: Buffer;
let png: Buffer;

function ffmpeg(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", ...args]);
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${run.stderr.toString()}`);
}

function probe(file: string): any {
  return JSON.parse(spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file]).stdout.toString());
}

/** The container's tags and the first audio stream's, keys in lower case. */
function tagsOf(file: string): Record<string, string> {
  const json = probe(file);
  const out: Record<string, string> = {};
  const audio = (json.streams ?? []).find((s: any) => s.codec_type === "audio");
  for (const source of [json.format?.tags, audio?.tags]) for (const [k, v] of Object.entries(source ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

/** A checksum of the decoded audio: tagging must not change a sample. */
function audioChecksum(file: string): string {
  return spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "md5", "-"]).stdout.toString().trim();
}

function streamsOf(file: string, type: string): any[] {
  return (probe(file).streams ?? []).filter((s: any) => s.codec_type === type);
}

function leftovers(folder: string): string[] {
  return fs.readdirSync(folder).filter((name) => name.startsWith(".aonarr-tmp-"));
}

const INFO: AudioTagInfo = {
  title: "Song One",
  artist: "The Artist",
  albumArtist: "The Artist",
  album: "The Album",
  trackNumber: 3,
  trackTotal: 12,
  discNumber: 1,
  year: "2021",
  date: "2021-05-04",
  genre: "Rock",
  musicbrainz: { artistId: "11111111-1111-1111-1111-111111111111", releaseGroupId: "22222222-2222-2222-2222-222222222222" },
};

function fresh(name: string, make: (target: string) => void): string {
  const folder = fs.mkdtempSync(path.join(dir, "case-"));
  const file = path.join(folder, name);
  make(file);
  return file;
}

const sine = (extra: string[]) => (target: string) => ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", ...extra, target]);

describe.skipIf(!available)("writeAudioTags through ffmpeg (real files)", () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-ffmpeg-tags-"));
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", path.join(dir, "cover.jpg")]);
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1", path.join(dir, "cover.png")]);
    jpeg = fs.readFileSync(path.join(dir, "cover.jpg"));
    png = fs.readFileSync(path.join(dir, "cover.png"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    resetEmbedFailuresForTests();
  });

  const formats: { label: string; name: string; make: (target: string) => void; tagged: string[] }[] = [
    { label: "FLAC", name: "track.flac", make: sine(["-c:a", "flac"]), tagged: ["tracktotal", "musicbrainz_artistid", "musicbrainz_releasegroupid", "album_artist"] },
    { label: "M4A/M4B", name: "track.m4a", make: sine(["-c:a", "aac", "-b:a", "64k"]), tagged: ["album_artist"] },
    { label: "OGG", name: "track.ogg", make: sine(["-c:a", "libvorbis"]), tagged: ["tracktotal", "musicbrainz_artistid", "album_artist"] },
    { label: "Opus", name: "track.opus", make: sine(["-c:a", "libopus"]), tagged: ["tracktotal", "musicbrainz_artistid", "album_artist"] },
  ];

  for (const format of formats) {
    describe(format.label, () => {
      it("writes the tags, keeps the audio exactly, and a second run changes nothing", async () => {
        const file = fresh(format.name, format.make);
        const before = { sum: audioChecksum(file), duration: Number(probe(file).format.duration), streams: streamsOf(file, "audio").length, mode: 0o640 };
        fs.chmodSync(file, before.mode);

        const first = await writeAudioTags(file, INFO);

        expect(first).toMatchObject({ outcome: "written", format: format.label });
        const tags = tagsOf(file);
        expect(tags.title).toBe("Song One");
        expect(tags.artist).toBe("The Artist");
        expect(tags.album).toBe("The Album");
        expect(tags.date).toMatch(/^2021/);
        expect(tags.genre).toBe("Rock");
        expect(parseInt(tags.track, 10)).toBe(3);
        expect(parseInt(tags.disc, 10)).toBe(1);
        for (const key of format.tagged) expect(tags, key).toHaveProperty(key);
        if (format.label !== "M4A/M4B") expect(tags.musicbrainz_releasegroupid).toBe("22222222-2222-2222-2222-222222222222");
        expect(audioChecksum(file)).toBe(before.sum);
        expect(Math.abs(Number(probe(file).format.duration) - before.duration)).toBeLessThan(0.5);
        expect(streamsOf(file, "audio")).toHaveLength(before.streams);
        expect(fs.statSync(file).mode & 0o777).toBe(before.mode);
        expect(leftovers(path.dirname(file))).toEqual([]);

        // Idempotent: the tags are right, so the file is not touched at all.
        const inode = fs.statSync(file).ino;
        const mtime = fs.statSync(file).mtimeMs;
        const second = await writeAudioTags(file, INFO);
        expect(second).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
        expect(fs.statSync(file).ino).toBe(inode);
        expect(fs.statSync(file).mtimeMs).toBe(mtime);
      });

      it("replaces a value that is already there and keeps the tags it does not manage", async () => {
        const file = fresh(format.name, (target) => format.make(target));
        // Source file with a title and a tag AoNarr has no field for (the replay gain every ripper adds).
        const seeded = path.join(path.dirname(file), `seed${path.extname(file)}`);
        const muxer = format.label === "M4A/M4B" ? "ipod" : path.extname(file).slice(1) === "ogg" ? "ogg" : path.extname(file).slice(1);
        const extra = format.label === "M4A/M4B" ? ["-metadata", "comment=Ripped by hand"] : ["-metadata", "REPLAYGAIN_TRACK_GAIN=-3.20 dB"];
        ffmpeg(["-i", file, "-map", "0:a", "-c", "copy", "-metadata", "title=Old Title", ...extra, "-f", muxer, seeded]);
        fs.renameSync(seeded, file);

        const result = await writeAudioTags(file, INFO);

        expect(result.outcome).toBe("written");
        const tags = tagsOf(file);
        expect(tags.title).toBe("Song One");
        if (format.label === "M4A/M4B") expect(tags.comment).toBe("Ripped by hand");
        else expect(tags.replaygain_track_gain).toBe("-3.20 dB");
      });

      it("scrubs the tags it did not write when asked, and keeps writing the ones it did", async () => {
        const file = fresh(format.name, format.make);
        const seeded = path.join(path.dirname(file), `seed${path.extname(file)}`);
        const muxer = format.label === "M4A/M4B" ? "ipod" : path.extname(file).slice(1) === "ogg" ? "ogg" : path.extname(file).slice(1);
        ffmpeg(["-i", file, "-map", "0:a", "-c", "copy", "-metadata", "comment=Remove me", "-metadata", "title=Old", "-f", muxer, seeded]);
        fs.renameSync(seeded, file);
        expect(tagsOf(file).comment).toBe("Remove me");

        const result = await writeAudioTags(file, INFO, { scrub: true });

        expect(result.outcome).toBe("written");
        const tags = tagsOf(file);
        expect(tags.comment).toBeUndefined();
        expect(tags.title).toBe("Song One");
        // And a second scrubbing run has nothing left to do.
        expect(await writeAudioTags(file, INFO, { scrub: true })).toMatchObject({ outcome: "skipped" });
      });

      it("leaves the original alone and no temp file when the file cannot be read as audio", async () => {
        const file = fresh(format.name, (target) => fs.writeFileSync(target, Buffer.alloc(2048, 0x41)));
        const bytes = fs.readFileSync(file);

        const result = await writeAudioTags(file, INFO);

        expect(result.outcome).not.toBe("written");
        expect(fs.readFileSync(file).equals(bytes)).toBe(true);
        expect(leftovers(path.dirname(file))).toEqual([]);
      });
    });
  }

  describe("cover art", () => {
    it("puts a cover in a FLAC file without one, and keeps it on the next tag write", async () => {
      const file = fresh("cover.flac", sine(["-c:a", "flac"]));
      const cover: CoverImage = { data: jpeg, mime: "image/jpeg" };

      const result = await writeAudioTags(file, INFO, { cover });

      expect(result).toMatchObject({ outcome: "written" });
      expect(result.reason).toBeUndefined();
      expect(streamsOf(file, "video")).toHaveLength(1);
      expect(streamsOf(file, "video")[0].disposition.attached_pic).toBe(1);
      // A retag with new tags (and no cover offered) leaves the picture where it is.
      await writeAudioTags(file, { ...INFO, title: "Renamed" });
      expect(tagsOf(file).title).toBe("Renamed");
      expect(streamsOf(file, "video")).toHaveLength(1);
      expect(leftovers(path.dirname(file))).toEqual([]);
    });

    it("puts a PNG cover in an M4A file and replaces the picture it has when scrubbing", async () => {
      const file = fresh("cover.m4a", sine(["-c:a", "aac", "-b:a", "64k"]));
      expect(await writeAudioTags(file, INFO, { cover: { data: jpeg, mime: "image/jpeg" } })).toMatchObject({ outcome: "written" });
      expect(streamsOf(file, "video")[0].codec_name).toBe("mjpeg");

      // The file has a picture and the tags are right: a cover offered again changes nothing, scrubbing or not...
      const before = fs.statSync(file);
      expect(await writeAudioTags(file, INFO, { cover: { data: png, mime: "image/png" } })).toMatchObject({ outcome: "skipped" });
      expect(await writeAudioTags(file, INFO, { scrub: true, cover: { data: png, mime: "image/png" } })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
      expect(fs.statSync(file).ino).toBe(before.ino);
      expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
      // ...until the tags have to be rewritten anyway: then, scrubbing, the new cover takes the old one's place.
      expect(await writeAudioTags(file, { ...INFO, title: "Renamed" }, { scrub: true, cover: { data: png, mime: "image/png" } })).toMatchObject({ outcome: "written" });
      const pictures = streamsOf(file, "video");
      expect(pictures).toHaveLength(1);
      expect(pictures[0].codec_name).toBe("png");
      expect(tagsOf(file).title).toBe("Renamed");
    });

    it("does not copy a FLAC and an M4A again on every pass when the tags are scrubbed and a cover is on", async () => {
      const cover: CoverImage = { data: jpeg, mime: "image/jpeg" };
      for (const [name, make] of [
        ["every-pass.flac", sine(["-c:a", "flac"])],
        ["every-pass.m4a", sine(["-c:a", "aac", "-b:a", "64k"])],
      ] as const) {
        const file = fresh(name, make);
        expect(await writeAudioTags(file, INFO, { scrub: true, cover })).toMatchObject({ outcome: "written" });
        const written = fs.statSync(file);
        expect(streamsOf(file, "video")).toHaveLength(1);

        for (let pass = 0; pass < 3; pass++) {
          expect(await writeAudioTags(file, INFO, { scrub: true, cover }), name).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
        }
        expect(fs.statSync(file).ino, name).toBe(written.ino);
        expect(fs.statSync(file).mtimeMs, name).toBe(written.mtimeMs);
        expect(leftovers(path.dirname(file))).toEqual([]);
      }
    });

    it("writes the tags of an Ogg file and says the cover was left out (ffmpeg has no picture block for Ogg)", async () => {
      const file = fresh("cover.ogg", sine(["-c:a", "libvorbis"]));

      const result = await writeAudioTags(file, INFO, { cover: { data: jpeg, mime: "image/jpeg" } });

      expect(result.outcome).toBe("written");
      expect(result.reason).toMatch(/cover is left out/);
      expect(tagsOf(file).title).toBe("Song One");
      expect(streamsOf(file, "video")).toHaveLength(0);
    });

    it("still writes the tags when the cover is not a picture ffmpeg can read", async () => {
      const file = fresh("badcover.flac", sine(["-c:a", "flac"]));

      const result = await writeAudioTags(file, INFO, { cover: { data: Buffer.from("this is not an image at all"), mime: "image/jpeg" } });

      expect(result.outcome).toBe("written");
      expect(result.reason).toMatch(/cover not embedded/);
      expect(tagsOf(file).title).toBe("Song One");
      expect(leftovers(path.dirname(file))).toEqual([]);

      // And the next pass does not try the same picture again: the file is not rewritten for it.
      const written = fs.statSync(file);
      const cover = { data: Buffer.from("this is not an image at all"), mime: "image/jpeg" as const };
      expect(await writeAudioTags(file, INFO, { cover })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
      expect(fs.statSync(file).ino).toBe(written.ino);
      expect(fs.statSync(file).mtimeMs).toBe(written.mtimeMs);
    });

    it("leaves a file with right tags alone when only its picture is wanted and ffmpeg cannot take it", async () => {
      const file = fresh("onlycover.flac", sine(["-c:a", "flac"]));
      await writeAudioTags(file, INFO);
      const before = fs.statSync(file);
      const bytes = fs.readFileSync(file);
      const cover = { data: Buffer.from("not an image either"), mime: "image/jpeg" as const };

      const first = await writeAudioTags(file, INFO, { cover });

      expect(first.outcome).toBe("skipped");
      expect(first.reason).toMatch(/cover not embedded/);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(fs.statSync(file).ino).toBe(before.ino);
      expect(await writeAudioTags(file, INFO, { cover })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });
      expect(leftovers(path.dirname(file))).toEqual([]);
    });
  });

  it("skips a file the folder has no room to copy, with the real file system's numbers", async () => {
    const file = fresh("space.flac", sine(["-c:a", "flac"]));
    const bytes = fs.readFileSync(file);

    const result = await writeAudioTags(file, INFO, { statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 1_000_000 }) });

    expect(result).toEqual({ outcome: "skipped", reason: "not enough free space", format: "FLAC" });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(leftovers(path.dirname(file))).toEqual([]);
    // The real file system has room for a two second file.
    expect((await writeAudioTags(file, INFO)).outcome).toBe("written");
  });

  describe("an audiobook M4B", () => {
    function book(target: string): void {
      const meta = path.join(path.dirname(target), "chapters.txt");
      fs.writeFileSync(
        meta,
        [";FFMETADATA1", "title=Original", "[CHAPTER]", "TIMEBASE=1/1000", "START=0", "END=1000", "title=One", "[CHAPTER]", "TIMEBASE=1/1000", "START=1000", "END=2000", "title=Two", ""].join("\n")
      );
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-i", path.join(dir, "cover.jpg"), "-i", meta, "-map", "0:a", "-map", "1:v", "-map_metadata", "2", "-map_chapters", "2", "-c:a", "aac", "-b:a", "64k", "-c:v", "copy", "-disposition:v", "attached_pic", "-movflags", "+faststart", "-brand", "M4B ", "-f", "ipod", target]);
    }

    it("keeps its chapters, its cover and its brand, and writes the author, narrator and series", async () => {
      const file = fresh("book.m4b", book);
      const before = { sum: audioChecksum(file), chapters: probe(file).chapters.map((c: any) => c.tags?.title) };
      expect(probe(file).format.tags.major_brand).toBe("M4B ");

      const result = await writeAudioTags(file, {
        title: "Chapter file",
        artist: "Some Author",
        albumArtist: "Some Author",
        album: "The Book",
        trackNumber: 1,
        trackTotal: 1,
        composer: "A Narrator",
        series: "The Series",
        seriesPart: "2",
        year: "2019",
      });

      expect(result.outcome).toBe("written");
      const tags = tagsOf(file);
      expect(tags.artist).toBe("Some Author");
      expect(tags.composer).toBe("A Narrator");
      expect(tags.grouping).toBe("The Series #2");
      expect(tags.album).toBe("The Book");
      expect(probe(file).chapters.map((c: any) => c.tags?.title)).toEqual(before.chapters);
      expect(streamsOf(file, "video").filter((s) => s.disposition.attached_pic === 1)).toHaveLength(1);
      expect(audioChecksum(file)).toBe(before.sum);
      expect(probe(file).format.tags.major_brand).toBe("M4B ");
      expect(leftovers(path.dirname(file))).toEqual([]);
    });

    it("leaves a file alone that carries a tag the MP4 muxer would lose, unless the tags are being scrubbed", async () => {
      const file = fresh("asin.m4b", (target) =>
        ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", "-b:a", "64k", "-metadata", "ASIN=B000TESTING", "-movflags", "+use_metadata_tags", "-f", "ipod", target])
      );
      expect(tagsOf(file).asin).toBe("B000TESTING");
      const bytes = fs.readFileSync(file);

      const result = await writeAudioTags(file, { ...INFO, title: "Book" });

      expect(result.outcome).toBe("skipped");
      expect(result.reason).toMatch(/asin/);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);

      // Scrubbing says the other tags may go.
      expect(await writeAudioTags(file, { ...INFO, title: "Book" }, { scrub: true })).toMatchObject({ outcome: "written" });
      expect(tagsOf(file).asin).toBeUndefined();
      expect(tagsOf(file).title).toBe("Book");
    });
  });

  it("does not replace a file that changed while it was being tagged", async () => {
    const file = fresh("race.flac", sine(["-c:a", "flac"]));
    // A runner that lets ffmpeg finish and then touches the original, as another program writing to it would.
    const { defaultToolRunner } = await import("../src/services/audioTagFfmpeg.js");
    const runner: typeof defaultToolRunner = async (tool, args, opts) => {
      const result = await defaultToolRunner(tool, args, opts);
      if (tool === "ffmpeg") fs.appendFileSync(file, Buffer.from([0]));
      return result;
    };

    const result = await writeAudioTags(file, INFO, { runner });

    expect(result).toMatchObject({ outcome: "skipped", reason: "the file changed while it was being tagged" });
    expect(tagsOf(file).title).toBeUndefined();
    expect(leftovers(path.dirname(file))).toEqual([]);
  });
});
