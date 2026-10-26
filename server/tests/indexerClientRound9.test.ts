import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { Indexer } from "../src/types/index.js";

let searchIndexer: (typeof import("../src/services/indexerClient.js"))["searchIndexer"];
let searchAllIndexers: (typeof import("../src/services/indexerClient.js"))["searchAllIndexers"];
let clearFailureBackoff: (typeof import("../src/services/indexerClient.js"))["clearFailureBackoff"];
let isIndexerBackedOff: (typeof import("../src/services/indexerClient.js"))["isIndexerBackedOff"];
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ searchIndexer, searchAllIndexers, clearFailureBackoff, isIndexerBackedOff } = await import("../src/services/indexerClient.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.AONARR_INDEXER_REQUEST_SPACING_MS = "0";
});

let nextId = 300_000;
function makeIndexer(overrides: Partial<Indexer> = {}): Indexer {
  return {
    id: nextId++,
    name: "Test Indexer",
    protocol: "torznab",
    url: "https://idx.example.com",
    apiKey: "test-api-key",
    categories: "",
    mediaTypes: "movie,series,anime,artist,author,comic,manga,rom",
    enabled: 1,
    priority: 25,
    config: null,
    useFlareSolverr: 0,
    queryLimitPerHour: null,
    ...overrides,
  };
}

const feed = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
<channel><title>Test</title>${items}</channel></rss>`;
const item = (title: string, url: string, extra = "") =>
  `<item><title>${title}</title><link>${url}</link><enclosure url="${url}" length="100" type="application/x-bittorrent"/>${extra}</item>`;
const empty = feed("");
const caps = (searching: string, limits = "") => `<?xml version="1.0" encoding="UTF-8"?><caps>${limits}<searching>${searching}</searching></caps>`;
const TV_CAPS = caps(`<tv-search available="yes" supportedParams="q,season,ep,tvdbid,imdbid"/><movie-search available="yes" supportedParams="q,imdbid,tmdbid"/>`);

type Call = { t: string | null; params: URLSearchParams };
/** A fetch that answers by the kind of request and records what was asked. */
function server(answer: (call: Call) => string | { status: number; headers?: Record<string, string> } | undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    const params = new URL(url).searchParams;
    const call = { t: params.get("t"), params };
    calls.push(call);
    const out = answer(call) ?? empty;
    if (typeof out === "object") return { ok: false, status: out.status, headers: new Headers(out.headers ?? {}), text: async () => "" };
    return { ok: true, status: 200, text: async () => out };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, searches: () => calls.filter((c) => c.t !== "caps") };
}

describe("extended=1", () => {
  it("is on every typed and text search, so a usenet indexer answers with its ids and dates", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "search" ? feed(item("Show.S01E01.720p-GRP", "https://idx.example.com/dl/1")) : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Show S01E01", "series", { tvdb: "81189" }, { season: 1, episode: 1 });
    expect(s.searches().map((c) => [c.t, c.params.get("extended")])).toEqual([
      ["tvsearch", "1"],
      ["search", "1"],
    ]);
  });
});

describe("paging", () => {
  const page = (n: number, prefix: string) => feed(Array.from({ length: n }, (_, i) => item(`${prefix}.${i}.1080p-GRP`, `https://idx.example.com/dl/${prefix}${i}`)).join(""));

  it("reads the next page of a search while a page comes back full, and stops at a short one", async () => {
    const s = server((c) => {
      if (c.t === "caps") return caps(`<movie-search available="yes" supportedParams="q,imdbid"/>`, `<limits max="10" default="2"/>`);
      if (c.t === "movie") return c.params.get("offset") === "2" ? page(1, "b") : page(2, "a");
      return empty;
    });
    const results = await searchIndexer(makeIndexer({ mediaTypes: "movie" }), "Movie 2020", "movie", { imdb: "tt0133093" });

    expect(results).toHaveLength(3);
    const movieCalls = s.searches().filter((c) => c.t === "movie");
    expect(movieCalls.map((c) => [c.params.get("offset"), c.params.get("limit")])).toEqual([
      [null, null],
      ["2", "2"],
    ]);
  });

  it("reads at most three pages, and a page counts against the hourly limit", async () => {
    const full = server((c) => page(100, `x${c.params.get("offset") ?? 0}`));
    const results = await searchIndexer(makeIndexer({ mediaTypes: "movie" }), "Movie 2020", "movie");
    expect(results).toHaveLength(300);
    expect(full.searches().map((c) => c.params.get("offset"))).toEqual([null, "100", "200"]);

    const limited = server((c) => page(100, `y${c.params.get("offset") ?? 0}`));
    await searchIndexer(makeIndexer({ mediaTypes: "movie", queryLimitPerHour: 2 }), "Movie 2020", "movie");
    // The search itself and one page: the limit leaves no room for a third.
    expect(limited.searches()).toHaveLength(2);
  });

  it("stops at a page that repeats the first, as an indexer that ignores offset sends", async () => {
    const s = server(() => page(100, "same"));
    const results = await searchIndexer(makeIndexer({ mediaTypes: "movie" }), "Movie 2020", "movie");
    expect(results).toHaveLength(100);
    expect(s.searches()).toHaveLength(2);
  });

  it("backs the indexer off when a later page is answered with a request limit", async () => {
    let n = 0;
    server(() => (n++ === 0 ? page(100, "r") : `<?xml version="1.0" encoding="UTF-8"?><error code="500" description="Request limit reached"/>`));
    const indexer = makeIndexer({ mediaTypes: "movie" });
    expect(await searchIndexer(indexer, "Movie 2020", "movie")).toHaveLength(100);
    await expect(searchIndexer(indexer, "Other 2020", "movie")).rejects.toThrow("backed off");
  });

  it("keeps the pages it read when a later one fails", async () => {
    let n = 0;
    server(() => (n++ === 0 ? page(100, "k") : { status: 500 }));
    const results = await searchIndexer(makeIndexer({ mediaTypes: "movie" }), "Movie 2020", "movie");
    expect(results).toHaveLength(100);
  });
});

describe("what a feed item says", () => {
  const attr = (name: string, value: string, ns = "torznab") => `<${ns}:attr name="${name}" value="${value}"/>`;

  it("reads the size attribute before the enclosure's length, and ids as positive numbers", async () => {
    server(() =>
      feed(
        item(
          "Show.S01E01.1080p.WEB-GRP",
          "https://idx.example.com/dl/1",
          attr("size", "4294967296") + attr("tvdbid", "81189") + attr("imdb", "133093") + attr("tmdbid", "603") + attr("Seeders", "77") + attr("peers", "80")
        ) +
          item("Zero.Ids.1080p-GRP", "https://idx.example.com/dl/2", attr("imdb", "0") + attr("tvdbid", "0") + attr("tmdbid", "0")) +
          item("Prefixed.1080p-GRP", "https://idx.example.com/dl/3", attr("imdbid", "tt0944947"))
      )
    );
    const [a, b, c] = await searchIndexer(makeIndexer(), "Show", "series");

    expect(a).toMatchObject({ size: 4294967296, tvdbId: "81189", imdbId: "tt0133093", tmdbId: "603", seeders: 77, leechers: 3 });
    expect(b).toMatchObject({ imdbId: null, tvdbId: null, tmdbId: null, size: 100 });
    expect(c.imdbId).toBe("tt0944947");
  });

  it("reads an imdb id from either attribute and the size from a human-readable one", async () => {
    server(() =>
      feed(
        item("Both.Attrs.1080p-GRP", "https://idx.example.com/dl/b", attr("imdb", "0") + attr("imdbid", "tt0133093") + attr("size", "1.5 GB")) +
          item("Only.Zero.1080p-GRP", "https://idx.example.com/dl/z", attr("imdb", "0"))
      )
    );
    const [a, b] = await searchIndexer(makeIndexer(), "q", "movie");
    expect(a).toMatchObject({ imdbId: "tt0133093", size: Math.round(1.5 * 1024 ** 3) });
    expect(b.imdbId).toBeNull();
  });

  it("takes the text of a link element that carries attributes", async () => {
    server(() => feed('<item><title>Link.Only.1080p-GRP</title><link rel="enclosure">https://idx.example.com/dl/l</link></item>'));
    const [r] = await searchIndexer(makeIndexer(), "q", "movie");
    expect(r.downloadUrl).toBe("https://idx.example.com/dl/l");
  });

  it("drops a release with no download URL, and falls back to the magnet link", async () => {
    server(() =>
      feed(
        `<item><title>No.Url.1080p-GRP</title></item>` +
          `<item><title>Magnet.Only.1080p-GRP</title>${attr("magneturl", "magnet:?xt=urn:btih:ABC")}${attr("infohash", "ABCDEF0123")}</item>`
      )
    );
    const results = await searchIndexer(makeIndexer(), "q", "movie");

    expect(results.map((r) => r.title)).toEqual(["Magnet.Only.1080p-GRP"]);
    expect(results[0]).toMatchObject({ downloadUrl: "magnet:?xt=urn:btih:ABC", magnetUrl: "magnet:?xt=urn:btih:ABC", infoHash: "abcdef0123" });
  });

  it("reads the volume factors and tags a tracker flags a release with", async () => {
    server(() => feed(item("Flagged.1080p-GRP", "https://idx.example.com/dl/f", attr("downloadvolumefactor", "0") + attr("uploadvolumefactor", "2") + attr("tag", "Internal") + attr("tag", "freeleech"))));
    const [r] = await searchIndexer(makeIndexer(), "q", "movie");
    expect(r).toMatchObject({ downloadVolumeFactor: 0, uploadVolumeFactor: 2, indexerTags: ["internal", "freeleech"] });
  });

  it("takes a usenet post's own date over the feed's", async () => {
    server(() =>
      feed(
        `<item><title>Post.1080p-GRP</title><link>https://nzb.example.com/1</link><pubDate>Tue, 01 Jan 2030 00:00:00 +0000</pubDate>${attr("usenetdate", "Mon, 01 Jan 2024 00:00:00 +0000", "newznab")}</item>`
      )
    );
    const [r] = await searchIndexer(makeIndexer({ protocol: "newznab" }), "q", "movie");
    expect(r.publishDate).toBe("Mon, 01 Jan 2024 00:00:00 +0000");
  });
});

describe("plain RSS feeds", () => {
  const rss = (titles: string[]) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${titles
      .map((t, i) => `<item><title>${t}</title><link>https://feed.example.com/${i}</link></item>`)
      .join("")}</channel></rss>`;
  const rssIndexer = () => makeIndexer({ protocol: "rss", url: "https://feed.example.com/rss" });

  it("matches a release by its parsed title and numbers, not by the query text inside its name", async () => {
    server(() =>
      rss([
        "Dune.2021.1080p.WEB-DL-GRP",
        "Dune.Part.Two.2024.1080p.WEB-DL-GRP",
        "The.Office.US.S04E02.720p.HDTV-GRP",
        "The.Office.US.S04E03.720p.HDTV-GRP",
        "Late.Night.2024.08.25.1080p.WEB-GRP",
        "Late.Night.2024.08.24.1080p.WEB-GRP",
      ])
    );
    const indexer = rssIndexer();

    expect((await searchIndexer(indexer, "Dune 2021", "movie")).map((r) => r.title)).toEqual(["Dune.2021.1080p.WEB-DL-GRP"]);
    expect((await searchIndexer(indexer, "Office US S04E02", "series")).map((r) => r.title)).toEqual(["The.Office.US.S04E02.720p.HDTV-GRP"]);
    expect((await searchIndexer(indexer, "Late Night 2024 08 25", "series")).map((r) => r.title)).toEqual(["Late.Night.2024.08.25.1080p.WEB-GRP"]);
  });

  it("downloads the feed once for many searches, and again for a manual one", async () => {
    const s = server(() => rss(["Dune.2021.1080p.WEB-DL-GRP"]));
    const indexer = rssIndexer();

    await searchIndexer(indexer, "Dune 2021", "movie");
    await searchIndexer(indexer, "Dune", "movie");
    await searchIndexer(indexer, "Other 2020", "movie");
    expect(s.calls).toHaveLength(1);

    await searchIndexer(indexer, "Dune 2021", "movie", undefined, { fresh: true });
    expect(s.calls).toHaveLength(2);
  });
});

describe("typed searches by kind of episode", () => {
  const found = feed(item("Hit.1080p-GRP", "https://idx.example.com/dl/hit"));

  it("asks for a daily show's episode by season=YYYY and ep=MM/DD", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" ? found : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Late Night 2024 08 25", "series", { tvdb: "71256" }, { airDate: "2024-08-25" });
    const [call] = s.searches();
    expect([call.t, call.params.get("tvdbid"), call.params.get("season"), call.params.get("ep"), call.params.has("q")]).toEqual(["tvsearch", "71256", "2024", "08/25", false]);
  });

  it("asks for an anime episode by tvdb id and its absolute number, and by the season form without q", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" ? found : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "anime" }), "Anime 5", "anime", { tvdb: "81189" }, { season: 1, episode: 5, absolute: 5 });
    expect([s.searches()[0].params.get("tvdbid"), s.searches()[0].params.get("q"), s.searches()[0].params.has("season")]).toEqual(["81189", "05", false]);

    const noQ = server((c) => (c.t === "caps" ? caps(`<tv-search available="yes" supportedParams="season,ep,tvdbid"/>`) : c.t === "tvsearch" ? found : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "anime" }), "Anime 5", "anime", { tvdb: "81189" }, { season: 1, episode: 5, absolute: 5 });
    expect([noQ.searches()[0].params.get("season"), noQ.searches()[0].params.get("ep")]).toEqual(["1", "5"]);
  });

  it("sends a special's season as 00", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" ? found : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Show S00E03", "series", { tvdb: "73244" }, { season: 0, episode: 3 });
    expect([s.searches()[0].params.get("season"), s.searches()[0].params.get("ep")]).toEqual(["00", "3"]);
  });

  it("asks by imdb or tmdb id when the show has no tvdb id and the indexer takes it", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" ? found : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Show S01E01", "series", { imdb: "tt0944947", tmdb: "1399" }, { season: 1, episode: 1 });
    expect([s.searches()[0].t, s.searches()[0].params.get("imdbid"), s.searches()[0].params.has("tvdbid")]).toEqual(["tvsearch", "0944947", false]);
  });

  it("asks tv-search by title and numbers where the id search found nothing, and takes its empty answer as the answer", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" && c.params.has("q") ? found : empty));
    const results = await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Office US S04E02", "series", { tvdb: "73244" }, { season: 4, episode: 2, queryTitle: "Office US" });

    expect(results).toHaveLength(1);
    expect(s.searches().map((c) => [c.t, c.params.get("q"), c.params.get("season"), c.params.get("ep"), c.params.has("tvdbid")])).toEqual([
      ["tvsearch", null, "4", "2", true],
      ["tvsearch", "Office US", "4", "2", false],
    ]);

    // Nothing under the title either: that is the answer, not a reason for a plain text search.
    const none = server((c) => (c.t === "caps" ? TV_CAPS : empty));
    await expect(
      searchIndexer(makeIndexer({ mediaTypes: "series" }), "Office US S04E02", "series", { tvdb: "73244" }, { season: 4, episode: 2, queryTitle: "Office US" })
    ).resolves.toEqual([]);
    expect(none.searches().map((c) => c.t)).toEqual(["tvsearch", "tvsearch"]);
  });

  it("remembers a refused form of a typed search, not the others", async () => {
    const refused = `<?xml version="1.0" encoding="UTF-8"?><error code="201" description="Incorrect parameter"/>`;
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" && c.params.get("ep")?.includes("/") ? refused : c.t === "tvsearch" ? found : empty));
    const indexer = makeIndexer({ mediaTypes: "series" });

    // The date form is refused (the indexer has no daily search) ...
    await searchIndexer(indexer, "Late Night 2024 08 25", "series", { tvdb: "71256" }, { airDate: "2024-08-25" });
    await searchIndexer(indexer, "Late Night 2024 08 26", "series", { tvdb: "71256" }, { airDate: "2024-08-26" });
    // ... and that does not stop the ordinary episode search by the same id.
    const results = await searchIndexer(indexer, "Show S01E05", "series", { tvdb: "71256" }, { season: 1, episode: 5 });

    expect(results).toHaveLength(1);
    expect(s.searches().map((c) => [c.t, c.params.get("ep")])).toEqual([
      ["tvsearch", "08/25"],
      ["search", null],
      ["search", null],
      ["tvsearch", "5"],
    ]);
  });

  it("asks a refused form again after a few hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const refused = `<?xml version="1.0" encoding="UTF-8"?><error code="203" description="Function not available"/>`;
      const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" ? refused : empty));
      const indexer = makeIndexer({ mediaTypes: "series" });
      const ask = () => searchIndexer(indexer, "Show S01E05", "series", { tvdb: "7" }, { season: 1, episode: 5 });

      await ask();
      await ask();
      expect(s.searches().filter((c) => c.t === "tvsearch")).toHaveLength(1);
      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await ask();
      expect(s.searches().filter((c) => c.t === "tvsearch")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking once the hourly limit has no request left", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : empty));
    const indexer = makeIndexer({ mediaTypes: "series", queryLimitPerHour: 1 });
    const results = await searchIndexer(indexer, "Office US S04E02", "series", { tvdb: "73244" }, { season: 4, episode: 2, queryTitle: "Office US" });
    expect(results).toEqual([]);
    expect(s.searches()).toHaveLength(1); // the id search; the title search and the text search would have been two more
  });

  it("keeps a refused special apart from the ordinary episodes", async () => {
    const refused = `<?xml version="1.0" encoding="UTF-8"?><error code="201" description="Incorrect parameter"/>`;
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" && c.params.get("season") === "00" ? refused : c.t === "tvsearch" ? found : empty));
    const indexer = makeIndexer({ mediaTypes: "series" });

    await searchIndexer(indexer, "Show S00E03", "series", { tvdb: "7" }, { season: 0, episode: 3 });
    const results = await searchIndexer(indexer, "Show S01E05", "series", { tvdb: "7" }, { season: 1, episode: 5 });

    expect(results).toHaveLength(1);
    expect(s.searches().map((c) => [c.t, c.params.get("season")])).toEqual([
      ["tvsearch", "00"],
      ["search", null],
      ["tvsearch", "1"],
    ]);
  });

  it("asks the capabilities and the refused forms again once the admin has corrected the indexer", async () => {
    let capsAnswer: string | { status: number } = { status: 401 };
    const s = server((c) => (c.t === "caps" ? capsAnswer : c.t === "tvsearch" ? found : empty));
    const indexer = makeIndexer({ mediaTypes: "series" });

    // The key was wrong: no capabilities, a text search only.
    await searchIndexer(indexer, "Show S01E05", "series", { tvdb: "7" }, { season: 1, episode: 5 });
    expect(s.searches().map((c) => c.t)).toEqual(["search"]);

    capsAnswer = TV_CAPS;
    clearFailureBackoff(indexer.id);
    await searchIndexer(indexer, "Show S01E06", "series", { tvdb: "7" }, { season: 1, episode: 6 });
    expect(s.searches().map((c) => c.t)).toEqual(["search", "tvsearch"]);
  });

  it("falls back to the plain search for an indexer that refuses the title search, and remembers it", async () => {
    const refused = `<?xml version="1.0" encoding="UTF-8"?><error code="203" description="Function not available"/>`;
    const s = server((c) => (c.t === "caps" ? TV_CAPS : c.t === "tvsearch" && c.params.has("q") ? refused : c.t === "search" ? found : empty));
    const indexer = makeIndexer({ mediaTypes: "series" });
    const hints = { season: 4, episode: 2, queryTitle: "Office US" };

    await searchIndexer(indexer, "Office US S04E02", "series", undefined, hints);
    await searchIndexer(indexer, "Office US S04E03", "series", undefined, { ...hints, episode: 3 });

    expect(s.searches().map((c) => c.t)).toEqual(["tvsearch", "search", "search"]);
  });

  it("makes the plain search where the indexer's tv-search has no q, and asks for no ids on it", async () => {
    const s = server((c) => (c.t === "caps" ? caps(`<tv-search available="yes" supportedParams="season,ep"/>`) : c.t === "search" ? found : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Office US S04E02", "series", { tvdb: "73244", imdb: "tt0386676" }, { season: 4, episode: 2, queryTitle: "Office US" });
    expect(s.searches().map((c) => [c.t, c.params.get("q"), c.params.has("imdbid"), c.params.has("tvdbid")])).toEqual([["search", "Office US S04E02", false, false]]);
  });
});

describe("ids on a text search", () => {
  it("are never sent for a show, even when the indexer's capabilities can't be read", async () => {
    const s = server((c) => (c.t === "caps" ? { status: 500 } : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "series" }), "Show S01E01", "series", { tvdb: "1", imdb: "tt0944947", tmdb: "1399" }, { season: 1, episode: 1 });
    const text = s.searches().filter((c) => c.t === "search");
    expect(text).toHaveLength(1);
    expect(text[0].params.has("imdbid") || text[0].params.has("tmdbid")).toBe(false);
  });

  it("are not sent for a film after the id search was made and found nothing", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : empty));
    await searchIndexer(makeIndexer({ mediaTypes: "movie" }), "Dune 2021", "movie", { imdb: "tt1160419", tmdb: "438631" });
    expect(s.searches().map((c) => [c.t, c.params.has("imdbid")])).toEqual([
      ["movie", true],
      ["search", false],
    ]);
  });

  it("are not sent with an alternate title or a scene-name form", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : empty));
    await searchAllIndexers([makeIndexer({ mediaTypes: "movie" })], "Dune 2021", "movie", true, { imdb: "tt1160419" }, { alternateQueries: ["Dune Part One 2021"] });
    const text = s.searches().filter((c) => c.t === "search");
    expect(text.length).toBeGreaterThan(1);
    expect(text.slice(1).every((c) => !c.params.has("imdbid"))).toBe(true);
  });
});

describe("other titles and scene-name forms, indexer by indexer", () => {
  const hit = feed(item("Found.1080p-GRP", "https://idx.example.com/dl/found"));

  it("go only to the indexers the main query found nothing at", async () => {
    const hasResults = makeIndexer({ name: "Has", url: "https://has.example.com", mediaTypes: "movie" });
    const hasNone = makeIndexer({ name: "None", url: "https://none.example.com", mediaTypes: "movie" });
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const u = new URL(url);
        queries.push(`${u.hostname}:${u.searchParams.get("q")}`);
        const answer = u.hostname.startsWith("has") && u.searchParams.get("q") === "Main 2020" ? hit : empty;
        return { ok: true, status: 200, text: async () => answer };
      })
    );

    await searchAllIndexers([hasResults, hasNone], "Main 2020", "movie", true, undefined, { alternateQueries: ["Other Title 2020"] });

    expect(queries.filter((q) => q.startsWith("has.")).sort()).toEqual(["has.example.com:Main 2020"]);
    expect(queries.filter((q) => q.startsWith("none.")).sort()).toEqual(["none.example.com:Main 2020", "none.example.com:Main.2020", "none.example.com:Other Title 2020"]);
  });

  it("stop for an indexer once one form finds releases", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const q = new URL(url).searchParams.get("q");
        queries.push(q ?? "");
        return { ok: true, status: 200, text: async () => (q === "Mr and Mrs Smith 2005" ? hit : empty) };
      })
    );

    const results = await searchAllIndexers([makeIndexer({ mediaTypes: "movie" })], "Mr & Mrs Smith 2005", "movie", true);

    expect(results).toHaveLength(1);
    // "&" is written "and" before the dotted form is needed.
    expect(queries).toEqual(["Mr & Mrs Smith 2005", "Mr and Mrs Smith 2005"]);
  });

  it("asks the other form of a search of every indexer, not only of one that found nothing", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        queries.push(q);
        // The main query is answered with an unrelated release, the other form with the episode.
        const answer = q === "Anime 05" ? feed(item("Some.Other.Show.05.720p-GRP", "https://idx.example.com/dl/other")) : q === "Anime S01E05" ? hit : empty;
        return { ok: true, status: 200, text: async () => answer };
      })
    );

    const results = await searchAllIndexers([makeIndexer({ mediaTypes: "anime" })], "Anime 05", "anime", true, undefined, {
      alsoQueries: ["Anime S01E05", "Anime Third Form"],
      alternateQueries: ["Other Title 05"],
    });

    expect(queries).toEqual(["Anime 05", "Anime S01E05"]); // one other form at most; nothing was empty, so no other titles
    expect(results.map((r) => r.title).sort()).toEqual(["Found.1080p-GRP", "Some.Other.Show.05.720p-GRP"]);
  });

  it("are not asked of a plain RSS feed, which ignores the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<rss version="2.0"><channel></channel></rss>' });
    vi.stubGlobal("fetch", fetchMock);
    await searchAllIndexers([makeIndexer({ protocol: "rss", url: "https://feed.example.com/rss", mediaTypes: "movie" })], "Mr & Mrs Smith 2005", "movie", true, undefined, {
      alternateQueries: ["Other"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("categories", () => {
  it("uses an indexer's own list for the types it covers and the type's own for the rest", async () => {
    const s = server(() => empty);
    const indexer = makeIndexer({ categories: "5000,5040,100001" });
    await searchIndexer(indexer, "Show", "series");
    await searchIndexer(indexer, "Book", "author");
    await searchIndexer(indexer, "Anime", "anime");
    expect(s.searches().map((c) => c.params.get("cat"))).toEqual(["5000,5040,100001", "7000", "5000,5040,100001"]);

    // Custom ids alone are the admin's list for every type.
    const custom = server(() => empty);
    await searchIndexer(makeIndexer({ categories: "100001,100002" }), "Book", "author");
    expect(custom.searches()[0].params.get("cat")).toBe("100001,100002");

    const tvOnly = server(() => empty);
    await searchIndexer(makeIndexer({ categories: "2000,2040" }), "Show", "series");
    expect(tvOnly.searches()[0].params.get("cat")).toBe("5000");
  });

  it("searches manga in the comics category", async () => {
    const s = server(() => empty);
    await searchIndexer(makeIndexer(), "One Piece 1085", "manga");
    expect(s.searches()[0].params.get("cat")).toBe("7030,7000");
  });
});

describe("an indexer that answers with a server error", () => {
  it("ends the search at the first one, instead of asking the other tiers of the same failing indexer", async () => {
    const s = server((c) => (c.t === "caps" ? TV_CAPS : { status: 500 }));
    const indexer = makeIndexer({ mediaTypes: "series" });

    await expect(
      searchIndexer(indexer, "Office US S04E02", "series", { tvdb: "73244" }, { season: 4, episode: 2, queryTitle: "Office US" })
    ).rejects.toThrow("HTTP 500");

    expect(s.searches().map((c) => c.t)).toEqual(["tvsearch"]);
    expect(isIndexerBackedOff(indexer.id)).toBe(true);
  });

  it("is recorded as one failure in its health history, not once for every search queued behind it", async () => {
    process.env.AONARR_INDEXER_REQUEST_SPACING_MS = "0";
    const id = Number((await db.prepare("INSERT INTO indexers (name, protocol, url) VALUES ('Down', 'torznab', 'https://down.example.com')").run()).lastInsertRowid);
    server(() => ({ status: 500 }));
    const indexer = makeIndexer({ id, url: "https://down.example.com", mediaTypes: "movie" });

    const outcomes = await Promise.allSettled([searchIndexer(indexer, "a", "movie"), searchIndexer(indexer, "b", "movie"), searchIndexer(indexer, "c", "movie")]);

    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    const rows = (await db.prepare("SELECT success, error FROM indexer_health WHERE indexer_id = ?").all(id)) as { success: number; error: string }[];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].success)).toBe(0);
    expect(rows[0].error).toContain("HTTP 500");
  });
});

describe("requests to one indexer, when the indexer fails meanwhile", () => {
  it("does not make the requests queued behind a failed one", async () => {
    process.env.AONARR_INDEXER_REQUEST_SPACING_MS = "0";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: false, status: 500, text: async () => "" };
      })
    );
    const indexer = makeIndexer({ mediaTypes: "movie" });

    const outcomes = await Promise.allSettled([searchIndexer(indexer, "a", "movie"), searchIndexer(indexer, "b", "movie"), searchIndexer(indexer, "c", "movie")]);

    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(calls).toBe(1); // the first failed; the other two never left the queue
  });

  it("lets a search the admin is waiting for through without the pause", async () => {
    process.env.AONARR_INDEXER_REQUEST_SPACING_MS = "300";
    const started: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        started.push(Date.now());
        return { ok: true, status: 200, text: async () => empty };
      })
    );
    const indexer = makeIndexer({ mediaTypes: "movie" });

    await searchIndexer(indexer, "a", "movie", undefined, { fresh: true });
    await searchIndexer(indexer, "b", "movie", undefined, { fresh: true });

    expect(started[1] - started[0]).toBeLessThan(150);
  });
});

describe("requests to one indexer", () => {
  it("go one at a time with a pause between them, while different indexers go together", async () => {
    process.env.AONARR_INDEXER_REQUEST_SPACING_MS = "60";
    const started: { host: string; at: number; inFlight: number }[] = [];
    const inFlight = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const host = new URL(url).hostname;
        const now = (inFlight.get(host) ?? 0) + 1;
        inFlight.set(host, now);
        started.push({ host, at: Date.now(), inFlight: now });
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight.set(host, now - 1);
        return { ok: true, status: 200, text: async () => empty };
      })
    );
    const a = makeIndexer({ url: "https://a.example.com", mediaTypes: "movie" });
    const b = makeIndexer({ url: "https://b.example.com", mediaTypes: "movie" });

    await Promise.all([searchIndexer(a, "One", "movie"), searchIndexer(a, "Two", "movie"), searchIndexer(a, "Three", "movie"), searchIndexer(b, "One", "movie")]);

    const forA = started.filter((s) => s.host === "a.example.com");
    expect(forA).toHaveLength(3);
    expect(Math.max(...started.map((s) => s.inFlight))).toBe(1);
    expect(forA[1].at - forA[0].at).toBeGreaterThanOrEqual(75); // 20 ms request + 60 ms pause, less timer slack
    expect(forA[2].at - forA[1].at).toBeGreaterThanOrEqual(75);
    // The other indexer was not held up behind them.
    expect(started.find((s) => s.host === "b.example.com")!.at - started[0].at).toBeLessThan(50);
  });
});
