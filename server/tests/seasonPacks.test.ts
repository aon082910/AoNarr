import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { PackEpisode } from "../src/services/seasonPacks.js";

let packs: typeof import("../src/services/seasonPacks.js");

beforeAll(async () => {
  await setupTestDb();
  packs = await import("../src/services/seasonPacks.js");
});

const TODAY = "2026-10-25";
const show = { type: "series", seriesType: "standard" } as const;
const settings = { guards: true, sharePercent: 50 };

function episode(n: number, over: Partial<PackEpisode> = {}): PackEpisode {
  return { seasonNumber: 1, episodeNumber: n, sceneSeason: null, sceneEpisode: null, monitored: true, hasFile: false, quality: null, airDate: "2020-01-0" + Math.min(9, n), ...over };
}
const season = (count: number, over: (n: number) => Partial<PackEpisode> = () => ({})) => Array.from({ length: count }, (_, i) => episode(i + 1, over(i + 1)));

function judge(episodes: PackEpisode[], opts: { quality?: string; cutoff?: string; range?: [number, number] | null; settings?: typeof settings; seasonNo?: number } = {}) {
  return packs.judgeSeasonPack({
    parsed: { episodeRange: opts.range ?? null },
    season: opts.seasonNo ?? 1,
    episodes,
    item: show,
    packQuality: opts.quality ?? "WEBDL-1080p",
    cutoff: opts.cutoff ?? "",
    settings: opts.settings ?? settings,
    today: TODAY,
  });
}

describe("judgeSeasonPack", () => {
  it("takes a pack of a finished, monitored season that is missing in full", () => {
    expect(judge(season(10))).toEqual({ ok: true, covered: 10, wanted: 10 });
  });

  it("refuses a pack to fill one episode of ten when the rest are on disk at the same quality", () => {
    const episodes = season(10, (n) => (n === 5 ? {} : { hasFile: true, quality: "Bluray-1080p" }));
    const verdict = judge(episodes, { cutoff: "Bluray-1080p" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/fill or upgrade only 1 of the 10/);
  });

  it("takes it when enough of the season would be filled or upgraded", () => {
    const episodes = season(10, (n) => (n <= 6 ? {} : { hasFile: true, quality: "Bluray-1080p" }));
    expect(judge(episodes, { cutoff: "Bluray-1080p" })).toMatchObject({ ok: true, covered: 10, wanted: 6 });
  });

  it("counts a file below the cutoff and below the pack as an upgrade, and any file below the pack when there is no cutoff", () => {
    const episodes = season(4, () => ({ hasFile: true, quality: "HDTV-720p" }));
    expect(judge(episodes, { cutoff: "WEBDL-1080p", quality: "WEBDL-1080p" })).toMatchObject({ ok: true, wanted: 4 });
    expect(judge(episodes, { cutoff: "", quality: "WEBDL-1080p" })).toMatchObject({ ok: true, wanted: 4 });
    // At or above the cutoff already, or not below the pack: not an upgrade.
    expect(judge(season(4, () => ({ hasFile: true, quality: "WEBDL-1080p" })), { cutoff: "WEBDL-1080p" }).ok).toBe(false);
    expect(judge(season(4, () => ({ hasFile: true, quality: "Bluray-1080p" })), { cutoff: "Remux-2160p", quality: "WEBDL-1080p" }).ok).toBe(false);
  });

  it("refuses a pack of a season that has not finished airing", () => {
    const episodes = season(10, (n) => (n > 8 ? { airDate: "2026-12-01" } : {}));
    const verdict = judge(episodes);
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok === false && verdict.reason).toMatch(/2 of the 10 episodes it covers have not aired/);
  });

  it("refuses a pack that covers an episode the admin unmonitored", () => {
    const verdict = judge(season(10, (n) => (n === 3 ? { monitored: false } : {})));
    expect(verdict.ok === false && verdict.reason).toMatch(/1 episode\(s\) that are not monitored/);
  });

  it("reads an undated episode as aired when a later one has", () => {
    expect(judge(season(5, (n) => (n === 5 ? { airDate: "2020-02-01" } : { airDate: null }))).ok).toBe(true);
    expect(judge(season(5, () => ({ airDate: null }))).ok).toBe(false);
  });

  it("judges a ranged batch by the episodes in its range only", () => {
    const episodes = season(24, (n) => (n > 12 ? { airDate: "2026-12-01" } : {}));
    expect(judge(episodes, { range: [1, 12] })).toMatchObject({ ok: true, covered: 12 });
    expect(judge(episodes, { range: [13, 24] }).ok).toBe(false);
  });

  it("refuses a pack for a season it knows no episode of", () => {
    expect(judge(season(3), { seasonNo: 4 })).toMatchObject({ ok: false });
  });

  it("reads the season by the scene's numbering where the show has one", () => {
    const episodes = season(4, () => ({ seasonNumber: 1, sceneSeason: 2 }));
    expect(judge(episodes, { seasonNo: 2 })).toMatchObject({ ok: true, covered: 4 });
    expect(judge(episodes, { seasonNo: 1 }).ok).toBe(false);
  });

  it("applies none of the guards when they are off, and a different share when set", () => {
    const unfinished = season(10, (n) => (n > 8 ? { airDate: "2026-12-01", monitored: false } : {}));
    expect(judge(unfinished, { settings: { guards: false, sharePercent: 50 } }).ok).toBe(true);
    const mostlyOnDisk = season(10, (n) => (n <= 2 ? {} : { hasFile: true, quality: "Bluray-1080p" }));
    expect(judge(mostlyOnDisk, { cutoff: "Bluray-1080p" }).ok).toBe(false);
    expect(judge(mostlyOnDisk, { cutoff: "Bluray-1080p", settings: { guards: true, sharePercent: 20 } }).ok).toBe(true);
    expect(judge(mostlyOnDisk, { cutoff: "Bluray-1080p", settings: { guards: true, sharePercent: 0 } }).ok).toBe(true);
  });
});

describe("packSettings", () => {
  it("defaults to guards on and half the season, and reads the two settings", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    expect(packs.packSettings()).toEqual({ guards: true, sharePercent: 50 });
    setSetting("seasonPackGuards", "0");
    setSetting("seasonPackShare", "80");
    expect(packs.packSettings()).toEqual({ guards: false, sharePercent: 80 });
    setSetting("seasonPackShare", "banana");
    expect(packs.packSettings().sharePercent).toBe(50);
    setSetting("seasonPackGuards", "");
    setSetting("seasonPackShare", "");
    expect(packs.packSettings()).toEqual({ guards: true, sharePercent: 50 });
  });
});
