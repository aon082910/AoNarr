import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// scoreRelease costs several queries, so the test sees how many of them are running at once.
let inFlight = 0;
let maxInFlight = 0;
let calls: string[] = [];
const scoreOf = vi.fn((title: string): number => (title.includes("-WINNER") ? 50 : 3));
vi.mock("../src/services/customFormatScoring.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  scoreRelease: async (title: string) => {
    calls.push(title);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight--;
    return { totalScore: scoreOf(title), matches: [], rejected: false, rejectReason: null };
  },
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let sched: typeof import("../src/services/scheduler.js");
let mapLimit: (typeof import("../src/services/mapLimit.js"))["mapLimit"];
let profileId: number;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  sched = await import("../src/services/scheduler.js");
  ({ mapLimit } = await import("../src/services/mapLimit.js"));
  const quality = await import("../src/services/quality.js");
  await quality.loadQualityCaches();
  // Files at the quality cutoff, with a format cutoff above their score: a same-quality pack is an upgrade only by its score.
  profileId = Number(
    (
      await db
        .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, cutoff_format_score, min_upgrade_format_score) VALUES ('Pack scoring', ?, 'WEBDL-1080p', 100, 10)")
        .run(JSON.stringify(["WEBDL-720p", "WEBDL-1080p"]))
    ).lastInsertRowid
  );
});

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
  calls = [];
});

const episodes = [1, 2, 3, 4].map((n) => ({
  seasonNumber: 1,
  episodeNumber: n,
  sceneSeason: null,
  sceneEpisode: null,
  monitored: true,
  hasFile: true,
  quality: "WEBDL-1080p",
  airDate: "2020-01-01",
  releaseTitle: `Show.S01E0${n}.1080p.WEB-DL.x264-GRPA`,
  formatScore: 0,
}));

const pack = (suffix: string): any => ({
  indexerId: null,
  indexerName: "T",
  title: `Show.S01.1080p.WEB-DL.x264-${suffix}`,
  size: 20_000_000_000,
  seeders: 50,
  leechers: 1,
  publishDate: "2020-02-01T00:00:00Z",
  downloadUrl: `magnet:?xt=${suffix}`,
  protocol: "torrent",
  category: null,
});

describe("season packs are scored a few at a time (Round 30c)", () => {
  it("scores many packs at once, never more than the bound, and judges them as one at a time would", async () => {
    // Eleven packs add too little to the files' score; one adds enough. A serial run takes the same one.
    const results = [...Array.from({ length: 11 }, (_, i) => pack(`LOW${i}`)), pack("WINNER")];

    const chosen = await sched.chooseBestResult(results, ["WEBDL-720p", "WEBDL-1080p"], "WEBDL-1080p", profileId, 0, null, new Set(), "series", null, null, null, {
      pack: { item: { type: "series", seriesType: null }, season: 1, episodes },
      packJudgesUpgrades: true,
    });

    expect(chosen?.result.title).toBe("Show.S01.1080p.WEB-DL.x264-WINNER");
    // Every pack was scored once for its verdict (and the survivor once more to rank it).
    expect(calls.filter((t) => t.includes("-LOW"))).toHaveLength(11);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(sched.PACK_SCORING_CONCURRENCY);
  });

  it("gives each pack its own score, so several that qualify are ranked by score as before", async () => {
    const slowFirst = vi.fn((title: string) => (title.includes("-A") ? 40 : title.includes("-B") ? 30 : 3));
    scoreOf.mockImplementation(slowFirst);
    try {
      const results = [pack("A"), pack("B"), pack("C")];
      const chosen = await sched.chooseBestResult(results, ["WEBDL-720p", "WEBDL-1080p"], "WEBDL-1080p", profileId, 0, null, new Set(), "series", null, null, null, {
        pack: { item: { type: "series", seriesType: null }, season: 1, episodes },
        packJudgesUpgrades: true,
      });
      // A and B both upgrade by score, C does not; the higher scored of the two is taken.
      expect(chosen?.result.title).toBe("Show.S01.1080p.WEB-DL.x264-A");
    } finally {
      scoreOf.mockImplementation((title: string) => (title.includes("-WINNER") ? 50 : 3));
    }
  });
});

describe("mapLimit", () => {
  it("keeps the order of the items, runs at most `limit` at once and lets a failure through", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 2, 8], 3, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    await expect(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("boom"); return n; })).rejects.toThrow("boom");
  });
});
