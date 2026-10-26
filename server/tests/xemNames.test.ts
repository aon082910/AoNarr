import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { parseReleaseTitle } from "../src/services/releaseParser.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let xem: typeof import("../src/services/xemNames.js");
let aliases: typeof import("../src/services/releaseAliases.js");
let scene: typeof import("../src/services/sceneNumbering.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  xem = await import("../src/services/xemNames.js");
  aliases = await import("../src/services/releaseAliases.js");
  scene = await import("../src/services/sceneNumbering.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NAMES = {
  result: "success",
  data: {
    "2": { jp: ["Shingeki no Kyojin S2", "Shingeki no Kyojin (Season 2)"], us: ["Attack on Titan S2"] },
    "4": { jp: ["Shingeki no Kyojin: The Final Season"], us: ["Attack on Titan - S4"], fr: ["L'Attaque des Titans - Saison Finale"] },
    all: { jp: ["Shingeki no Kyojin"], es: ["Ataque a los Titanes (2013)"] },
  },
  message: "",
};

async function insertShow(title: string, tvdb: string | null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, external_ids) VALUES ('anime', ?, ?, 1, 0, 'unknown', ?)")
        .run(title, title.toLowerCase(), tvdb ? JSON.stringify({ tvdb }) : null)
    ).lastInsertRowid
  );
}

describe("TheXEM names (Round 12, I16)", () => {
  it("reads the names of each season and of the whole show", () => {
    const names = xem.parseXemNames(NAMES);
    expect(names).toContainEqual({ title: "Shingeki no Kyojin: The Final Season", season: 4 });
    expect(names).toContainEqual({ title: "Attack on Titan S2", season: 2 });
    expect(names).toContainEqual({ title: "Shingeki no Kyojin", season: null });
    expect(xem.parseXemNames({ result: "failure", data: {} })).toEqual([]);
    expect(xem.parseXemNames({ result: "success", data: [] })).toEqual([]);
    expect(xem.parseXemNames(null)).toEqual([]);
    expect(xem.parseXemNames({ result: "success", data: { x: { jp: ["Bad Season Key"] }, "3": { jp: [7, "", "Good Name"] } } })).toEqual([{ title: "Good Name", season: 3 }]);
  });

  it("stores them with their season, replacing the last list, and never the show's own name", async () => {
    const id = await insertShow("Shingeki no Kyojin", null);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => NAMES }) as any));
    expect(await xem.syncXemNames(id, "267440")).toBeGreaterThan(5);
    const seasons = await aliases.aliasSeasonsFor(id);
    expect(seasons.get(aliases.cleanTitle("Shingeki no Kyojin: The Final Season"))).toBe(4);
    expect(seasons.get(aliases.cleanTitle("Attack on Titan S2"))).toBe(2);
    // The show's own title is not an alias, and a name for the whole show carries no season.
    expect(seasons.has(aliases.cleanTitle("Shingeki no Kyojin"))).toBe(false);
    const rows = await aliases.aliasRowsFor(id);
    expect(rows.every((r) => r.source === "xem_alias")).toBe(true);
    // A later list replaces the earlier one.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: "success", data: { "5": { us: ["Attack on Titan S5"] } } }) }) as any));
    await xem.syncXemNames(id, "267440");
    expect(Array.from((await aliases.aliasSeasonsFor(id)).values())).toEqual([5]);
    // A failed request leaves what the show had.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await xem.syncXemNames(id, "267440")).toBe(0);
    expect(Array.from((await aliases.aliasSeasonsFor(id)).values())).toEqual([5]);
    expect(await xem.xemNameCount(id)).toBe(1);
  });

  it("is fetched with the scene numbering of a show with a TVDB id", async () => {
    const id = await insertShow("Attack on Titan", "267440");
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => (String(url).includes("/map/names") ? NAMES : { result: "success", data: [] }) }) as any);
    vi.stubGlobal("fetch", fetchMock);
    await scene.syncSceneNumbering(id);
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("?")[0])).toEqual(["https://thexem.info/map/names", "https://thexem.info/map/all"]);
    expect((await aliases.aliasSeasonsFor(id)).get(aliases.cleanTitle("Shingeki no Kyojin: The Final Season"))).toBe(4);
  });

  it("reads a release counted from 1 under a season's own name as that season's episode", () => {
    const seasons = new Map([[aliases.cleanTitle("Shingeki no Kyojin: The Final Season"), 4]]);
    const parsed = parseReleaseTitle("[Group] Shingeki no Kyojin - The Final Season - 05 [1080p]");
    expect(parsed.seasonNumber).toBeNull();
    const applied = aliases.applyAliasSeason(parsed, seasons);
    expect([applied.seasonNumber, applied.episodeNumbers, applied.absoluteEpisode]).toEqual([4, [5], 5]);
    // A release that has a season of its own, another title, or no episode is left as it was.
    const seasoned = parseReleaseTitle("Shingeki.no.Kyojin.The.Final.Season.S04E05.1080p-GRP");
    expect(aliases.applyAliasSeason(seasoned, seasons)).toBe(seasoned);
    const other = parseReleaseTitle("[Group] Another Show - 05 [1080p]");
    expect(aliases.applyAliasSeason(other, seasons)).toBe(other);
    expect(aliases.applyAliasSeason(parsed, new Map())).toBe(parsed);
  });

  it("lets the grab decision take that release for the season's episode, and not without the name", async () => {
    const sched = await import("../src/services/scheduler.js");
    const id = await insertShow("Shingeki no Kyojin", null);
    const release: any = {
      indexerId: null, indexerName: "Test", title: "[Group] Shingeki no Kyojin - The Final Season - 05 [1080p]", size: 1_500_000_000, seeders: 30, leechers: 1,
      publishDate: new Date().toISOString(), downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", category: null,
    };
    const target = { season: 4, episode: 5, absoluteEpisode: 80 };
    const choose = () => sched.chooseBestResult([release], [], "", null, 0, target, new Set(), "anime", null, null, id, { name: { title: "Shingeki no Kyojin" } });
    expect(await choose()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => NAMES }) as any));
    await xem.syncXemNames(id, "267440");
    expect((await choose())?.result).toBe(release);
  });
});
