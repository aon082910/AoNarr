import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

// Stubbed for the whole file rather than per test: the add's fire-and-forget enrichment (other
// providers, scene numbering) can still be calling out after a test's own assertions finish.
afterAll(() => {
  vi.unstubAllGlobals();
});

type Route = { test: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response | Promise<Response> };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Anything not routed answers 404, so the add's background provider lookups fail fast instead of
 * reaching the network. */
function stubFetch(routes: Route[]) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const route = routes.find((r) => r.test(url, init));
    return route ? route.respond(url, init) : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  stubFetch([]);
});

function importMedia(body: Record<string, unknown>) {
  return request(app).post("/api/metadata/import").set("X-Api-Key", apiKey).send(body);
}

async function episodeRows(mediaItemId: number) {
  return (await db
    .prepare("SELECT season_number, episode_number, monitored FROM episodes WHERE media_item_id = ? ORDER BY season_number, episode_number")
    .all(mediaItemId)) as { season_number: number; episode_number: number; monitored: number }[];
}

describe("POST /api/metadata/import — artwork", () => {
  const credentialed = "https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=dev-1&devpassword=dev-secret&ssid=me&sspassword=my-secret&jeuid=3&media=box-2D(wor)";
  const backdropRef = "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=3&media=fanart";

  it("stores ScreenScraper artwork behind the local-artwork proxy, credential-free", async () => {
    const res = await importMedia({ type: "rom", title: "Proxied Rom Import", posterUrl: credentialed, backdropUrl: backdropRef, externalIds: { screenscraper: "3" } });
    expect(res.status).toBe(201);

    const row = (await db
      .prepare("SELECT poster_url, backdrop_url, local_poster_path, local_poster_token, local_backdrop_path, local_backdrop_token FROM media_items WHERE id = ?")
      .get(res.body.id)) as Record<string, string | null>;
    expect(row.local_poster_token).toMatch(/^[0-9a-f]{40}$/);
    expect(row.poster_url).toBe(`/api/media/local-artwork/${row.local_poster_token}`);
    expect(row.local_poster_path).toMatch(/^screenscraper:https:\/\/neoclone\.screenscraper\.fr\/api2\/mediaJeu\.php\?/);
    expect(row.local_poster_path).toContain("jeuid=3");
    expect(row.backdrop_url).toBe(`/api/media/local-artwork/${row.local_backdrop_token}`);
    expect(row.local_backdrop_path).toBe(backdropRef);
    expect(row.local_backdrop_token).not.toBe(row.local_poster_token);
    expect(JSON.stringify(row)).not.toMatch(/dev-1|dev-secret|my-secret/);
    expect(res.body.posterUrl).toBe(row.poster_url);
  });

  it("stores any other artwork URL as given", async () => {
    const res = await importMedia({
      type: "movie",
      title: "Plain Artwork Import",
      posterUrl: "https://image.tmdb.org/t/p/w342/poster.jpg",
      backdropUrl: "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
      externalIds: { tmdb: "999001" },
    });
    expect(res.status).toBe(201);

    const row = await db
      .prepare("SELECT poster_url, backdrop_url, local_poster_path, local_poster_token, local_backdrop_path, local_backdrop_token FROM media_items WHERE id = ?")
      .get(res.body.id);
    expect(row).toEqual({
      poster_url: "https://image.tmdb.org/t/p/w342/poster.jpg",
      backdrop_url: "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
      local_poster_path: null,
      local_poster_token: null,
      local_backdrop_path: null,
      local_backdrop_token: null,
    });
  });
});

describe("POST /api/metadata/import — episode monitoring", () => {
  it("adds Season 0 specials unmonitored and every regular episode monitored", async () => {
    setSetting("tvdbApiKey", "tvdb-key");
    stubFetch([
      { test: (u) => u.startsWith("https://api4.thetvdb.com/v4/login"), respond: () => json({ data: { token: "tvdb-token" } }) },
      {
        test: (u) => u.startsWith("https://api4.thetvdb.com/v4/series/424242/episodes/default"),
        respond: () =>
          json({
            data: {
              episodes: [
                { seasonNumber: 0, number: 1, name: "Special One", aired: "2020-01-01" },
                { seasonNumber: 1, number: 1, name: "Pilot", aired: "2020-01-05" },
                { seasonNumber: 1, number: 2, name: "Second", aired: "2020-01-12" },
                { seasonNumber: 0, number: 2, name: "Special Two", aired: "2020-02-01" },
                { seasonNumber: 2, number: 1, name: "Return", aired: "2021-01-05" },
              ],
            },
            links: { next: null },
          }),
      },
    ]);

    const res = await importMedia({ type: "series", title: "Specials Show Import", externalIds: { tvdb: "424242" } });
    expect(res.status).toBe(201);
    expect(res.body.childCount).toBe(5);

    expect((await episodeRows(res.body.id)).map((e) => [e.season_number, e.episode_number, Number(e.monitored)])).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 1],
      [1, 2, 1],
      [2, 1, 1],
    ]);
  });

  it("'Future episodes' on an AniList show monitors only what hasn't aired, not its undated back catalogue", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    const fetchMock = stubFetch([
      {
        test: (u, init) => u.startsWith("https://graphql.anilist.co") && String(init?.body ?? "").includes("airingSchedules"),
        respond: () =>
          json({
            data: {
              // an ongoing show: no announced total, and a schedule reaching back only one episode
              Media: { episodes: null, status: "RELEASING", nextAiringEpisode: { episode: 6, airingAt: now + 5 * day } },
              aired: { pageInfo: { hasNextPage: false }, airingSchedules: [{ episode: 5, airingAt: now - 2 * day }] },
              upcoming: { airingSchedules: [{ episode: 6, airingAt: now + 5 * day }] },
            },
          }),
      },
    ]);

    const res = await importMedia({ type: "anime", title: "Long Runner Future Import", externalIds: { anilist: "515151" }, monitorStrategy: "future" });
    expect(res.status).toBe(201);
    expect(res.body.childCount).toBe(6);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("https://graphql.anilist.co"))).toBe(true);

    const rows = await episodeRows(res.body.id);
    expect(rows.map((e) => e.episode_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.filter((e) => Number(e.monitored) === 1).map((e) => e.episode_number)).toEqual([6]);
  });
});

describe("POST /api/metadata/import — an artist's track listings", () => {
  it("responds once the albums are in, and fills in their tracks afterwards", async () => {
    let releaseTracks!: () => void;
    const tracksGate = new Promise<void>((resolve) => (releaseTracks = resolve));
    stubFetch([
      {
        test: (u) => u.startsWith("https://api.deezer.com/artist/707070/albums"),
        respond: () =>
          json({
            data: [
              { id: 7101, title: "First Album", release_date: "2001-01-01" },
              { id: 7102, title: "Second Album", release_date: "2003-01-01" },
            ],
          }),
      },
      {
        test: (u) => /^https:\/\/api\.deezer\.com\/album\/710[12]\/tracks/.test(u),
        respond: async (u) => {
          // a slow provider: nothing comes back until the test lets it
          await tracksGate;
          const album = u.includes("/7101/") ? "A" : "B";
          return json({
            data: [
              { title: `${album} One`, track_position: 1, disk_number: 1, duration: 200 },
              { title: `${album} Two`, track_position: 2, disk_number: 1, duration: 180 },
            ],
          });
        },
      },
    ]);

    const res = await importMedia({ type: "artist", title: "Slow Tracks Artist", externalIds: { deezer: "707070" } });
    expect(res.status).toBe(201);
    expect(res.body.childCount).toBe(2);

    const trackTitles = async () =>
      (
        (await db
          .prepare(
            `SELECT t.title FROM tracks t JOIN sub_items s ON s.id = t.sub_item_id
             WHERE s.media_item_id = ? ORDER BY s.title, t.track_number`
          )
          .all(res.body.id)) as { title: string }[]
      ).map((t) => t.title);
    expect(await trackTitles()).toEqual([]);

    releaseTracks();
    await vi.waitFor(async () => expect(await trackTitles()).toEqual(["A One", "A Two", "B One", "B Two"]), { timeout: 5000 });
  });
});
