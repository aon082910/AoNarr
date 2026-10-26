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

  it("stores the scene's running number and uses it as the episode's absolute number (Round 12, I10)", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const { computeAbsoluteEpisodeNumber } = await import("../src/services/importer.js");
    const showId = await insertSeries("anime", "Scene Absolute Show", { tvdb: "117" });
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    mockXemResponse({
      result: "success",
      data: [{ scene: { season: 2, episode: 1, absolute: 26 }, tvdb: { season: 1, episode: 1 } }],
    });

    expect(await syncSceneNumbering(showId)).toEqual({ updated: 1 });
    const row = (await db.prepare("SELECT scene_absolute_number FROM episodes WHERE media_item_id = ? AND season_number = 1 AND episode_number = 1").get(showId)) as any;
    expect(Number(row.scene_absolute_number)).toBe(26);
    expect(await computeAbsoluteEpisodeNumber(showId, 1, 1)).toBe(26);
    // An episode TheXEM does not map is still counted.
    expect(await computeAbsoluteEpisodeNumber(showId, 1, 2)).toBe(2);
    // A later list that drops the number clears it.
    mockXemResponse({ result: "success", data: [{ scene: { season: 2, episode: 1 }, tvdb: { season: 1, episode: 1 } }] });
    await syncSceneNumbering(showId);
    expect(await computeAbsoluteEpisodeNumber(showId, 1, 1)).toBe(1);
  });

  it("marks the numbers carried forward past the last mapping as unverified, and clears the mark when TheXEM lists them", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Carried Show", { tvdb: "118" });
    for (const [e, air] of [[26, "2024-01-01"], [27, "2024-02-01"]] as const) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, air_date) VALUES (?, 1, ?, 1, 0, ?)").run(showId, e, air);
    }
    mockXemResponse({ result: "success", data: [{ scene: { season: 2, episode: 13 }, tvdb: { season: 1, episode: 26 } }] });
    await syncSceneNumbering(showId);
    const flag = async (e: number) => Number(((await db.prepare("SELECT scene_unverified FROM episodes WHERE media_item_id = ? AND episode_number = ?").get(showId, e)) as any).scene_unverified);
    expect([await flag(26), await flag(27)]).toEqual([0, 1]);
    expect(await sceneNumbers(showId, 1, 27)).toEqual({ scene_season_number: 2, scene_episode_number: 14 });
    mockXemResponse({
      result: "success",
      data: [
        { scene: { season: 2, episode: 13 }, tvdb: { season: 1, episode: 26 } },
        { scene: { season: 2, episode: 14 }, tvdb: { season: 1, episode: 27 } },
      ],
    });
    await syncSceneNumbering(showId);
    expect([await flag(26), await flag(27)]).toEqual([0, 0]);
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

describe("sceneIndexFor", () => {
  it("maps each scene number that differs from the aired one to the episode that carries it", async () => {
    const { sceneIndexFor } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Index Show", { tvdb: "900" });
    await insertEpisode(showId, 1, 5);
    await insertEpisode(showId, 5, 1);
    await insertEpisode(showId, 2, 2);
    await db.prepare("UPDATE episodes SET scene_season_number = 5, scene_episode_number = 1 WHERE media_item_id = ? AND season_number = 1 AND episode_number = 5").run(showId);
    await db.prepare("UPDATE episodes SET scene_season_number = 2, scene_episode_number = 2 WHERE media_item_id = ? AND season_number = 2 AND episode_number = 2").run(showId);

    const index = await sceneIndexFor(showId);

    // S02E02 maps to itself and says nothing.
    expect(Array.from(index!.entries())).toEqual([["5:1", "1:5"]]);
  });

  it("is undefined for a show with no scene numbering, and when the mode setting asks for the older rule", async () => {
    const { sceneIndexFor } = await import("../src/services/sceneNumbering.js");
    const { setSetting } = await import("../src/services/settingsStore.js");
    const plain = await insertSeries("series", "Unmapped Index Show", { tvdb: "901" });
    await insertEpisode(plain, 1, 1);
    expect(await sceneIndexFor(plain)).toBeUndefined();

    const mapped = await insertSeries("series", "Mode Index Show", { tvdb: "902" });
    await insertEpisode(mapped, 1, 2);
    await db.prepare("UPDATE episodes SET scene_season_number = 3, scene_episode_number = 4 WHERE media_item_id = ?").run(mapped);
    expect(await sceneIndexFor(mapped)).toBeDefined();
    setSetting("sceneNumberingMode", "or");
    try {
      expect(await sceneIndexFor(mapped)).toBeUndefined();
    } finally {
      setSetting("sceneNumberingMode", "");
    }
  });
});

describe("syncSceneNumbering — a corrected mapping", () => {
  it("clears the scene numbers TheXEM no longer lists before writing the new ones", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Remapped Show", { tvdb: "903" });
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    mockXemResponse({ result: "success", data: [{ tvdb: { season: 1, episode: 1 }, scene: { season: 2, episode: 1 } }, { tvdb: { season: 1, episode: 2 }, scene: { season: 2, episode: 2 } }] });
    expect(await syncSceneNumbering(showId)).toEqual({ updated: 2 });

    // The corrected mapping drops episode 2.
    mockXemResponse({ result: "success", data: [{ tvdb: { season: 1, episode: 1 }, scene: { season: 2, episode: 1 } }] });
    expect(await syncSceneNumbering(showId)).toEqual({ updated: 1 });

    expect(await sceneNumbers(showId, 1, 1)).toEqual({ scene_season_number: 2, scene_episode_number: 1 });
    expect(await sceneNumbers(showId, 1, 2)).toEqual({ scene_season_number: null, scene_episode_number: null });

    // A show TheXEM stops mapping at all is cleared too.
    mockXemResponse({ result: "success", data: [] });
    expect(await syncSceneNumbering(showId)).toEqual({ updated: 0 });
    expect(await sceneNumbers(showId, 1, 1)).toEqual({ scene_season_number: null, scene_episode_number: null });
  });

  it("leaves the existing scene numbers alone when TheXEM answers without a mapping or fails", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Kept Mapping Show", { tvdb: "904" });
    await insertEpisode(showId, 1, 1);
    await db.prepare("UPDATE episodes SET scene_season_number = 2, scene_episode_number = 1 WHERE media_item_id = ?").run(showId);

    mockXemResponse({ result: "failure", message: "no show" });
    expect(await syncSceneNumbering(showId)).toEqual({ updated: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as any));
    expect(await syncSceneNumbering(showId)).toEqual({ error: expect.stringContaining("HTTP 503") });

    expect(await sceneNumbers(showId, 1, 1)).toEqual({ scene_season_number: 2, scene_episode_number: 1 });
  });
});


describe("TheXEM numbering fits the rows it is written to (Round 12, I7) and carries on past its last entry (I11)", () => {
  const entry = (tvdb: [number, number], scene: [number, number]) => ({ tvdb: { season: tvdb[0], episode: tvdb[1] }, scene: { season: scene[0], episode: scene[1] } });

  it("extrapolates the last shifted mapping to the episodes newer than the map", async () => {
    const { extrapolateSceneNumbers } = await import("../src/services/sceneNumbering.js");
    const wanted = new Map([
      ["1:13", { season: 1, episode: 13 }],
      ["1:14", { season: 2, episode: 1 }],
      ["1:15", { season: 2, episode: 2 }],
    ]);
    const rows = [13, 14, 15, 16, 17].map((e) => ({ season_number: 1, episode_number: e, air_date: `2025-01-${String(e).padStart(2, "0")}` }));
    // An older episode the map dropped is left alone.
    rows.push({ season_number: 1, episode_number: 99, air_date: "2020-01-01" });
    expect(Object.fromEntries(extrapolateSceneNumbers(rows, wanted))).toEqual({ "1:16": { season: 2, episode: 3 }, "1:17": { season: 2, episode: 4 } });
    expect(extrapolateSceneNumbers(rows, wanted).has("1:99")).toBe(false);
  });

  it("extends nothing where the last mapping is not shifted, or the season has no mapping", async () => {
    const { extrapolateSceneNumbers } = await import("../src/services/sceneNumbering.js");
    const same = new Map([["1:1", { season: 1, episode: 1 }], ["1:2", { season: 1, episode: 2 }]]);
    expect(extrapolateSceneNumbers([1, 2, 3].map((e) => ({ season_number: 1, episode_number: e })), same).size).toBe(0);
    expect(extrapolateSceneNumbers([{ season_number: 2, episode_number: 5 }], new Map([["1:1", { season: 2, episode: 1 }]])).size).toBe(0);
  });

  it("an episode list that lacks an episode the mapping names is another numbering", async () => {
    const { xemAlignsWithRows } = await import("../src/services/sceneNumbering.js");
    const wanted = new Map([["11:1", { season: 11, episode: 1 }]]);
    expect(xemAlignsWithRows([{ season_number: 11, episode_number: 1 }], wanted)).toBe(true);
    expect(xemAlignsWithRows([{ season_number: 10, episode_number: 22 }], wanted)).toBe(false);
  });

  it("leaves the scene numbers alone for a show with a TMDB id whose seasons the mapping does not fit", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Split Seasons Show", { tvdb: "9001", tmdb: "9002" });
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    mockXemResponse({ result: "success", data: [entry([2, 1], [1, 1]), entry([2, 2], [1, 2])] });
    expect(await syncSceneNumbering(showId)).toEqual({ updated: 0 });
    expect(await sceneNumbers(showId, 1, 1)).toEqual({ scene_season_number: null, scene_episode_number: null });
  });

  it("maps and extrapolates for a TVDB-only show", async () => {
    const { syncSceneNumbering } = await import("../src/services/sceneNumbering.js");
    const showId = await insertSeries("series", "Tvdb Only Show", { tvdb: "9003" });
    for (const e of [1, 2, 3]) await insertEpisode(showId, 1, e);
    await db.prepare("UPDATE episodes SET air_date = ? WHERE media_item_id = ?").run("2025-03-01", showId);
    await db.prepare("UPDATE episodes SET air_date = '2025-03-08' WHERE media_item_id = ? AND episode_number = 2").run(showId);
    await db.prepare("UPDATE episodes SET air_date = '2025-03-15' WHERE media_item_id = ? AND episode_number = 3").run(showId);
    mockXemResponse({ result: "success", data: [entry([1, 1], [2, 1]), entry([1, 2], [2, 2])] });
    await syncSceneNumbering(showId);
    expect(await sceneNumbers(showId, 1, 2)).toEqual({ scene_season_number: 2, scene_episode_number: 2 });
    // Episode 3 is newer than the map: it carries the offset forward.
    expect(await sceneNumbers(showId, 1, 3)).toEqual({ scene_season_number: 2, scene_episode_number: 3 });
  });
});
