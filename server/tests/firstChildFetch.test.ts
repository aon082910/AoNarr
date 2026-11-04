import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30c: an add whose first fetch of episodes or albums failed keeps its Monitor choice, and the first refresh that
// does get the list applies it. Before, that refresh saw an item with no children, treated everything as the Add's list
// with no choice and monitored the whole back catalogue.

const fetchSeriesEpisodesFor = vi.fn();
const fetchArtistAlbumsFor = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    fetchSeriesEpisodesFor: (...args: unknown[]) => fetchSeriesEpisodesFor(...args),
    fetchArtistAlbumsFor: (...args: unknown[]) => fetchArtistAlbumsFor(...args),
    fetchAlbumTracksFor: async () => [],
  };
});
vi.mock("../src/services/sceneNumbering.js", () => ({ syncSceneNumbering: async () => ({ updated: 0 }) }));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let refreshNewChildren: (typeof import("../src/services/libraryScan.js"))["refreshNewChildren"];

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ refreshNewChildren } = await import("../src/services/libraryScan.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  for (const t of ["episodes", "sub_items", "media_items", "root_folders"]) await db.prepare(`DELETE FROM ${t}`).run();
  for (const type of ["series", "artist"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aonarr-firstfetch-${type}-`));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, type);
  }
  fetchSeriesEpisodesFor.mockReset();
  fetchArtistAlbumsFor.mockReset();
  // The add's background provider lookups find nothing.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })));
});

const importMedia = (body: Record<string, unknown>) => request(app).post("/api/metadata/import").set("X-Api-Key", apiKey).send(body);
const itemRow = async (id: number) => (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any;

const albums = [
  { title: "Debut", releaseDate: "1999-01-01", externalId: "a1" },
  { title: "Middle", releaseDate: "2008-01-01", externalId: "a2" },
  { title: "Latest", releaseDate: "2020-01-01", externalId: "a3" },
];
const albumList = (list = albums) => ({ provider: "musicbrainz", albums: list });
const monitoredAlbums = async (id: number) =>
  ((await db.prepare("SELECT title FROM sub_items WHERE media_item_id = ? AND monitored = 1 ORDER BY title").all(id)) as any[]).map((r) => r.title);

const episodes = [
  { seasonNumber: 1, episodeNumber: 1, title: "Old One", airDate: "2020-01-01", overview: null },
  { seasonNumber: 1, episodeNumber: 2, title: "Old Two", airDate: "2020-01-08", overview: null },
  { seasonNumber: 2, episodeNumber: 1, title: "Coming", airDate: day(30), overview: null },
];
const monitoredEpisodes = async (id: number) =>
  ((await db.prepare("SELECT title FROM episodes WHERE media_item_id = ? AND monitored = 1 ORDER BY season_number, episode_number").all(id)) as any[]).map((r) => r.title);

describe("an artist whose first album fetch failed", () => {
  async function addArtistWithFailedFetch(extra: Record<string, unknown> = {}): Promise<number> {
    fetchArtistAlbumsFor.mockRejectedValue(new Error("MusicBrainz is down"));
    const res = await importMedia({ type: "artist", title: "Late Band", externalIds: { musicbrainz: "mb-late" }, monitorStrategy: "latest", ...extra });
    expect(res.status).toBe(201);
    expect(res.body.childCount).toBe(0);
    return Number(res.body.id);
  }

  it("keeps the add's Monitor choice and applies it to the first list a refresh brings", async () => {
    const id = await addArtistWithFailedFetch();
    expect((await itemRow(id)).pending_monitor).toBe("latest");
    expect((await itemRow(id)).children_synced_at).toBeNull();

    fetchArtistAlbumsFor.mockResolvedValue(albumList());
    expect((await refreshNewChildren()).childrenAdded).toBe(3);

    expect(await monitoredAlbums(id)).toEqual(["Latest"]);
    const after = await itemRow(id);
    expect(after.pending_monitor).toBeNull();
    expect(after.children_synced_at).not.toBeNull();
  });

  it("keeps waiting through a refresh that fails or lists nothing", async () => {
    const id = await addArtistWithFailedFetch();

    fetchArtistAlbumsFor.mockRejectedValue(new Error("still down"));
    await refreshNewChildren();
    fetchArtistAlbumsFor.mockResolvedValue(albumList([]));
    await refreshNewChildren();
    expect((await itemRow(id)).pending_monitor).toBe("latest");
    expect((await itemRow(id)).children_synced_at).toBeNull();

    fetchArtistAlbumsFor.mockResolvedValue(albumList());
    await refreshNewChildren();
    expect(await monitoredAlbums(id)).toEqual(["Latest"]);
  });

  it("applies Monitor New Items only to albums listed after that first list", async () => {
    const id = await addArtistWithFailedFetch({ monitorNewItems: "none" });
    fetchArtistAlbumsFor.mockResolvedValue(albumList());
    await refreshNewChildren();
    expect(await monitoredAlbums(id)).toEqual(["Latest"]);

    fetchArtistAlbumsFor.mockResolvedValue(albumList([...albums, { title: "Newest", releaseDate: "2025-01-01", externalId: "a4" }]));
    await refreshNewChildren();
    expect(await monitoredAlbums(id)).toEqual(["Latest"]);
  });

  it("an add that got its albums needs nothing kept, and records the fetch", async () => {
    fetchArtistAlbumsFor.mockResolvedValue(albumList());
    const res = await importMedia({ type: "artist", title: "Prompt Band", externalIds: { musicbrainz: "mb-prompt" }, monitorStrategy: "latest" });
    const id = Number(res.body.id);

    expect(await monitoredAlbums(id)).toEqual(["Latest"]);
    const row = await itemRow(id);
    expect(row.pending_monitor).toBeNull();
    expect(row.children_synced_at).not.toBeNull();
  });
});

describe("a series whose first episode fetch failed", () => {
  it("keeps the add's Monitor choice and applies it to the first list a refresh brings", async () => {
    fetchSeriesEpisodesFor.mockRejectedValue(new Error("TMDB is down"));
    const res = await importMedia({ type: "series", title: "Late Show", externalIds: { tmdb: "9301" }, monitorStrategy: "future" });
    expect(res.status).toBe(201);
    const id = Number(res.body.id);
    expect((await itemRow(id)).pending_monitor).toBe("future");

    await db.prepare("UPDATE media_items SET status = 'continuing' WHERE id = ?").run(id);
    fetchSeriesEpisodesFor.mockResolvedValue(episodes);
    expect((await refreshNewChildren()).childrenAdded).toBe(3);

    expect(await monitoredEpisodes(id)).toEqual(["Coming"]);
    const after = await itemRow(id);
    expect(after.pending_monitor).toBeNull();
    expect(after.children_synced_at).not.toBeNull();
  });

  it("applies Monitor New Items only to episodes listed after that first list", async () => {
    fetchSeriesEpisodesFor.mockRejectedValue(new Error("TMDB is down"));
    const res = await importMedia({ type: "series", title: "Policy Show", externalIds: { tmdb: "9302" }, monitorStrategy: "none", monitorNewItems: "none" });
    const id = Number(res.body.id);

    fetchSeriesEpisodesFor.mockResolvedValue(episodes);
    await refreshNewChildren();
    expect(await monitoredEpisodes(id)).toEqual([]);

    // A new season later: the item's own "none" choice now applies.
    fetchSeriesEpisodesFor.mockResolvedValue([...episodes, { seasonNumber: 3, episodeNumber: 1, title: "Next Year", airDate: day(400), overview: null }]);
    await refreshNewChildren();
    expect(await monitoredEpisodes(id)).toEqual([]);
  });
});
