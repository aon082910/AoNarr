import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockXemResponse(response: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => response }) as any));
}

async function insertSeries(type: "series" | "anime" | "movie", title: string, externalIds: Record<string, string> | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES (?, ?, ?, 1, 0, 'unknown', ?)`
        )
        .run(type, title, title.toLowerCase(), externalIds ? JSON.stringify(externalIds) : null)
    ).lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number): Promise<void> {
  await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, ?, ?, 1, 0)").run(
    showId,
    season,
    episode
  );
}

async function sceneNumbers(showId: number, season: number, episode: number): Promise<{ scene_season_number: number | null; scene_episode_number: number | null }> {
  return (await db
    .prepare("SELECT scene_season_number, scene_episode_number FROM episodes WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
    .get(showId, season, episode)) as any;
}

describe("syncSceneNumbering", () => {
  it("returns an error for a media item that doesn't exist", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const result = await syncSceneNumbering(999999);
    expect(result).toEqual({ error: "Media item not found" });
  });

  it("returns an error for a series with no external ids at all", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "No External Ids Show", null);
    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ error: expect.stringContaining("no TVDB id") });
  });

  it("returns an error for a series with external ids but no tvdb id", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "No Tvdb Id Show", { tmdb: "123" });
    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ error: expect.stringContaining("no TVDB id") });
  });

  it("returns an error when TheXEM responds with a non-ok status", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Http Error Show", { tvdb: "111" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as any));

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ error: expect.stringContaining("HTTP 500") });
  });

  it("returns an error when the fetch itself throws", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Network Fail Show", { tvdb: "112" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      })
    );

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ error: expect.stringContaining("connection reset") });
  });

  it("reports zero updated (not an error) when TheXEM has no mapping for this show", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "No Mapping Show", { tvdb: "113" });
    mockXemResponse({ result: "failure", message: "No such show" });

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ updated: 0 });
  });

  it("applies a scene-numbering mapping to the matching episode", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Mapped Show", { tvdb: "114" });
    await insertEpisode(showId, 5, 1);
    mockXemResponse({ result: "success", data: [{ scene: { season: 1, episode: 1 }, tvdb: { season: 5, episode: 1 } }] });

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ updated: 1 });
    expect(await sceneNumbers(showId, 5, 1)).toEqual({ scene_season_number: 1, scene_episode_number: 1 });
  });

  it("falls back to scene_2 when a primary scene mapping isn't present", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("anime", "Scene2 Show", { tvdb: "115" });
    await insertEpisode(showId, 3, 7);
    mockXemResponse({ result: "success", data: [{ scene_2: { season: 2, episode: 20 }, tvdb: { season: 3, episode: 7 } }] });

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ updated: 1 });
    expect(await sceneNumbers(showId, 3, 7)).toEqual({ scene_season_number: 2, scene_episode_number: 20 });
  });

  it("skips an entry with neither scene nor tvdb data, without counting or crashing", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Incomplete Entry Show", { tvdb: "116" });
    await insertEpisode(showId, 1, 1);
    mockXemResponse({ result: "success", data: [{ tvdb: { season: 1, episode: 1 } }] });

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ updated: 0 });
  });

  it("doesn't count a mapping entry that matches no existing episode row", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "No Matching Episode Show", { tvdb: "117" });
    // No episodes inserted at all for this show.
    mockXemResponse({ result: "success", data: [{ scene: { season: 1, episode: 1 }, tvdb: { season: 9, episode: 9 } }] });

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ updated: 0 });
  });

  it("applies multiple mapping entries in one sync, counting each successful update", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Multi Entry Show", { tvdb: "118" });
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    mockXemResponse({
      result: "success",
      data: [
        { scene: { season: 10, episode: 1 }, tvdb: { season: 1, episode: 1 } },
        { scene: { season: 10, episode: 2 }, tvdb: { season: 1, episode: 2 } },
      ],
    });

    const result = await syncSceneNumbering(showId);
    expect(result).toEqual({ updated: 2 });
  });
});

describe("syncAllSceneNumbering", () => {
  it("only processes series/anime types, applying each show's own mapping", async () => {
    const { syncAllSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const seriesId = await insertSeries("series", "All Sync Series", { tvdb: "200" });
    await insertEpisode(seriesId, 1, 1);
    const animeId = await insertSeries("anime", "All Sync Anime", { tvdb: "201" });
    await insertEpisode(animeId, 1, 1);
    // A movie sharing the "202" tvdb id that no other fixture in this file uses — if
    // syncAllSceneNumbering ever mis-included movies, this id turning up in a fetch call would
    // prove it; type-filtering happens in the DB query itself, so it never should.
    await insertSeries("movie", "All Sync Movie (should be skipped)", { tvdb: "202" });

    const requestedUrls: string[] = [];
    // Earlier tests in this file left their own series/anime rows behind (syncAllSceneNumbering
    // re-scans the whole table, not just this test's own fixtures), so the mock must tolerate any
    // tvdb id, not just the two this test cares about.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes("id=200")) {
          return { ok: true, json: async () => ({ result: "success", data: [{ scene: { season: 1, episode: 1 }, tvdb: { season: 1, episode: 1 } }] }) } as any;
        }
        if (url.includes("id=201")) {
          return { ok: true, json: async () => ({ result: "success", data: [{ scene: { season: 2, episode: 2 }, tvdb: { season: 1, episode: 1 } }] }) } as any;
        }
        return { ok: true, json: async () => ({ result: "failure" }) } as any;
      })
    );

    await syncAllSceneNumbering();

    expect(await sceneNumbers(seriesId, 1, 1)).toEqual({ scene_season_number: 1, scene_episode_number: 1 });
    expect(await sceneNumbers(animeId, 1, 1)).toEqual({ scene_season_number: 2, scene_episode_number: 2 });
    expect(requestedUrls.some((u) => u.includes("id=202"))).toBe(false);
  });
});
