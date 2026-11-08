import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { junkNameRejection, preflightRejection, sizeFloorBytes, sizeFloorMbPerMinute, type PreflightContext } from "../src/services/throttlearr/preflight.js";
import { fileNameFromSubject, nzbVerdict, parseNzb, payloadBytes } from "../src/services/throttlearr/nzbInspect.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/services/throttlearr/settings.js";
import { parseReleaseTitle } from "../src/services/releaseParser.js";
import { releaseIdentifiesTarget } from "../src/services/releaseIdentity.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("junk names (Fix 17 names)", () => {
  const junk = [
    "the.current.war.2017.1080p.bluray.x264-amiable.sample",
    "Ozzy 2016 1080p BluRay x264 +Sample",
    "Black.Rock.2012.720p.WEB-DL.H264-PublicHD.nfo",
    "Black.Rock.2012.720p.WEB-DL.H264-PublicHD.nfo (1)",
    "Black.Rock.2012.720p.WEB-DL.H264-PublicHD.nfo.1",
    "Hop (2011) Trailer 1 Teaser 1080p",
    "(incomplete)-Justice.League.vs.the.Fatal.Five.2019.1080p.BluRay.x264-xpost",
    "Resolution.2012.720p.BluRay.x264-x0rEXTRA-Behind.the.Scenes-xpost",
    "Some.Movie.2020.1080p.BluRay.featurette",
    "Some.Movie.2020.1080p.WEB-DL.passworded",
    "Some.Movie.2020.1080p.iso",
    "Setup.2020.1080p.exe",
    "Some.Movie.2020.1080p.BluRay.x264.rar",
  ];
  for (const name of junk) {
    it(`refuses "${name}"`, () => {
      expect(junkNameRejection(name)?.code).toBe("junk-name");
    });
  }

  const fine = [
    "Sample.Size.2019.1080p.BluRay.x264-GRP", // a film called Sample Size
    "The.Trailer.Park.Boys.S01E01.1080p.WEB-DL.x264-GRP",
    "Trailer.Park.Boys.The.Movie.2006.1080p.BluRay.x264-GRP",
    "Teaser.2023.1080p.WEB-DL.x264-GRP",
    "The.Password.2021.1080p.WEB-DL.x264-GRP",
    "Movie.2020.1080p.BluRay.x264-GRP[NO.RAR]",
    "Behind.the.Scenes.of.Life.2019.1080p.WEB-DL.x264-GRP", // the words are the title, before the year
    "Normal.Movie.2021.2160p.UHD.BluRay.x265-GRP",
    "Show.Name.S02E05.720p.HDTV.x264-GRP",
    "Show.Name.S02E05.The.Trailer.1080p.WEB-DL.x264-GRP", // an episode called "The Trailer"
    "Show.Name.S02E05.Sample.Day.720p.HDTV.x264-GRP",
    "Movie.2020.1080p.BluRay.READ.NFO.x264-GRP", // the scene tag, not a text file
  ];
  for (const name of fine) {
    it(`leaves "${name}" alone`, () => {
      expect(junkNameRejection(name)).toBeNull();
    });
  }

  it("still refuses a sample or trailer tagged after the resolution or source of an episode", () => {
    expect(junkNameRejection("Show.Name.S02E05.1080p.WEB-DL.SAMPLE-GRP")?.code).toBe("junk-name");
    expect(junkNameRejection("Show.Name.S02E05.720p.HDTV.Trailer")?.code).toBe("junk-name");
  });

  it("does not read a word as junk when there is no year, episode, resolution or source to say the title has ended", () => {
    expect(junkNameRejection("Sample")).toBeNull();
    expect(junkNameRejection("Trailer Park")).toBeNull();
  });
});

describe("the size floor", () => {
  const ctx = (over: Partial<PreflightContext["settings"]["preflight"]> = {}, runtimeMinutes = 95, episodic = false): PreflightContext => ({
    settings: normalizeSettings({ enabled: true, preflight: over }),
    runtime: { runtimeMinutes, episodic },
  });
  const check = (title: string, size: number | null, c = ctx()) => preflightRejection(c, { title }, parseReleaseTitle(title), size);

  it("sets a floor per minute by resolution", () => {
    expect(sizeFloorMbPerMinute("2160p")).toBe(8);
    expect(sizeFloorMbPerMinute("1080p")).toBe(3);
    expect(sizeFloorMbPerMinute("720p")).toBe(2);
    expect(sizeFloorMbPerMinute(null)).toBe(1);
    expect(sizeFloorBytes("1080p", 100)).toBe(300_000_000);
  });

  it("refuses the 146 MB 1080p film from the matching notes", () => {
    const r = check("500.Days.of.Summer.2009.PROPER.1080p.BluRay.x264-SADPANDA", 146_000_000);
    expect(r?.code).toBe("size-floor");
    expect(r?.reason).toMatch(/146 MB for 1080p, under the 285 MB floor/);
  });

  it("passes honest sizes, a size it does not know, and a quality with room to spare", () => {
    expect(check("Film.2020.1080p.BluRay.x264-GRP", 4_000_000_000)).toBeNull();
    expect(check("Film.2020.1080p.WEB-DL.x265-GRP", 800_000_000)).toBeNull(); // a small HEVC encode is 8 MB/min here
    expect(check("Film.2020.720p.WEB-DL.x264-GRP", 1_200_000_000)).toBeNull();
    expect(check("Film.2020.1080p.BluRay.x264-GRP", null)).toBeNull();
    expect(check("Film.2020.1080p.BluRay.x264-GRP", 0)).toBeNull();
  });

  it("scales with the runtime: an episode, and a season pack of several", () => {
    const tv = ctx({}, 45, true);
    expect(check("Show.S01E01.1080p.WEB-DL.x264-GRP", 100_000_000, tv)?.code).toBe("size-floor"); // 45 x 3 = 135 MB
    expect(check("Show.S01E01.1080p.WEB-DL.x264-GRP", 400_000_000, tv)).toBeNull();
    // A pack of ten episodes needs ten times the floor.
    expect(check("Show.S01.1080p.WEB-DL.x264-GRP", 800_000_000, tv)?.code).toBe("size-floor");
    expect(check("Show.S01.1080p.WEB-DL.x264-GRP", 5_000_000_000, tv)).toBeNull();
  });

  it("does not judge an episode whose runtime is not on file: it may be an 11-minute cartoon", () => {
    const unknown: PreflightContext = { settings: ctx().settings, runtime: { runtimeMinutes: null, episodic: true } };
    expect(check("Cartoon.S01E01.1080p.WEB-DL.x264-GRP", 60_000_000, unknown)).toBeNull();
    const short: PreflightContext = { settings: ctx().settings, runtime: { runtimeMinutes: 11, episodic: true } };
    expect(check("Cartoon.S01E01.1080p.WEB-DL.x264-GRP", 60_000_000, short)).toBeNull(); // 11 x 3 = 33 MB
    expect(check("Cartoon.S01E01.1080p.WEB-DL.x264-GRP", 20_000_000, short)?.code).toBe("size-floor");
    // A film with no runtime still gets the 110-minute default.
    const film: PreflightContext = { settings: ctx().settings, runtime: { runtimeMinutes: null, episodic: false } };
    expect(check("500.Days.of.Summer.2009.1080p.BluRay.x264-GRP", 146_000_000, film)?.code).toBe("size-floor");
  });

  it("each rule has its own switch", () => {
    expect(check("500.Days.of.Summer.2009.1080p.BluRay.x264-GRP", 146_000_000, ctx({ sizeFloor: false }))).toBeNull();
    expect(check("Film.2020.1080p.BluRay.x264-GRP.nfo", 4_000_000_000, ctx({ junkNames: false }))).toBeNull();
    expect(check("Film.2020.1080p.BluRay.x264-GRP.nfo", 4_000_000_000)?.code).toBe("junk-name");
  });

  it("does not judge size without a runtime context", () => {
    const noRuntime: PreflightContext = { settings: ctx().settings, runtime: null };
    expect(check("Film.2020.1080p.BluRay.x264-GRP", 1_000, noRuntime)).toBeNull();
  });
});

function nzb(files: { name: string; bytes: number; segments?: number }[], meta = ""): string {
  const body = files
    .map(
      (f) =>
        `<file poster="p@x" date="1" subject="[1/${files.length}] - &quot;${f.name}&quot; yEnc (1/${f.segments ?? 2})"><groups><group>alt.binaries.x</group></groups><segments>` +
        Array.from({ length: f.segments ?? 2 }, (_, i) => `<segment bytes="${Math.round(f.bytes / (f.segments ?? 2))}" number="${i + 1}">id${i}@x</segment>`).join("") +
        `</segments></file>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head>${meta}</head>${body}</nzb>`;
}
const GB = 1_000_000_000;

describe("NZB inspection", () => {
  it("reads file names and sizes from the posts, with the entities decoded", () => {
    const info = parseNzb(nzb([{ name: "Film &amp; Co.mkv", bytes: 4 * GB, segments: 4 }]));
    expect(info.files).toEqual([{ name: "Film & Co.mkv", bytes: 4 * GB }]);
    expect(info.password).toBeNull();
  });

  it("finds a file name in subjects that do not quote it", () => {
    expect(fileNameFromSubject('[01/10] - "Film.part01.rar" yEnc (1/50)')).toBe("Film.part01.rar");
    expect(fileNameFromSubject("[01/10] - Film.part01.rar yEnc (1/50)")).toBe("Film.part01.rar");
    expect(fileNameFromSubject("Film.mkv")).toBe("Film.mkv");
  });

  it("passes a normal release: video, repair data and a text file", () => {
    const info = parseNzb(nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }, { name: "Film.2020.1080p.par2", bytes: 4_000_000 }, { name: "Film.nfo", bytes: 3000 }]));
    expect(nzbVerdict(info, { minPayloadBytes: 300_000_000 })).toBeNull();
    expect(payloadBytes(info)).toBe(4 * GB);
  });

  it("passes a release split in rar volumes, and one with no repair data", () => {
    const rars = Array.from({ length: 5 }, (_, i) => ({ name: `Film.part0${i + 1}.rar`, bytes: GB }));
    expect(nzbVerdict(parseNzb(nzb(rars)), { minPayloadBytes: 300_000_000 })).toBeNull();
    const old = [{ name: "Film.rar", bytes: GB }, { name: "Film.r00", bytes: GB }, { name: "Film.r01", bytes: GB }];
    expect(nzbVerdict(parseNzb(nzb(old)))).toBeNull();
  });

  it("reads a password from the NZB but does not refuse it: SABnzbd and NZBGet unpack with it", () => {
    const info = parseNzb(nzb([{ name: "Film.mkv", bytes: 4 * GB }], '<meta type="password">secret</meta>'));
    expect(info.password).toBe("secret");
    expect(nzbVerdict(info)).toBeNull();
  });

  it("does not refuse a post whose file names are obfuscated, and still judges its size", () => {
    const obfuscated = [
      { name: "9f3c1a2b7d4e", bytes: 3 * GB },
      { name: "a81c5e0f2b93", bytes: GB },
      { name: "abc.vol01+02.par2", bytes: 20_000_000 },
    ];
    const info = parseNzb(nzb(obfuscated));
    expect(nzbVerdict(info, { minPayloadBytes: 300_000_000 })).toBeNull();
    expect(payloadBytes(info)).toBe(4 * GB);
    expect(nzbVerdict(parseNzb(nzb([{ name: "9f3c1a2b7d4e", bytes: 40_000_000 }])), { minPayloadBytes: 300_000_000 })).toMatchObject({ code: "too-small" });
  });

  it("calls a file a sample only when it is small: a film with the word in its title is whole", () => {
    const whole = parseNzb(nzb([{ name: "Sample.Size.2019.1080p.mkv", bytes: 4 * GB }]));
    expect(nzbVerdict(whole, { minPayloadBytes: 300_000_000 })).toBeNull();
    expect(payloadBytes(whole)).toBe(4 * GB);
    const clip = parseNzb(nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }, { name: "film-sample.mkv", bytes: 40_000_000 }]));
    expect(payloadBytes(clip)).toBe(4 * GB);
  });

  it("reads a hostile file in one pass: thousands of unclosed tags cost no more than a normal NZB", () => {
    const hostile = "<file subject=\"x\" ".repeat(50_000) + "<segment bytes=\"1\" ".repeat(50_000) + " ".repeat(200_000) + '<meta type="password">';
    const started = Date.now();
    const info = parseNzb(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(info.files).toEqual([]);
  });

  it("reads the same files as before from a large well-formed NZB", () => {
    const files = Array.from({ length: 2000 }, (_, i) => ({ name: `Film.part${String(i).padStart(4, "0")}.rar`, bytes: 50_000_000, segments: 20 }));
    const info = parseNzb(nzb(files));
    expect(info.files).toHaveLength(2000);
    expect(info.files[1999].bytes).toBe(50_000_000);
  });

  it("refuses a program in the post", () => {
    const info = parseNzb(nzb([{ name: "Film.mkv", bytes: 4 * GB }, { name: "Watch Film.exe", bytes: 200_000 }]));
    expect(nzbVerdict(info)).toMatchObject({ code: "executable", reason: expect.stringContaining("Watch Film.exe") });
  });

  it("refuses a post with no video or archive in it", () => {
    expect(nzbVerdict(parseNzb(nzb([{ name: "Film.nfo", bytes: 4000 }, { name: "Film.par2", bytes: 1_000_000 }])))).toMatchObject({ code: "no-payload" });
    expect(nzbVerdict(parseNzb(nzb([{ name: "Film-sample.mkv", bytes: 40_000_000 }])))).toMatchObject({ code: "no-payload" });
    expect(nzbVerdict(parseNzb(nzb([{ name: "cover.jpg", bytes: 40_000 }])))).toMatchObject({ code: "no-payload" });
  });

  it("refuses less video than the release needs, by what the post really holds and not what the indexer said", () => {
    const small = parseNzb(nzb([{ name: "Film.2020.1080p.mkv", bytes: 120_000_000 }]));
    expect(nzbVerdict(small, { minPayloadBytes: 285_000_000 })).toMatchObject({ code: "too-small", reason: expect.stringContaining("under the 285 MB") });
    expect(nzbVerdict(small, { minPayloadBytes: 100_000_000 })).toBeNull();
    expect(nzbVerdict(small)).toBeNull(); // no floor given: not judged
  });

  it("does not count a sample next to the film as the film", () => {
    const info = parseNzb(nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }, { name: "Sample/film-sample.mkv", bytes: 50_000_000 }]));
    expect(payloadBytes(info)).toBe(4 * GB);
  });
});

describe("strict identity: the 66 releases Radarr grabbed for another film", () => {
  const rows = fs
    .readFileSync(path.join(here, "fixtures", "throttlearr-must-reject.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { release: string; target_title: string; target_year: number | null });

  it("has the whole set", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
  });

  // Two rows of the set came from a title comparison that was too strict, not from a wrong grab: both releases are the
  // film they were grabbed for (an "AKA" title, a dropped subtitle). Matching them is right; every other row is a wrong film.
  const ACTUALLY_THE_SAME_FILM = new Set([
    "A.Widows.Game.AKA.La.Viuda.Negra.2025.1080p.NF.WEB-DL.Multi-Audio.DDP5.1-Atmos.H.264-TBMovies",
    "Abrahams.Boys.2025.1080p.Bluray.H264.DD5.1-TiGER",
  ]);

  it("refuses every wrong-film one of them by name alone, which is what the switch asks for when an indexer's id says otherwise", () => {
    const accepted = rows.filter((r) => {
      if (ACTUALLY_THE_SAME_FILM.has(r.release)) return false;
      const verdict = releaseIdentifiesTarget(
        { title: r.release },
        parseReleaseTitle(r.release),
        { type: "movie", title: r.target_title, year: r.target_year, externalIds: {}, aliases: [] }
      );
      return verdict.ok;
    });
    expect(accepted.map((r) => `${r.release} -> ${r.target_title} (${r.target_year})`)).toEqual([]);
  });
});

describe("settings", () => {
  it("runs the checks by default but trusts indexer ids until asked not to", () => {
    expect(DEFAULT_SETTINGS.preflight).toEqual({ enabled: true, junkNames: true, sizeFloor: true, inspectNzb: true, strictIdentity: false });
    expect(normalizeSettings({ preflight: { strictIdentity: true, sizeFloor: "no" } }).preflight).toMatchObject({ strictIdentity: true, sizeFloor: true });
    expect(normalizeSettings({ preflight: "garbage" }).preflight).toEqual(DEFAULT_SETTINGS.preflight);
  });
});
