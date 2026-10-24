import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let releaseRejection: typeof import("../src/services/releaseRejections.js")["releaseRejection"];
let parseReleaseTitle: typeof import("../src/services/releaseParser.js")["parseReleaseTitle"];
let setSetting: typeof import("../src/services/settingsStore.js")["setSetting"];

const reject = (title: string, mediaType = "movie", size: number | null = 5_000_000_000) =>
  releaseRejection(parseReleaseTitle(title), { title, size }, mediaType)?.code ?? null;

describe("releaseRejection", () => {
  beforeAll(async () => {
    await setupTestDb();
    ({ releaseRejection } = await import("../src/services/releaseRejections.js"));
    ({ parseReleaseTitle } = await import("../src/services/releaseParser.js"));
    ({ setSetting } = await import("../src/services/settingsStore.js"));
  });

  it("accepts an ordinary encode, episode and season pack", () => {
    expect(reject("Movie.Name.2020.1080p.BluRay.x264-GRP")).toBeNull();
    expect(reject("Show.Name.S01E03.1080p.WEB-DL.DDP5.1.H.264-GRP", "series")).toBeNull();
    expect(reject("Show.Name.S01.COMPLETE.1080p.BluRay.AAC.5.1-GRP", "series")).toBeNull();
    expect(reject("[SubsPlease] Show Name - 05 (1080p) [ABCD1234]", "anime", 700_000_000)).toBeNull();
  });

  it("names a split season and a season's extras whatever the settings say", () => {
    setSetting("rejectMultiSeasonPacks", "0");
    try {
      expect(reject("Show.Name.S02.Part.1.1080p.WEB-GRP", "series")).toBe("partial-season");
      expect(reject("Show.Name.S02.EXTRAS.1080p.WEB-GRP", "series")).toBe("season-extras");
    } finally {
      setSetting("rejectMultiSeasonPacks", "");
    }
  });

  it("names a pack of several seasons, until the setting turns the rule off", () => {
    expect(reject("Show.Name.S01-S05.1080p.WEB-GRP", "series")).toBe("multi-season");
    expect(reject("Series Title S01 S04 (1080p BluRay x265)", "series")).toBe("multi-season");
    setSetting("rejectMultiSeasonPacks", "0");
    try {
      expect(reject("Show.Name.S01-S05.1080p.WEB-GRP", "series")).toBeNull();
    } finally {
      setSetting("rejectMultiSeasonPacks", "");
    }
  });

  it("names a raw disc image, until the setting turns the rule off", () => {
    expect(reject("Movie Title 2014 1080p Blu-ray AVC DTS-HD MA 5.1-PTP")).toBe("raw-disc");
    expect(reject("Movie.Title.2008.DVD9.NTSC-GRP")).toBe("raw-disc");
    setSetting("rejectRawDiscs", "0");
    try {
      expect(reject("Movie Title 2014 1080p Blu-ray AVC DTS-HD MA 5.1-PTP")).toBeNull();
    } finally {
      setSetting("rejectRawDiscs", "");
    }
  });

  it("names a sample only when its size is known and small", () => {
    const title = "Movie.Name.2020.1080p.BluRay.x264.Sample-GRP";
    expect(reject(title, "movie", 69_000_000)).toBe("sample");
    expect(reject(title, "movie", 71_000_000)).toBeNull();
    expect(reject(title, "movie", null)).toBeNull();
    expect(reject(title, "movie", 0)).toBeNull();
    setSetting("rejectSamples", "0");
    try {
      expect(reject(title, "movie", 69_000_000)).toBeNull();
    } finally {
      setSetting("rejectSamples", "");
    }
  });

  it("names burned-in subtitles for a film-shaped type only", () => {
    expect(reject("Movie.Name.2021.1080p.WEB-DL.HC.x264-GRP")).toBe("hardcoded-subs");
    expect(reject("Movie.Name.2021.1080p.WEB-DL.HC.x264-GRP", "ppv")).toBe("hardcoded-subs");
    expect(reject("Show.Name.S01E01.1080p.WEB-DL.HC.x264-GRP", "series")).toBeNull();
    expect(reject("Show.Name.S01E01.1080p.WEB-DL.HC.x264-GRP", "anime")).toBeNull();
    setSetting("rejectHardcodedSubs", "0");
    try {
      expect(reject("Movie.Name.2021.1080p.WEB-DL.HC.x264-GRP")).toBeNull();
    } finally {
      setSetting("rejectHardcodedSubs", "");
    }
  });

  it("judges nothing for a type with no video tiers", () => {
    expect(reject("Artist - Album 2020 BD-50 [FLAC]", "artist")).toBeNull();
    expect(reject("Game Name (USA) DVD9", "rom")).toBeNull();
    expect(reject("Author - Book Sample [EPUB]", "author", 10_000)).toBeNull();
  });
});
