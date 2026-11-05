import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { FILE_NAME, parseReleaseTitle } from "../src/services/releaseParser.js";
import { DEFAULT_QUALITY_ORDER, LEGACY_QUALITY_ORDER } from "../src/db/qualityLadder.js";

/**
 * ST14: the parser grades the tiers Starr has beyond the original sixteen. The fixture holds what the parser graded
 * (as a release and as a file) a broad set of names before the change; the first test holds the new parser to it,
 * except where the audit said the old grade was wrong.
 */
const before = JSON.parse(fs.readFileSync(new URL("./fixtures/releaseGradesBefore.json", import.meta.url), "utf8")) as [string, string, string][];

/** The only moves the extended ladder makes: a grade that was refused, or collapsed into one tier, gets its own. */
const ALLOWED_MOVES: Record<string, string[]> = {
  // A pre-release copy, a disc image or a raw capture was "Unknown".
  Unknown: ["CAM", "TELESYNC", "TELECINE", "WORKPRINT", "DVDSCR", "REGIONAL", "BR-DISK", "DVD-R", "Raw-HD"],
  // 480p WEB-DL, 480p/576p Blu-ray and SDTV were all "SD".
  SD: ["SDTV", "WEBRip-480p", "WEBDL-480p", "Bluray-480p", "Bluray-576p"],
  // An R5 DVD rip is a regional release.
  DVD: ["REGIONAL"],
  // A raw HD capture, or a regional copy, with a resolution in its name was graded as the WEB-DL of that resolution.
  "WEBDL-1080p": ["Raw-HD", "REGIONAL"],
};

describe("the release parser against its grades before the ladder was extended", () => {
  it("keeps every grade, as a release and as a file, except the ones the audit named", () => {
    expect(before.length).toBeGreaterThan(1000);
    const unexpected: string[] = [];
    let unchanged = 0;
    for (const [name, oldRelease, oldFile] of before) {
      for (const [mode, old, now] of [
        ["release", oldRelease, parseReleaseTitle(name).quality],
        ["file", oldFile, parseReleaseTitle(name, FILE_NAME).quality],
      ] as const) {
        if (now === old) {
          unchanged++;
          continue;
        }
        if (!ALLOWED_MOVES[old]?.includes(now)) unexpected.push(`${mode} "${name}": ${old} -> ${now}`);
      }
    }
    expect(unexpected).toEqual([]);
    // Nearly everything stays put: this is a refinement of the grades, not a regrade.
    expect(unchanged).toBeGreaterThan(before.length * 2 * 0.85);
  });

  it("does not move a grade of any tier the original ladder had, other than the ones named above", () => {
    const keepers = new Set<string>(LEGACY_QUALITY_ORDER.filter((q) => q !== "SD" && q !== "DVD"));
    for (const [name, oldRelease] of before) {
      if (!keepers.has(oldRelease) || oldRelease === "WEBDL-1080p") continue;
      expect(parseReleaseTitle(name).quality, name).toBe(oldRelease);
    }
  });
});

// [release name, grade as a release, grade as a file (when it differs)]
const NEW_GRADES: [string, string, string?][] = [
  // standard definition, by source
  ["Show.Name.S01E01.HDTV.x264-LOL", "SDTV"],
  ["Show.Name.S01E01.SDTV.x264-GRP", "SDTV"],
  ["Show.Name.S01E01.PDTV.XviD-GRP", "SDTV"],
  ["Show.Name.S01E01.DSR.XviD-GRP", "SDTV"],
  ["Show.Name.S01E01.TVRip.XviD-GRP", "SDTV"],
  ["Show.Name.S01E01.DVBRip.XviD-GRP", "SDTV"],
  ["Show.Name.S01E01.480p.HDTV.x264-GRP", "SDTV"],
  ["Show.Name.S01E01.480p.WEB-DL.AAC2.0.H.264-GRP", "WEBDL-480p"],
  ["Show.Name.S01E01.WEB-DL.x264-GRP", "WEBDL-480p"],
  ["Movie.Name.2010.480p.WEB-DL.x264-GRP", "WEBDL-480p"],
  ["Show.Name.S01E01.480p.WEBRip.x264-GRP", "WEBRip-480p"],
  ["Show.Name.S01E01.WEBRip.x264-GRP", "WEBRip-480p"],
  ["Movie.Name.2010.480p.BluRay.x264-GRP", "Bluray-480p"],
  ["Movie.Name.2010.576p.BluRay.x264-GRP", "Bluray-576p"],
  ["Show.Name.S01E01.576p.BluRay.x264-GRP", "Bluray-576p"],
  // SD stays the grade when the source cannot be told
  ["Show.Name.S01E01.480p.x264-GRP", "SD"],
  ["[SubsPlease] Show Name - 01 (480p) [ABC12345].mkv", "SD"],
  ["Movie.Name.2010.BDRip.XviD-GRP", "SD"],
  ["Movie.Name.2010.BRRip.x264-GRP", "SD"],
  ["Show.Name.S01E01.WEB.h264-GRP", "SD"],
  // a DVD is a DVD whatever the picture size
  ["Movie.Name.2010.576i.DVDRip.x264-GRP", "DVD"],
  ["Movie.Name.2010.DVDRip.XviD-GRP", "DVD"],
  // disc images
  ["Movie.Name.2010.DVD9.NTSC-GRP", "DVD-R", "Unknown"],
  ["Some Title NTSC DVDR", "DVD-R", "Unknown"],
  ["Movie.Name.2010.COMPLETE.BLURAY-GRP", "BR-DISK", "Unknown"],
  ["Movie.Name.2010.BD50-GRP", "BR-DISK", "Unknown"],
  ["Movie.Name.2010.1080p.BluRay.AVC.DTS-HD.MA.5.1-GRP", "BR-DISK", "Bluray-1080p"],
  ["Movie.Name.2010.UNTOUCHED.1080p.BluRay-GRP", "BR-DISK", "Bluray-1080p"],
  // raw captures
  ["Movie.Name.2010.1080p.RAW-HD.TrueHD-GRP", "Raw-HD"],
  ["Movie.Name.2010.RawHD.1080p-GRP", "Raw-HD"],
  ["Movie.Name.2010.Raw.HD.1080p.MPEG2-GRP", "Raw-HD"],
  ["Show.Name.S01E01.1080p.RAW-HD.MPEG2-GRP", "Raw-HD"],
  // pre-release copies
  ["Movie.Name.2020.CAM.x264-GRP", "CAM"],
  ["Movie.Name.2020.HDCAM.x264-GRP", "CAM"],
  ["Movie.Name.2020.1080p.HDCAM-GRP", "CAM"],
  ["Movie.Name.2020.HQCAM.x264-GRP", "CAM"],
  ["Movie.Name.2020.TS.x264-GRP", "TELESYNC"],
  ["Movie.Name.2020.TELESYNC.x264-GRP", "TELESYNC"],
  ["Movie.Name.2020.HDTS.x264-GRP", "TELESYNC"],
  ["Movie.Name.2020.1080p.HDTS-GRP", "TELESYNC"],
  ["Movie.Name.2020.PDVD.XviD-GRP", "TELESYNC"],
  ["Movie.Name.2020.TC.x264-GRP", "TELECINE"],
  ["Movie.Name.2020.TELECINE.x264-GRP", "TELECINE"],
  ["Movie.Name.2020.HDTC.x264-GRP", "TELECINE"],
  ["Movie.Name.2020.WORKPRINT.x264-GRP", "WORKPRINT"],
  ["Movie.Name.2020.DVDSCR.XviD-GRP", "DVDSCR"],
  ["Movie.Name.2020.SCREENER.XviD-GRP", "DVDSCR"],
  ["Movie.Name.2020.1080p.BDSCR.x264-GRP", "DVDSCR"],
  ["Movie.Name.2009.R5.DVDRip.XviD-GRP", "REGIONAL"],
  ["Movie.Name.2009.R5.LiNE.XviD-GRP", "REGIONAL"],
  ["Movie.Name.2009.REGIONAL.DVDRip.XviD-GRP", "REGIONAL"],
  // and the audit's own probes
  ["Movie.Name.2010.1080p.RAW-HD.TrueHD-GRP.mkv", "Raw-HD"],
  ["Movie.Name.2024.CAM.x264-GRP.mkv", "CAM"],
  ["Movie.Name.2024.HDTS.x264-GRP.mkv", "TELESYNC"],
];

describe("the grades of the tiers added to the ladder (ST14)", () => {
  it.each(NEW_GRADES)("%s", (name, asRelease, asFile) => {
    expect(parseReleaseTitle(name).quality).toBe(asRelease);
    expect(parseReleaseTitle(name, FILE_NAME).quality).toBe(asFile ?? asRelease);
  });

  it("grades only names on the extended ladder", () => {
    const ladder = new Set<string>([...DEFAULT_QUALITY_ORDER, "Unknown"]);
    for (const [name] of NEW_GRADES) expect(ladder.has(parseReleaseTitle(name).quality), name).toBe(true);
    for (const [name] of before) expect(ladder.has(parseReleaseTitle(name).quality), name).toBe(true);
  });

  it("does not let a raw capture pass for a WEB release: it no longer reads as the WEBDL tier of its resolution", () => {
    const raw = parseReleaseTitle("Movie.Name.2010.1080p.RAW-HD.TrueHD-GRP");
    expect(raw.quality).not.toMatch(/^WEB/);
    expect(raw.qualityModifier).toBe("rawhd");
  });

  it("keeps a disc image out of the encode tiers (and a file of that name an encode)", () => {
    const name = "Movie.Name.2010.1080p.BluRay.AVC.DTS-HD.MA.5.1-GRP";
    expect(parseReleaseTitle(name)).toMatchObject({ rawDisc: true, quality: "BR-DISK" });
    expect(parseReleaseTitle(name, FILE_NAME)).toMatchObject({ rawDisc: false, quality: "Bluray-1080p" });
  });
});
