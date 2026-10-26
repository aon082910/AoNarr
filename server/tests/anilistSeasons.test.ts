import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { parseReleaseTitle, releaseMatchesEpisode } from "../src/services/releaseParser.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let seasons: typeof import("../src/services/anilistSeasons.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  seasons = await import("../src/services/anilistSeasons.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Entry {
  id: number;
  format: string;
  episodes: number | null;
  prequels?: number[];
}

/** Stubs AniList's relations query over a small graph of entries. */
function stubAnilist(entries: Entry[]): ReturnType<typeof vi.fn> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const id = JSON.parse(init.body).variables.id as number;
    const media = byId.get(id);
    if (!media) return { ok: true, json: async () => ({ data: { Media: null } }) } as any;
    const edges = (media.prequels ?? []).map((p) => {
      const node = byId.get(p)!;
      return { relationType: "PREQUEL", node: { id: node.id, type: "ANIME", format: node.format, episodes: node.episodes } };
    });
    return { ok: true, json: async () => ({ data: { Media: { id, relations: { edges } } } }) } as any;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function anime(title: string, externalIds: Record<string, string>, extra: object | null, episodes: number): Promise<number> {
  const id = Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids, extra_metadata) VALUES ('anime', ?, ?, 1, 0, 'unknown', ?, ?)")
        .run(title, title.toLowerCase(), JSON.stringify(externalIds), extra ? JSON.stringify(extra) : null)
    ).lastInsertRowid
  );
  for (let n = 1; n <= episodes; n++) {
    await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, ?, 1, 0)").run(id, n);
  }
  return id;
}

const rowOf = async (itemId: number, n: number) =>
  (await db.prepare("SELECT scene_season_number, scene_episode_number, absolute_episode_number FROM episodes WHERE media_item_id = ? AND episode_number = ?").get(itemId, n)) as any;

describe("fetchAnilistSeasonContext", () => {
  it("counts the earlier seasons and their episodes, walking through a movie that is not one", async () => {
    stubAnilist([
      { id: 3, format: "TV", episodes: 12, prequels: [20] },
      { id: 20, format: "MOVIE", episodes: 1, prequels: [2] },
      { id: 2, format: "TV", episodes: 13, prequels: [1] },
      { id: 1, format: "TV", episodes: 24 },
    ]);
    expect(await seasons.fetchAnilistSeasonContext("3")).toEqual({ ordinal: 3, offset: 37, complete: true });
  });

  it("is season 1 with no offset when nothing comes before", async () => {
    stubAnilist([{ id: 1, format: "TV", episodes: 24 }]);
    expect(await seasons.fetchAnilistSeasonContext("1")).toEqual({ ordinal: 1, offset: 0, complete: true });
  });

  it("marks the offset incomplete when an earlier season's episode count is unknown", async () => {
    stubAnilist([
      { id: 2, format: "TV", episodes: 12, prequels: [1] },
      { id: 1, format: "TV", episodes: null },
    ]);
    expect(await seasons.fetchAnilistSeasonContext("2")).toEqual({ ordinal: 2, offset: 0, complete: false });
  });

  it("prefers the season before over a recap movie among the prequels, and survives a loop", async () => {
    stubAnilist([
      { id: 2, format: "TV", episodes: 12, prequels: [9, 1] },
      { id: 9, format: "SPECIAL", episodes: 1 },
      { id: 1, format: "TV", episodes: 12, prequels: [2] },
    ]);
    expect(await seasons.fetchAnilistSeasonContext("2")).toEqual({ ordinal: 2, offset: 12, complete: true });
  });

  it("throws when AniList cannot be asked, so nothing is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 }) as any));
    await expect(seasons.fetchAnilistSeasonContext("5")).rejects.toThrow(/HTTP 429/);
  });
});

describe("applyAnilistSeasonToEpisodes", () => {
  it("numbers a sequel's rows with its season and the show's running absolute number", async () => {
    const id = await anime("Show Season 2", { anilist: "11" }, { anilistSeason: { ordinal: 2, offset: 24, complete: true, checkedAt: "2026-10-26" } }, 3);
    expect(await seasons.applyAnilistSeasonToEpisodes(id)).toBeGreaterThan(0);
    expect(await rowOf(id, 1)).toEqual({ scene_season_number: 2, scene_episode_number: 1, absolute_episode_number: 25 });
    expect(await rowOf(id, 3)).toEqual({ scene_season_number: 2, scene_episode_number: 3, absolute_episode_number: 27 });
    // Run again: nothing left to change.
    expect(await seasons.applyAnilistSeasonToEpisodes(id)).toBe(0);
  });

  it("gives a first season its absolute numbers and no scene numbers", async () => {
    const id = await anime("Show", { anilist: "10" }, { anilistSeason: { ordinal: 1, offset: 0, complete: true, checkedAt: "2026-10-26" } }, 2);
    await db.prepare("UPDATE episodes SET scene_season_number = 2, scene_episode_number = episode_number WHERE media_item_id = ?").run(id);
    await seasons.applyAnilistSeasonToEpisodes(id);
    expect(await rowOf(id, 2)).toEqual({ scene_season_number: null, scene_episode_number: null, absolute_episode_number: 2 });
  });

  it("leaves the absolute numbers alone when the offset is only a lower bound", async () => {
    const id = await anime("Show Season 2 B", { anilist: "12" }, { anilistSeason: { ordinal: 2, offset: 0, complete: false, checkedAt: "2026-10-26" } }, 2);
    await seasons.applyAnilistSeasonToEpisodes(id);
    expect(await rowOf(id, 1)).toEqual({ scene_season_number: 2, scene_episode_number: 1, absolute_episode_number: null });
  });

  it("never touches a show whose rows are TVDB's or TMDB's, or one with no stored context", async () => {
    const tvdb = await anime("Tvdb Numbered", { anilist: "13", tvdb: "99" }, { anilistSeason: { ordinal: 2, offset: 24, complete: true, checkedAt: "x" } }, 2);
    const none = await anime("No Context", { anilist: "14" }, null, 2);
    expect(await seasons.applyAnilistSeasonToEpisodes(tvdb)).toBe(0);
    expect(await seasons.applyAnilistSeasonToEpisodes(none)).toBe(0);
    expect(await rowOf(tvdb, 1)).toEqual({ scene_season_number: null, scene_episode_number: null, absolute_episode_number: null });
  });
});

describe("matching a sequel's episodes (Round 12, I4)", () => {
  it("takes the sequel's own season, its continuing absolute number and its batch, and refuses season 1's releases", async () => {
    const { sceneIndexFor } = await import("../src/services/sceneNumbering.js");
    const { computeAbsoluteEpisodeNumber } = await import("../src/services/importer.js");
    const id = await anime("Mushoku Tensei Season 2", { anilist: "21" }, { anilistSeason: { ordinal: 2, offset: 24, complete: true, checkedAt: "x" } }, 12);
    await seasons.applyAnilistSeasonToEpisodes(id);
    const sceneIndex = await sceneIndexFor(id);
    const absolute = await computeAbsoluteEpisodeNumber(id, 1, 5);
    expect(absolute).toBe(29);
    const matches = (title: string) => releaseMatchesEpisode(parseReleaseTitle(title), 1, 5, 2, 5, absolute, sceneIndex);

    // Its own season's releases.
    expect(matches("[SubsPlease] Mushoku Tensei S2 - 05 (1080p)")).toBe(true);
    expect(matches("Mushoku.Tensei.S02E05.1080p.WEB-DL-GRP")).toBe(true);
    // The show's running number, which AniList's S2 entry starts at 25.
    expect(matches("[SubsPlease] Mushoku Tensei - 29 (1080p)")).toBe(true);
    // A season-less batch of the sequel's numbers.
    expect(matches("[Erai-raws] Mushoku Tensei - 25~36 [1080p]")).toBe(true);
    // Season 1's releases are not the sequel's episode 5: the wrong grab of the audit.
    expect(matches("[SubsPlease] Mushoku Tensei - 05 (1080p)")).toBe(false);
    expect(matches("Mushoku.Tensei.S01E05.1080p.WEB-DL-GRP")).toBe(false);
    expect(matches("[Erai-raws] Mushoku Tensei - 01~11 [1080p]")).toBe(false);
  });

  it("computeAbsoluteEpisodeNumber counts when no number is stored", async () => {
    const { computeAbsoluteEpisodeNumber } = await import("../src/services/importer.js");
    const id = await anime("Plain Anime", { anilist: "22" }, null, 5);
    expect(await computeAbsoluteEpisodeNumber(id, 1, 4)).toBe(4);
  });
});

describe("refreshAnilistSeason and the backfill", () => {
  it("reads the chain, stores it with the item and numbers the rows", async () => {
    stubAnilist([
      { id: 31, format: "TV", episodes: 12, prequels: [30] },
      { id: 30, format: "TV", episodes: 25 },
    ]);
    const id = await anime("Chain Show Season 2", { anilist: "31" }, null, 3);
    const context = await seasons.refreshAnilistSeason(id);
    expect(context).toMatchObject({ ordinal: 2, offset: 25, complete: true });
    const stored = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(id)) as { extra_metadata: string };
    expect(seasons.seasonContextOf(stored.extra_metadata)).toMatchObject({ ordinal: 2, offset: 25 });
    expect(await rowOf(id, 2)).toEqual({ scene_season_number: 2, scene_episode_number: 2, absolute_episode_number: 27 });
  });

  it("does nothing for a show that is not an AniList-numbered anime", async () => {
    const fetchSpy = stubAnilist([]);
    const id = await anime("Other Provider Show", { anilist: "40", tmdb: "5" }, null, 1);
    expect(await seasons.refreshAnilistSeason(id)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the backfill visits only entries with no stored season, and stops asking when AniList refuses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubAnilist([{ id: 51, format: "TV", episodes: 12 }]);
      await db.prepare("DELETE FROM episodes").run();
      await db.prepare("DELETE FROM media_items").run();
      const todo = await anime("Needs Season", { anilist: "51" }, null, 1);
      await anime("Has Season", { anilist: "52" }, { anilistSeason: { ordinal: 1, offset: 0, complete: true, checkedAt: "x" } }, 1);
      const run = seasons.backfillAnilistSeasons();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await run).toEqual({ checked: 1, failed: 0 });
      const stored = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(todo)) as { extra_metadata: string };
      expect(seasons.seasonContextOf(stored.extra_metadata)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
