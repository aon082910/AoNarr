import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAudioTags } from "../src/services/audioTagWriter.js";
import {
  FFMPEG_TAG_CONCURRENCY,
  buildFfmpegArgs,
  ffmpegTagPairs,
  missingTagPairs,
  mp4TagPairs,
  mp4TagsThatWouldBeLost,
  parseProbe,
  tagValueMatches,
  timeoutForSize,
  verifyTaggedOutput,
  vorbisTagPairs,
  type FfmpegPlan,
} from "../src/services/audioTagFfmpeg.js";
import type { AudioTagInfo, ToolRunResult, ToolRunner } from "../src/services/audioTagCommon.js";

// Everything about the ffmpeg writer that does not need ffmpeg: the arguments it builds, the rules the tagged copy must pass
// before it replaces the file, and what is left on disk on every way it can go wrong. The real binary is audioTagWriterFfmpeg.test.ts.

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-tagfake-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const INFO: AudioTagInfo = { title: "Song", artist: "Artist", albumArtist: "Artist", album: "Album", trackNumber: 2, trackTotal: 10, year: "2020", date: "2020-02-03" };

interface ProbeSpec {
  audio?: number;
  codec?: string;
  duration?: number | null;
  pictures?: number;
  video?: number;
  chapters?: number;
  tags?: Record<string, string>;
  streamTags?: Record<string, string>;
}

function probeJson(spec: ProbeSpec): string {
  const streams: any[] = [];
  for (let i = 0; i < (spec.audio ?? 1); i++) streams.push({ codec_type: "audio", codec_name: spec.codec ?? "flac", tags: i === 0 ? spec.streamTags ?? {} : {} });
  for (let i = 0; i < (spec.pictures ?? 0); i++) streams.push({ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } });
  for (let i = 0; i < (spec.video ?? 0); i++) streams.push({ codec_type: "video", codec_name: "h264", disposition: { attached_pic: 0 } });
  return JSON.stringify({
    streams,
    format: { duration: spec.duration === null ? undefined : String(spec.duration ?? 120), tags: spec.tags ?? {} },
    chapters: Array.from({ length: spec.chapters ?? 0 }, (_, i) => ({ id: i })),
  });
}

const ok = (extra: Partial<ToolRunResult> = {}): ToolRunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...extra });

/** The `-metadata` arguments of an ffmpeg call as tags, the way ffprobe would show them on the written file. */
function tagsFromArgs(args: string[]): { format: Record<string, string>; stream: Record<string, string> } {
  const format: Record<string, string> = {};
  const stream: Record<string, string> = {};
  args.forEach((arg, i) => {
    if (arg !== "-metadata" && arg !== "-metadata:s:a:0") return;
    const [key, ...rest] = args[i + 1].split("=");
    (arg === "-metadata" ? format : stream)[key] = rest.join("=");
  });
  return { format, stream };
}

interface Fake {
  runner: ToolRunner;
  ffmpegCalls: string[][];
  ffprobeCalls: string[][];
}

/**
 * A runner standing in for ffmpeg and ffprobe. The source file probes as `source`; ffmpeg "writes" its output file (with the
 * bytes `written`) and the output probes like the source with the tags that were asked for, changed by `output`.
 */
function fake(options: {
  source: ProbeSpec;
  output?: (derived: ProbeSpec, args: string[]) => ProbeSpec;
  ffmpeg?: (args: string[]) => ToolRunResult | Promise<ToolRunResult>;
  written?: number;
  sourcePath: string;
}): Fake {
  const ffmpegCalls: string[][] = [];
  const ffprobeCalls: string[][] = [];
  let lastArgs: string[] = [];
  const runner: ToolRunner = async (tool, args) => {
    if (tool === "ffprobe") {
      ffprobeCalls.push(args);
      const target = args[args.length - 1];
      if (target === options.sourcePath) return ok({ stdout: probeJson(options.source) });
      const { format, stream } = tagsFromArgs(lastArgs);
      const derived: ProbeSpec = { ...options.source, tags: { ...(options.source.tags ?? {}), ...format }, streamTags: { ...(options.source.streamTags ?? {}), ...stream } };
      return ok({ stdout: probeJson(options.output ? options.output(derived, lastArgs) : derived) });
    }
    ffmpegCalls.push(args);
    lastArgs = args;
    if (options.ffmpeg) {
      const custom = await options.ffmpeg(args);
      if (custom.code !== 0 || custom.timedOut || custom.aborted || custom.spawnError) return custom;
    }
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(options.written ?? 4096, 1));
    return ok();
  };
  return { runner, ffmpegCalls, ffprobeCalls };
}

function audioFile(name: string, size = 4096): { file: string; folder: string } {
  const folder = fs.mkdtempSync(path.join(dir, "case-"));
  const file = path.join(folder, name);
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  return { file, folder };
}

const leftovers = (folder: string) => fs.readdirSync(folder).filter((n) => n !== path.basename(folder) && n.startsWith(".aonarr-tmp-"));

describe("the tags each format gets", () => {
  it("builds Vorbis comment names for FLAC, OGG and Opus, with the totals as their own comments", () => {
    const pairs = vorbisTagPairs({ ...INFO, discNumber: 2, discTotal: 3, genre: "Rock", musicbrainz: { artistId: "A", albumArtistId: "A", releaseGroupId: "R" } });
    expect(pairs).toEqual([
      ["title", "Song"],
      ["artist", "Artist"],
      ["album", "Album"],
      ["album_artist", "Artist"],
      ["track", "2"],
      ["TRACKTOTAL", "10"],
      ["disc", "2"],
      ["DISCTOTAL", "3"],
      ["date", "2020-02-03"],
      ["genre", "Rock"],
      ["MUSICBRAINZ_ARTISTID", "A"],
      ["MUSICBRAINZ_ALBUMARTISTID", "A"],
      ["MUSICBRAINZ_RELEASEGROUPID", "R"],
    ]);
  });

  it("builds the MP4 atoms with the totals inside track and disc, and no MusicBrainz ids (the muxer has no freeform atom)", () => {
    const pairs = mp4TagPairs({ ...INFO, discNumber: 1, composer: "Narrator", series: "Series", seriesPart: "3", musicbrainz: { artistId: "A" } });
    expect(pairs).toContainEqual(["track", "2/10"]);
    expect(pairs).toContainEqual(["disc", "1"]);
    expect(pairs).toContainEqual(["composer", "Narrator"]);
    expect(pairs).toContainEqual(["grouping", "Series #3"]);
    expect(pairs.some(([key]) => key.startsWith("MUSICBRAINZ"))).toBe(false);
    expect(ffmpegTagPairs("mp4", INFO)).toEqual(mp4TagPairs(INFO));
    expect(ffmpegTagPairs("opus", INFO)).toEqual(vorbisTagPairs(INFO));
  });

  it("leaves out what is not known and never writes an empty tag", () => {
    const pairs = vorbisTagPairs({ title: "T", artist: " ", album: "A", genre: "", trackNumber: 0, trackTotal: 5, series: "  " });
    expect(pairs).toEqual([
      ["title", "T"],
      ["album", "A"],
    ]);
    // A total below the track number would be a wrong number, not a total.
    expect(vorbisTagPairs({ title: "T", artist: "A", album: "B", trackNumber: 9, trackTotal: 3 }).some(([k]) => k === "TRACKTOTAL")).toBe(false);
  });

  it("compares a value read back the way its format keeps it", () => {
    expect(tagValueMatches("track", "2", "2/10")).toBe(true);
    expect(tagValueMatches("track", "2/10", "2/10")).toBe(true);
    expect(tagValueMatches("track", "2/10", "2")).toBe(false);
    expect(tagValueMatches("MUSICBRAINZ_ARTISTID", "ABC", "abc")).toBe(true);
    expect(tagValueMatches("date", "2020", "2020-02-03")).toBe(true);
    expect(tagValueMatches("title", "Song", "song")).toBe(false);
    expect(tagValueMatches("title", "Song", undefined)).toBe(false);
    expect(missingTagPairs([["title", "Song"], ["album", "Album"]], new Map([["title", "Song"]]))).toEqual([["album", "Album"]]);
  });

  it("lists the tags a remux through the MP4 muxer would lose", () => {
    const tags = new Map([["title", "x"], ["asin", "B0"], ["itunnorm", "1"], ["major_brand", "M4B "], ["encoder", "x"]]);
    expect(mp4TagsThatWouldBeLost(tags)).toEqual(["asin", "itunnorm"]);
  });
});

describe("the ffmpeg command", () => {
  const base: FfmpegPlan = { input: "/lib/a.flac", output: "/lib/.aonarr-tmp-x.flac", muxer: "flac", format: "flac", pairs: [["title", "Song"]], scrub: false, coverFile: null, brand: null };

  it("copies the audio, never decodes it, names the muxer and keeps the tags it does not write", () => {
    const args = buildFfmpegArgs(base);
    expect(args.slice(0, 4)).toEqual(["-nostdin", "-y", "-hide_banner", "-loglevel"]);
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("copy");
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("0");
    expect(args.join(" ")).toContain("-map 0:a -map 0:v?");
    expect(args).toContain("+bitexact");
    expect(args.slice(-3)).toEqual(["-f", "flac", "/lib/.aonarr-tmp-x.flac"]);
    expect(args).toContain("title=Song");
    expect(args).not.toContain("-map_chapters");
  });

  it("scrubbing drops the metadata mapping", () => {
    expect(buildFfmpegArgs({ ...base, scrub: true })[buildFfmpegArgs({ ...base, scrub: true }).indexOf("-map_metadata") + 1]).toBe("-1");
  });

  it("keeps an M4B's chapters and brand, and starts it fast", () => {
    const args = buildFfmpegArgs({ ...base, muxer: "ipod", format: "mp4", brand: "M4B " });
    expect(args[args.indexOf("-map_chapters") + 1]).toBe("0");
    expect(args[args.indexOf("-brand") + 1]).toBe("M4B ");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(args.slice(-3)).toEqual(["-f", "ipod", "/lib/.aonarr-tmp-x.flac"]);
  });

  it("writes an Ogg or Opus file's tags on its stream, where a comment already there would win over the container's", () => {
    const args = buildFfmpegArgs({ ...base, muxer: "ogg", format: "ogg" });
    expect(args).toContain("-metadata:s:a:0");
    expect(args).not.toContain("-metadata");
    expect(buildFfmpegArgs({ ...base, muxer: "opus", format: "opus" })).toContain("-metadata:s:a:0");
  });

  it("takes the cover as a second input and marks it as the attached picture", () => {
    const args = buildFfmpegArgs({ ...base, coverFile: "/lib/.aonarr-tmp-cover-x.jpg" });
    expect(args.join(" ")).toContain("-i /lib/a.flac -i /lib/.aonarr-tmp-cover-x.jpg");
    expect(args.join(" ")).toContain("-map 0:a -map 1:v");
    expect(args.join(" ")).toContain("-disposition:v:0 attached_pic");
    expect(args.join(" ")).not.toContain("0:v?");
  });

  it("gives a long file a long time, and a short one a minute", () => {
    expect(timeoutForSize(1024)).toBe(60_000);
    expect(timeoutForSize(2 * 1024 ** 3)).toBe(1024 * 1000);
  });
});

describe("the rules a tagged copy passes before it replaces the file", () => {
  const source = parseProbe(JSON.parse(probeJson({ codec: "aac", duration: 100, pictures: 1, chapters: 2 })));
  const pairs: [string, string][] = [["title", "Song"]];
  const output = (spec: ProbeSpec) => parseProbe(JSON.parse(probeJson({ codec: "aac", duration: 100, pictures: 1, chapters: 2, tags: { title: "Song" }, ...spec })));
  const verify = (out: ReturnType<typeof output>, extra: { coverEmbedded?: boolean; size?: number } = {}) =>
    verifyTaggedOutput(source, out, { format: "mp4", pairs, coverEmbedded: extra.coverEmbedded ?? false }, extra.size ?? 5000, 5000);

  it("accepts the same audio with the tags in it", () => {
    expect(verify(output({}))).toBeNull();
  });

  it("refuses a copy with fewer audio streams, another codec, a different length or a missing picture or chapter", () => {
    expect(verify(output({ audio: 0 }))).toMatch(/0 audio stream/);
    expect(verify(output({ codec: "mp3" }))).toMatch(/audio is mp3/);
    expect(verify(output({ duration: 98 }))).toMatch(/98\.0 s long/);
    expect(verify(output({ duration: 100.9 }))).toBeNull();
    expect(verify(output({ duration: null }))).toMatch(/cannot be compared/);
    expect(verify(output({ pictures: 0 }))).toMatch(/0 picture/);
    expect(verify(output({ chapters: 1 }))).toMatch(/1 chapter/);
    expect(verify(output({}), { size: 100 })).toMatch(/100 bytes/);
  });

  it("refuses a copy whose tags did not read back", () => {
    expect(verify(output({ tags: {} }))).toMatch(/did not read back \(title\)/);
    expect(verify(output({ tags: { title: "Other" } }))).toMatch(/did not read back/);
  });

  it("expects exactly one picture when a cover went in", () => {
    expect(verify(output({ pictures: 1 }), { coverEmbedded: true })).toBeNull();
    expect(verify(output({ pictures: 2 }), { coverEmbedded: true })).toMatch(/2 picture/);
  });
});

describe("writing a file through a runner", () => {
  it("replaces the file with the checked copy and leaves no temp file", async () => {
    const { file, folder } = audioFile("a.flac");
    const f = fake({ source: { tags: {} }, sourcePath: file, written: 4000 });

    const result = await writeAudioTags(file, INFO, { runner: f.runner });

    expect(result).toEqual({ outcome: "written", format: "FLAC" });
    expect(fs.statSync(file).size).toBe(4000);
    expect(leftovers(folder)).toEqual([]);
    expect(f.ffmpegCalls).toHaveLength(1);
    expect(f.ffmpegCalls[0].slice(-3, -2)).toEqual(["-f"]);
    // The temp copy sits beside the file, hidden, with its extension.
    expect(path.dirname(f.ffmpegCalls[0].at(-1)!)).toBe(folder);
    expect(path.basename(f.ffmpegCalls[0].at(-1)!)).toMatch(/^\.aonarr-tmp-[0-9a-f]+\.flac$/);
  });

  it("keeps the mode and flushes the copy before the rename", async () => {
    const { file } = audioFile("b.flac");
    fs.chmodSync(file, 0o640);
    const events: string[] = [];
    const realOpen = fsp.open.bind(fsp);
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await realOpen(...args);
      const sync = fh.sync.bind(fh);
      fh.sync = async () => {
        events.push("sync");
        return sync();
      };
      return fh;
    });
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      events.push("rename");
      return realRename(from, to);
    });

    const f = fake({ source: {}, sourcePath: file });
    await writeAudioTags(file, INFO, { runner: f.runner });

    expect(events).toEqual(["sync", "rename"]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  describe("on every way it can go wrong the original is untouched and no temp file stays", () => {
    const cases: { name: string; make: (file: string) => Parameters<typeof fake>[0]; outcome: string; reason: RegExp }[] = [
      { name: "ffmpeg stops with an error", make: (file) => ({ source: {}, sourcePath: file, ffmpeg: () => ok({ code: 1, stderr: "Invalid data\nlast line" }) }), outcome: "failed", reason: /code 1: last line/ },
      { name: "ffmpeg runs out of time", make: (file) => ({ source: {}, sourcePath: file, ffmpeg: () => ok({ code: null, timedOut: true }) }), outcome: "failed", reason: /did not finish within 60 s/ },
      { name: "ffmpeg is cancelled", make: (file) => ({ source: {}, sourcePath: file, ffmpeg: () => ok({ code: null, aborted: true }) }), outcome: "skipped", reason: /cancelled/ },
      { name: "ffmpeg is not installed", make: (file) => ({ source: {}, sourcePath: file, ffmpeg: () => ok({ code: null, spawnError: "spawn ffmpeg ENOENT" }) }), outcome: "failed", reason: /ffmpeg is not available/ },
      { name: "ffmpeg writes nothing", make: (file) => ({ source: {}, sourcePath: file, ffmpeg: () => ok({ code: 0 }), written: 0 }), outcome: "failed", reason: /bytes/ },
      { name: "the copy has fewer audio streams", make: (file) => ({ source: {}, sourcePath: file, output: (d) => ({ ...d, audio: 0 }) }), outcome: "failed", reason: /0 audio stream/ },
      { name: "the copy's length drifts", make: (file) => ({ source: {}, sourcePath: file, output: (d) => ({ ...d, duration: 60 }) }), outcome: "failed", reason: /60\.0 s long/ },
      { name: "the copy's tags cannot be read back", make: (file) => ({ source: {}, sourcePath: file, output: (d) => ({ ...d, tags: {}, streamTags: {} }) }), outcome: "failed", reason: /did not read back/ },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const { file, folder } = audioFile("c.flac");
        const bytes = fs.readFileSync(file);
        const f = fake(c.make(file));

        const result = await writeAudioTags(file, INFO, { runner: f.runner });

        expect(result.outcome).toBe(c.outcome);
        expect(result.reason).toMatch(c.reason);
        expect(fs.readFileSync(file).equals(bytes)).toBe(true);
        expect(leftovers(folder)).toEqual([]);
        expect(fs.readdirSync(folder)).toEqual(["c.flac"]);
      });
    }

    it("the rename fails", async () => {
      const { file, folder } = audioFile("d.flac");
      const bytes = fs.readFileSync(file);
      vi.spyOn(fsp, "rename").mockRejectedValue(new Error("EXDEV: cross-device link not permitted"));
      const f = fake({ source: {}, sourcePath: file });

      const result = await writeAudioTags(file, INFO, { runner: f.runner });

      expect(result).toMatchObject({ outcome: "failed", reason: "EXDEV: cross-device link not permitted" });
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(fs.readdirSync(folder)).toEqual(["d.flac"]);
    });

    it("the file changes while ffmpeg runs", async () => {
      const { file, folder } = audioFile("e.flac");
      const f = fake({ source: {}, sourcePath: file, ffmpeg: () => {
        fs.appendFileSync(file, "more");
        return ok();
      } });

      const result = await writeAudioTags(file, INFO, { runner: f.runner });

      expect(result).toMatchObject({ outcome: "skipped", reason: "the file changed while it was being tagged" });
      expect(fs.readFileSync(file).length).toBe(4096 + 4);
      expect(fs.readdirSync(folder)).toEqual(["e.flac"]);
    });

    it("the tool never answers a probe", async () => {
      const { file, folder } = audioFile("f.flac");
      const runner: ToolRunner = async () => ok({ code: 1, stderr: "moov atom not found" });

      const result = await writeAudioTags(file, INFO, { runner });

      expect(result).toMatchObject({ outcome: "failed" });
      expect(result.reason).toMatch(/ffprobe could not read the file: moov atom not found/);
      expect(fs.readdirSync(folder)).toEqual(["f.flac"]);
    });
  });

  describe("files it does not touch", () => {
    it("skips an empty file", async () => {
      const { file } = audioFile("g.flac", 0);
      const f = fake({ source: {}, sourcePath: file });
      expect(await writeAudioTags(file, INFO, { runner: f.runner })).toMatchObject({ outcome: "skipped", reason: "the file is empty" });
      expect(f.ffmpegCalls).toHaveLength(0);
    });

    it("skips a file or folder it may not write", async () => {
      const { file } = audioFile("h.flac");
      vi.spyOn(fsp, "access").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      const f = fake({ source: {}, sourcePath: file });
      expect(await writeAudioTags(file, INFO, { runner: f.runner })).toMatchObject({ outcome: "skipped", reason: "the file or its folder is not writable" });
      expect(f.ffmpegCalls).toHaveLength(0);
    });

    it("skips a file that already has the tags and runs no ffmpeg", async () => {
      const { file } = audioFile("i.flac");
      const f = fake({ source: { tags: { title: "Song", artist: "Artist", album: "Album", album_artist: "Artist", track: "2", tracktotal: "10", date: "2020-02-03" } }, sourcePath: file });
      expect(await writeAudioTags(file, INFO, { runner: f.runner })).toEqual({ outcome: "skipped", reason: "the tags are already up to date", format: "FLAC" });
      expect(f.ffmpegCalls).toHaveLength(0);
    });

    it("skips a file with a video track, a FLAC cue sheet, no audio, and an MP4 with tags the muxer would drop", async () => {
      for (const [name, spec, reason] of [
        ["j.mp4", { video: 1 }, /video track/],
        ["k.flac", { chapters: 3 }, /cue sheet/],
        ["l.m4a", { audio: 0 }, /no audio stream/],
        ["m.m4b", { codec: "aac", tags: { asin: "B0123" } }, /asin/],
      ] as [string, ProbeSpec, RegExp][]) {
        const { file } = audioFile(name);
        const f = fake({ source: spec, sourcePath: file });
        const result = await writeAudioTags(file, INFO, { runner: f.runner });
        expect(result.outcome, name).toBe("skipped");
        expect(result.reason, name).toMatch(reason);
        expect(f.ffmpegCalls, name).toHaveLength(0);
      }
    });

    it("rewrites an MP4 with tags the muxer would drop when the tags are being scrubbed", async () => {
      const { file } = audioFile("n.m4b");
      const f = fake({ source: { codec: "aac", tags: { asin: "B0123" } }, sourcePath: file, output: (d) => ({ ...d, tags: { title: d.tags!.title, artist: d.tags!.artist, album: d.tags!.album, album_artist: d.tags!.album_artist, track: d.tags!.track, date: d.tags!.date } }) });
      expect(await writeAudioTags(file, INFO, { runner: f.runner, scrub: true })).toMatchObject({ outcome: "written" });
      expect(f.ffmpegCalls[0][f.ffmpegCalls[0].indexOf("-map_metadata") + 1]).toBe("-1");
    });

    it("skips a format it cannot write without starting anything", async () => {
      const { file } = audioFile("o.wav");
      const f = fake({ source: {}, sourcePath: file });
      expect(await writeAudioTags(file, INFO, { runner: f.runner })).toMatchObject({ outcome: "skipped", format: "WAV" });
      expect(f.ffprobeCalls).toHaveLength(0);
    });
  });

  describe("cover art", () => {
    const cover = { data: Buffer.from("not really a jpeg"), mime: "image/jpeg" as const };

    it("goes in as a second input for a FLAC file with no picture, and the copy of it is removed", async () => {
      const { file, folder } = audioFile("p.flac");
      const f = fake({ source: { pictures: 0 }, sourcePath: file, output: (d) => ({ ...d, pictures: 1 }) });

      const result = await writeAudioTags(file, INFO, { runner: f.runner, cover });

      expect(result).toEqual({ outcome: "written", format: "FLAC" });
      expect(f.ffmpegCalls[0].join(" ")).toContain("-map 1:v");
      expect(f.ffmpegCalls[0].join(" ")).toMatch(/-i \S+\.aonarr-tmp-cover-[0-9a-f]+\.jpg/);
      expect(fs.readdirSync(folder)).toEqual(["p.flac"]);
    });

    it("is not offered to a file that has a picture already, unless the tags are being scrubbed", async () => {
      const { file } = audioFile("q.flac");
      const tags = { title: "Song", artist: "Artist", album: "Album", album_artist: "Artist", track: "2", tracktotal: "10", date: "2020-02-03" };
      const kept = fake({ source: { pictures: 1, tags }, sourcePath: file });
      expect(await writeAudioTags(file, INFO, { runner: kept.runner, cover })).toMatchObject({ outcome: "skipped", reason: "the tags are already up to date" });

      const replaced = fake({ source: { pictures: 1, tags: { ...tags, extra: "x" } }, sourcePath: file, output: (d) => ({ ...d, pictures: 1, tags: tags }) });
      expect(await writeAudioTags(file, INFO, { runner: replaced.runner, cover, scrub: true })).toMatchObject({ outcome: "written" });
      expect(replaced.ffmpegCalls[0].join(" ")).toContain("-map 1:v");
    });

    it("is not attempted for Ogg and Opus, and the result says why", async () => {
      const { file } = audioFile("r.ogg", 2048);
      const f = fake({ source: { codec: "vorbis" }, sourcePath: file });
      const result = await writeAudioTags(file, INFO, { runner: f.runner, cover });
      expect(result.outcome).toBe("written");
      expect(result.reason).toMatch(/cover is left out/);
      expect(f.ffmpegCalls[0].join(" ")).not.toContain("1:v");
    });

    it("costs the tags nothing when ffmpeg cannot take the picture: they are written again without it", async () => {
      const { file, folder } = audioFile("s.flac");
      let call = 0;
      const f = fake({ source: { pictures: 0 }, sourcePath: file, ffmpeg: () => (++call === 1 ? ok({ code: 1, stderr: "Invalid data found when processing input" }) : ok()) });

      const result = await writeAudioTags(file, INFO, { runner: f.runner, cover });

      expect(result.outcome).toBe("written");
      expect(result.reason).toMatch(/cover/);
      expect(f.ffmpegCalls).toHaveLength(2);
      expect(f.ffmpegCalls[0].join(" ")).toContain("1:v");
      expect(f.ffmpegCalls[1].join(" ")).not.toContain("1:v");
      expect(fs.readdirSync(folder)).toEqual(["s.flac"]);
    });
  });

  it("starts no more than two ffmpeg runs at once, however many files are waiting", async () => {
    let active = 0;
    let peak = 0;
    const files = Array.from({ length: 7 }, (_, i) => audioFile(`t${i}.flac`).file);
    const runner: ToolRunner = async (tool, args) => {
      if (tool === "ffprobe") {
        const target = args[args.length - 1];
        return ok({ stdout: probeJson(files.includes(target) ? {} : { tags: { title: "Song", artist: "Artist", album: "Album", album_artist: "Artist", track: "2", tracktotal: "10", date: "2020-02-03" } }) });
      }
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 25));
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(4096, 1));
      active--;
      return ok();
    };

    const results = await Promise.all(files.map((file) => writeAudioTags(file, INFO, { runner })));

    expect(results.every((r) => r.outcome === "written")).toBe(true);
    expect(FFMPEG_TAG_CONCURRENCY).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it("stops a write that is waiting for a slot when it is cancelled, leaving the file alone", async () => {
    const controller = new AbortController();
    const files = Array.from({ length: 4 }, (_, i) => audioFile(`u${i}.flac`).file);
    const bytes = files.map((f) => fs.readFileSync(f));
    const runner: ToolRunner = async (tool, args) => {
      if (tool === "ffprobe") return ok({ stdout: probeJson({}) });
      await new Promise((r) => setTimeout(r, 40));
      if (controller.signal.aborted) return ok({ code: null, aborted: true });
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(4096, 1));
      return ok();
    };
    setTimeout(() => controller.abort(), 10);

    const results = await Promise.all(files.map((file) => writeAudioTags(file, INFO, { runner, signal: controller.signal })));

    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    files.forEach((file, i) => expect(fs.readFileSync(file).equals(bytes[i])).toBe(true));
    for (const file of files) expect(leftovers(path.dirname(file))).toEqual([]);
  });
});
