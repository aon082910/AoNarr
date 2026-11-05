import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

/** fetchByExternalId for an artist's MusicBrainz id and an author's Open Library id (the Starr layer's /artist/lookup and /author/lookup). */
let metadata: typeof import("../src/services/metadata.js");

beforeAll(async () => {
  await setupTestDb();
  metadata = await import("../src/services/metadata.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MBID = "83d91898-7763-47d7-b03b-b92132375c47";

type Route = { test: (url: string) => boolean; response: any };
function routedFetch(routes: Route[]) {
  return vi.fn(async (url: string) => {
    const route = routes.find((r) => r.test(url));
    if (!route) throw new Error(`unmocked fetch call in test: ${url}`);
    return route.response;
  });
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) });

describe("fetchByExternalId: musicbrainz", () => {
  it("reads an artist by its id, with the artwork Deezer has for that name", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.startsWith(`https://musicbrainz.org/ws/2/artist/${MBID}`), response: ok({ id: MBID, name: "Massive Attack", disambiguation: "UK trip-hop group", "life-span": { begin: "1988", ended: false } }) },
      { test: (u) => u.includes("api.deezer.com/search/artist"), response: ok({ data: [{ id: 1, name: "Massive Attack", picture_medium: "https://cdn.example/ma.jpg" }, { id: 2, name: "Other", picture_medium: "https://cdn.example/o.jpg" }] }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const found = await metadata.fetchByExternalId("artist", "musicbrainz", MBID.toUpperCase());
    expect(found).toMatchObject({ title: "Massive Attack", year: 1988, overview: "UK trip-hop group", externalIds: { musicbrainz: MBID }, status: "Active" });
    expect(found.posterUrl).toBe("https://cdn.example/ma.jpg");
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/artist/${MBID}?fmt=json`);
  });

  it("is an artist that ended when MusicBrainz says so, and still found when Deezer is down", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("musicbrainz.org"), response: ok({ id: MBID, name: "Gone Band", "life-span": { begin: "1970-01-01", end: "1980-01-01", ended: true } }) },
        { test: (u) => u.includes("deezer"), response: status(503) },
      ])
    );
    expect(await metadata.fetchByExternalId("artist", "musicbrainz", MBID)).toMatchObject({ title: "Gone Band", year: 1970, status: "Ended", posterUrl: null });
  });

  it("refuses a title of another type, an id that is not one, and answers what MusicBrainz says about an unknown id", async () => {
    await expect(metadata.fetchByExternalId("author", "musicbrainz", MBID)).rejects.toThrow('MusicBrainz id lookup isn\'t available for "author"');
    await expect(metadata.fetchByExternalId("artist", "musicbrainz", "../../etc")).rejects.toThrow("is not a MusicBrainz id");
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("musicbrainz.org"), response: status(404) }]));
    await expect(metadata.fetchByExternalId("artist", "musicbrainz", MBID)).rejects.toThrow(`No MusicBrainz artist found for id "${MBID}"`);
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("musicbrainz.org"), response: status(503) }]));
    await expect(metadata.fetchByExternalId("artist", "musicbrainz", MBID)).rejects.toThrow("MusicBrainz lookup failed: HTTP 503");
  });
});

describe("fetchByExternalId: musicbrainz, when Deezer does not answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks Deezer with a timeout, as it asks MusicBrainz", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("musicbrainz.org"), response: ok({ id: MBID, name: "Massive Attack" }) },
      { test: (u) => u.includes("api.deezer.com/search/artist"), response: ok({ data: [] }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await metadata.fetchByExternalId("artist", "musicbrainz", MBID);
    const deezer = fetchMock.mock.calls.find((c) => String(c[0]).includes("api.deezer.com")) as unknown as [string, RequestInit | undefined];
    expect(deezer[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up on the poster after three seconds and answers the artist without one", async () => {
    // The add of an artist waits for this call inside the one queue all four Starr apps share: a stalled Deezer must not hold it.
    const fetchMock = vi.fn((url: string) => (url.includes("musicbrainz.org") ? Promise.resolve(ok({ id: MBID, name: "Massive Attack" })) : new Promise<never>(() => undefined)));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    let answer: any;
    const pending = metadata.fetchByExternalId("artist", "musicbrainz", MBID).then((a) => (answer = a));
    await vi.advanceTimersByTimeAsync(2900);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(answer).toMatchObject({ title: "Massive Attack", posterUrl: null, externalIds: { musicbrainz: MBID } });
  });
});

describe("fetchByExternalId: isbn", () => {
  const ISBN = "9780441013593";
  const bookRecord = (authors: unknown) => ({ [`ISBN:${ISBN}`]: { title: "Dune", publish_date: "August 1990", authors, cover: { medium: "https://covers.example/dune.jpg" } } });

  it("carries the Open Library id of the author the book lists", async () => {
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes(`bibkeys=ISBN:${ISBN}`), response: ok(bookRecord([{ url: "https://openlibrary.org/authors/OL79034A/Frank_Herbert", name: "Frank Herbert" }])) }]));
    expect(await metadata.fetchByExternalId("author", "isbn", "978-0-441-01359-3")).toMatchObject({ title: "Frank Herbert", year: 1990, externalIds: { openlibrary: "OL79034A" } });
  });

  it("reads the author id from a key too, and takes the first author", async () => {
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("openlibrary.org/api/books"), response: ok(bookRecord([{ key: "/authors/OL12345a", name: "First" }, { key: "/authors/OL2A", name: "Second" }])) }]));
    expect((await metadata.fetchByExternalId("author", "isbn", ISBN)).externalIds).toEqual({ openlibrary: "OL12345A" });
  });

  it("answers the book itself, with no author id, when the record lists no author or an id of another shape", async () => {
    for (const authors of [undefined, [], [{ name: "Someone", url: "https://openlibrary.org/people/someone" }]]) {
      vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("openlibrary.org/api/books"), response: ok(bookRecord(authors)) }]));
      const found = await metadata.fetchByExternalId("author", "isbn", ISBN);
      expect(found.externalIds).toEqual({});
      expect(found.title).toBe(authors && (authors as any[])[0]?.name ? "Someone" : "Dune");
    }
  });
});

describe("fetchByExternalId: openlibrary", () => {
  it("reads an author by its Open Library id", async () => {
    const fetchMock = routedFetch([{ test: (u) => u === "https://openlibrary.org/authors/OL79034A.json", response: ok({ name: "Frank Herbert", birth_date: "October 8, 1920", bio: { type: "/type/text", value: "American author." } }) }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await metadata.fetchByExternalId("author", "openlibrary", "ol79034a")).toEqual({
      title: "Frank Herbert",
      year: 1920,
      overview: "American author.",
      posterUrl: "https://covers.openlibrary.org/a/olid/OL79034A-M.jpg",
      externalIds: { openlibrary: "OL79034A" },
    });
  });

  it("refuses another type and an id that is not an author's, and reports an unknown author", async () => {
    await expect(metadata.fetchByExternalId("artist", "openlibrary", "OL79034A")).rejects.toThrow('Open Library id lookup isn\'t available for "artist"');
    await expect(metadata.fetchByExternalId("author", "openlibrary", "OL1W")).rejects.toThrow("is not an Open Library author id");
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("openlibrary.org"), response: status(404) }]));
    await expect(metadata.fetchByExternalId("author", "openlibrary", "OL1A")).rejects.toThrow('No Open Library author found for id "OL1A"');
  });
});
