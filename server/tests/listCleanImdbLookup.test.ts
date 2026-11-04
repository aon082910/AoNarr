import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30c: an IMDb list's clean-up could only judge a title stored with an imdb id. A title that carries only a
// tmdb or tvdb id now gets its imdb id from the providers that list external ids, so it is judged too; a title no
// provider answers for stays as it is.

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let cleanListItems: (typeof import("../src/services/importLists.js"))["cleanListItems"];
let fetchImdbIdFor: (typeof import("../src/services/metadata.js"))["fetchImdbIdFor"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
type ImportListRow = import("../src/services/importLists.js").ImportListRow;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ cleanListItems } = await import("../src/services/importLists.js"));
  ({ fetchImdbIdFor } = await import("../src/services/metadata.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  for (const t of ["media_items", "import_list_entries", "import_lists"]) await db.prepare(`DELETE FROM ${t}`).run();
  setSetting("tmdbApiKey", "tmdb-key");
  setSetting("tvdbApiKey", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSetting("tmdbApiKey", "");
  setSetting("tvdbApiKey", "");
});

/** Answers by URL; anything not routed is a 404, as a provider that does not know the id would. */
function stubProviders(routes: Record<string, unknown>) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([needle]) => url.includes(needle));
    return hit
      ? new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function imdbList(extra: Record<string, unknown> = {}): Promise<ImportListRow> {
  const id = Number(
    (await db.prepare("INSERT INTO import_lists (name, type, url, enabled, clean_level) VALUES ('IMDb', 'imdb', 'https://www.imdb.com/list/ls1/', 1, 'keepAndUnmonitor')").run()).lastInsertRowid
  );
  for (const [column, value] of Object.entries(extra)) await db.prepare(`UPDATE import_lists SET ${column} = ? WHERE id = ?`).run(value, id);
  return (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(id)) as ImportListRow;
}

async function addedBy(list: ImportListRow, type: string, title: string, ids: Record<string, string>): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, external_ids, monitored, status, source_list_id) VALUES (?, ?, ?, ?, 1, 'missing', ?)")
        .run(type, title, title.toLowerCase(), JSON.stringify(ids), list.id)
    ).lastInsertRowid
  );
}

const monitoredOf = async (id: number) => Number(((await db.prepare("SELECT monitored FROM media_items WHERE id = ?").get(id)) as any).monitored);
const idsOf = async (id: number) => JSON.parse(((await db.prepare("SELECT external_ids FROM media_items WHERE id = ?").get(id)) as any).external_ids);

describe("fetchImdbIdFor", () => {
  it("asks TMDB for the external ids of a movie and of a show", async () => {
    const fetchMock = stubProviders({ "/movie/603/external_ids": { imdb_id: "tt0133093" }, "/tv/1396/external_ids": { imdb_id: "tt0903747" } });

    expect(await fetchImdbIdFor("movie", { tmdb: "603" })).toBe("tt0133093");
    expect(await fetchImdbIdFor("series", { tmdb: "1396" })).toBe("tt0903747");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to TheTVDB's remote ids for a show TMDB does not answer for", async () => {
    setSetting("tvdbApiKey", "tvdb-key");
    stubProviders({
      "/v4/login": { data: { token: "t" } },
      "/v4/series/81189/extended": { data: { remoteIds: [{ id: "81189", sourceName: "TheTVDB.com" }, { id: "tt0903747", sourceName: "IMDB" }] } },
    });

    expect(await fetchImdbIdFor("series", { tvdb: "81189" })).toBe("tt0903747");
  });

  it("is null when no provider answers, and never throws", async () => {
    stubProviders({});
    expect(await fetchImdbIdFor("movie", { tmdb: "1" })).toBeNull();
    setSetting("tmdbApiKey", "");
    expect(await fetchImdbIdFor("movie", { tmdb: "1" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    setSetting("tmdbApiKey", "tmdb-key");
    expect(await fetchImdbIdFor("movie", { tmdb: "1" })).toBeNull();
  });
});

describe("an IMDb list's clean-up for titles stored without an imdb id", () => {
  it("judges a title with only a tmdb id once its imdb id is found: unmonitors the one that left, keeps the one still on the list", async () => {
    const list = await imdbList();
    const stays = await addedBy(list, "movie", "Stays", { tmdb: "100" });
    const leaves = await addedBy(list, "movie", "Leaves", { tmdb: "200" });
    stubProviders({ "/movie/100/external_ids": { imdb_id: "tt0000100" }, "/movie/200/external_ids": { imdb_id: "tt0000200" } });

    await cleanListItems(list, new Set(["movie:imdb:tt0000100"]));

    expect(await monitoredOf(stays)).toBe(1);
    expect(await monitoredOf(leaves)).toBe(0);
  });

  it("stores the imdb id it found, so the next clean-up needs no lookup", async () => {
    const list = await imdbList();
    const id = await addedBy(list, "movie", "Stored", { tmdb: "300" });
    const fetchMock = stubProviders({ "/movie/300/external_ids": { imdb_id: "tt0000300" } });

    await cleanListItems(list, new Set(["movie:imdb:tt0000300"]));
    expect(await idsOf(id)).toEqual({ tmdb: "300", imdb: "tt0000300" });
    const lookups = fetchMock.mock.calls.length;

    await cleanListItems(list, new Set(["movie:imdb:tt0000300"]));
    expect(fetchMock.mock.calls.length).toBe(lookups);
  });

  it("finds a show's imdb id through TheTVDB when it has no tmdb id", async () => {
    setSetting("tvdbApiKey", "tvdb-key");
    const list = await imdbList();
    const leaves = await addedBy(list, "series", "Tvdb Only", { tvdb: "555" });
    stubProviders({
      "/v4/login": { data: { token: "t" } },
      "/v4/series/555/extended": { data: { remoteIds: [{ id: "tt0000555", sourceName: "IMDB" }] } },
    });

    await cleanListItems(list, new Set(["series:imdb:tt0000001"]));

    expect(await monitoredOf(leaves)).toBe(0);
  });

  it("leaves a title alone when no provider can say what its imdb id is", async () => {
    const list = await imdbList();
    const unknown = await addedBy(list, "movie", "Unknown", { tmdb: "400" });
    stubProviders({});

    expect(await cleanListItems(list, new Set(["movie:imdb:tt0000001"]))).toBe(0);

    expect(await monitoredOf(unknown)).toBe(1);
    expect(await idsOf(unknown)).toEqual({ tmdb: "400" });
  });

  it("keeps an id a refresh added while the lookup was running", async () => {
    const list = await imdbList();
    const id = await addedBy(list, "movie", "Racing", { tmdb: "600" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // A metadata refresh stores a tvdb id between the clean-up's read and its write.
        await db.prepare("UPDATE media_items SET external_ids = ? WHERE id = ?").run(JSON.stringify({ tmdb: "600", tvdb: "9000" }), id);
        return new Response(JSON.stringify({ imdb_id: "tt0000600" }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    await cleanListItems(list, new Set(["movie:imdb:tt0000600"]));

    expect(await idsOf(id)).toEqual({ tmdb: "600", tvdb: "9000", imdb: "tt0000600" });
  });

  it("does not overwrite an imdb id that appeared meanwhile", async () => {
    const list = await imdbList();
    const id = await addedBy(list, "movie", "Raced", { tmdb: "700" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await db.prepare("UPDATE media_items SET external_ids = ? WHERE id = ?").run(JSON.stringify({ tmdb: "700", imdb: "tt0000777" }), id);
        return new Response(JSON.stringify({ imdb_id: "tt0000700" }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    await cleanListItems(list, new Set(["movie:imdb:tt0000777"]));

    expect(await idsOf(id)).toEqual({ tmdb: "700", imdb: "tt0000777" });
  });

  it("gives the provider lookups a timeout", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    setSetting("tvdbApiKey", "tvdb-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.signal);
        const url = String(input);
        if (url.includes("/v4/login")) return new Response(JSON.stringify({ data: { token: "t" } }), { status: 200 });
        if (url.includes("/v4/series/")) return new Response(JSON.stringify({ data: { remoteIds: [{ id: "tt0000800", sourceName: "IMDB" }] } }), { status: 200 });
        return new Response("{}", { status: 404 });
      })
    );

    expect(await fetchImdbIdFor("movie", { tmdb: "800" })).toBeNull();
    expect(await fetchImdbIdFor("series", { tvdb: "800" })).toBe("tt0000800");

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const signal of seen) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("does no lookups for a list whose sync produced no imdb ids", async () => {
    const list = await imdbList({ type: "tmdb" });
    await addedBy(list, "movie", "Tmdb List Title", { tmdb: "500" });
    const fetchMock = stubProviders({});

    await cleanListItems(list, new Set(["movie:tmdb:501"]));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
