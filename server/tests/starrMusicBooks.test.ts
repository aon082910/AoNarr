import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const MBID = "83d91898-7763-47d7-b03b-b92132375c47";
const ARTIST = {
  title: "Test Artist",
  year: 1990,
  overview: "A band.",
  posterUrl: "https://img.example/artist.jpg",
  externalIds: { musicbrainz: MBID },
  status: "Active",
};
const AUTHOR = {
  title: "Test Author",
  year: 1920,
  overview: "Writes books.",
  posterUrl: "https://covers.example/a.jpg",
  externalIds: { openlibrary: "OL79034A" },
};
const ALBUMS = [
  { title: "First Album", releaseDate: "1991-01-01", externalId: "rg-1" },
  { title: "Second Album", releaseDate: "1995-05-05", externalId: "rg-2" },
  { title: "Third Album", releaseDate: "2001-06-06", externalId: "rg-3" },
];
const BOOKS = [
  { title: "First Book", releaseDate: "1951-01-01", externalId: "OL1W" },
  { title: "Second Book", releaseDate: "1960-01-01", externalId: "OL2W" },
];

// The providers answer from a fixed catalog; nothing here reaches the network.
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    fetchByExternalId: vi.fn(async (type: string, provider: string, id: string) => {
      if (type === "artist" && provider === "musicbrainz" && id === MBID) return ARTIST;
      if (type === "author" && provider === "openlibrary" && id === "OL79034A") return AUTHOR;
      if (type === "author" && provider === "isbn" && id === "9780441013593") return { title: "Test Author", year: null, overview: "Matched via ISBN", posterUrl: null, externalIds: {} };
      throw new Error(`No ${type} with ${provider} id ${id}`);
    }),
    searchMetadata: vi.fn(async (type: string, term: string) => (/test/i.test(term) ? [type === "artist" ? ARTIST : AUTHOR] : [])),
    fetchArtistAlbumsFor: vi.fn(async () => ({ provider: "musicbrainz", albums: ALBUMS })),
    fetchCollectionChildrenFor: vi.fn(async () => ({ provider: "openlibrary", children: BOOKS })),
    fetchAlbumTracksFor: vi.fn(async () => []),
  };
});

vi.mock("../src/services/searchOnAdd.js", () => ({ queueSearchAfterAdd: vi.fn(), searchOnAddEnabled: () => false }));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let searchAfterAdd: ReturnType<typeof vi.fn>;
let metadata: typeof import("../src/services/metadata.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  searchAfterAdd = vi.mocked((await import("../src/services/searchOnAdd.js")).queueSearchAfterAdd);
  metadata = await import("../src/services/metadata.js");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const get = (url: string) => request(app).get(url).set("X-Api-Key", apiKey);
const post = (url: string, body: unknown) => request(app).post(url).set("X-Api-Key", apiKey).send(body as object);
const put = (url: string, body: unknown) => request(app).put(url).set("X-Api-Key", apiKey).send(body as object);

async function folder(pathName: string, type: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(pathName, type)).lastInsertRowid);
}

let profileId: number;
let metadataProfileId: number;

beforeEach(async () => {
  for (const t of ["history", "queue", "episodes", "tracks", "sub_items", "media_item_tags", "media_item_titles", "media_items", "root_folders", "import_exclusions", "tags"]) {
    await db.prepare(`DELETE FROM ${t}`).run().catch(() => undefined);
  }
  profileId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id").get()) as { id: number }).id);
  metadataProfileId = Number(((await db.prepare("SELECT id FROM metadata_profiles ORDER BY id").get()) as { id: number } | undefined)?.id ?? (await db.prepare("INSERT INTO metadata_profiles (name) VALUES ('Test Profile')").run()).lastInsertRowid);
  searchAfterAdd.mockClear();
  await folder("/music", "artist");
  await folder("/books", "author");
  await folder("/movies", "movie");
});

const artistBody = (over: Record<string, unknown> = {}) => ({
  artistName: "Test Artist",
  foreignArtistId: MBID,
  qualityProfileId: profileId,
  metadataProfileId,
  monitored: true,
  monitorNewItems: "all",
  rootFolderPath: "/music",
  tags: [],
  addOptions: { monitor: "all", searchForMissingAlbums: false },
  ...over,
});
const authorBody = (over: Record<string, unknown> = {}) => ({
  authorName: "Test Author",
  foreignAuthorId: "OL79034A",
  qualityProfileId: profileId,
  metadataProfileId,
  monitored: true,
  rootFolderPath: "/books",
  tags: [],
  addOptions: { monitor: "all", searchForMissingBooks: false },
  ...over,
});

describe("looking an artist up (Lidarr)", () => {
  it("finds an artist by its MusicBrainz id in each of the forms a client sends", async () => {
    for (const term of [`lidarr:${MBID}`, `lidarrid:${MBID}`, `mbid:${MBID}`, `musicbrainz:${MBID}`, MBID, `LIDARR:${MBID.toUpperCase()}`]) {
      const res = await get(`/lidarr/api/v1/artist/lookup?term=${encodeURIComponent(term)}`);
      expect(res.status, term).toBe(200);
      expect(res.body, term).toHaveLength(1);
      expect(res.body[0], term).toMatchObject({ id: 0, artistName: "Test Artist", foreignArtistId: MBID, monitored: false, qualityProfileId: 0, rootFolderPath: "", tags: [], overview: "A band." });
    }
    const one = (await get(`/lidarr/api/v1/artist/lookup?term=mbid:${MBID}`)).body[0];
    expect(one.images[0]).toMatchObject({ coverType: "poster", remoteUrl: "https://img.example/artist.jpg" });
    expect(one.statistics).toMatchObject({ albumCount: 0, totalTrackCount: 0, sizeOnDisk: 0 });
    expect(one.status).toBe("continuing");
  });

  it("finds by name, and answers an empty list for what no provider knows", async () => {
    expect((await get("/lidarr/api/v1/artist/lookup?term=test%20artist")).body[0]).toMatchObject({ artistName: "Test Artist", id: 0 });
    expect((await get("/lidarr/api/v1/artist/lookup?term=zzz")).body).toEqual([]);
    expect((await get("/lidarr/api/v1/artist/lookup?term=mbid:11111111-1111-1111-1111-111111111111")).body).toEqual([]);
    expect((await get("/lidarr/api/v1/artist/lookup?term=goodreads:12")).body).toEqual([]);
    expect((await get("/lidarr/api/v1/artist/lookup")).status).toBe(400);
  });

  it("answers an artist the library holds with its own id, even when the provider is down", async () => {
    const added = await post("/lidarr/api/v1/artist", artistBody());
    expect(added.status).toBe(201);
    vi.mocked(metadata.fetchByExternalId).mockRejectedValue(new Error("provider down"));
    vi.mocked(metadata.searchMetadata).mockRejectedValue(new Error("provider down"));
    try {
      const byId = await get(`/lidarr/api/v1/artist/lookup?term=lidarr:${MBID}`);
      expect(byId.body).toHaveLength(1);
      expect(byId.body[0].id).toBe(added.body.id);
      expect((await get("/lidarr/api/v1/artist/lookup?term=test")).body).toEqual([]);
    } finally {
      vi.mocked(metadata.fetchByExternalId).mockReset();
      vi.mocked(metadata.searchMetadata).mockReset();
      vi.mocked(metadata.fetchByExternalId).mockImplementation(async (type: string, provider: string, id: string) => {
        if (type === "artist" && provider === "musicbrainz" && id === MBID) return ARTIST as any;
        if (type === "author" && provider === "openlibrary" && id === "OL79034A") return AUTHOR as any;
        if (type === "author" && provider === "isbn" && id === "9780441013593") return { title: "Test Author", year: null, overview: "Matched via ISBN", posterUrl: null, externalIds: {} } as any;
        throw new Error(`No ${type} with ${provider} id ${id}`);
      });
      vi.mocked(metadata.searchMetadata).mockImplementation(async (type: string, term: string) => (/test/i.test(term) ? [type === "artist" ? ARTIST : AUTHOR] : []) as any);
    }
  });

  it("looks an artist up by name and marks the one the library holds", async () => {
    const before = (await get("/lidarr/api/v1/artist/lookup?term=test")).body[0];
    expect(before.id).toBe(0);
    const added = await post("/lidarr/api/v1/artist", artistBody());
    const after = (await get("/lidarr/api/v1/artist/lookup?term=test")).body[0];
    expect(after.id).toBe(added.body.id);
    expect(after.rootFolderPath).toBe("/music");
  });
});

describe("looking an author up (Readarr)", () => {
  it("finds an author by Open Library id or ISBN, and by name", async () => {
    for (const term of ["openlibrary:OL79034A", "olid:OL79034A", "readarr:OL79034A", "OL79034A", "ol79034a"]) {
      const res = await get(`/readarr/api/v1/author/lookup?term=${encodeURIComponent(term)}`);
      expect(res.body, term).toHaveLength(1);
      expect(res.body[0], term).toMatchObject({ id: 0, authorName: "Test Author", foreignAuthorId: "OL79034A", monitored: false, tags: [] });
    }
    const byIsbn = await get("/readarr/api/v1/author/lookup?term=isbn:9780441013593");
    expect(byIsbn.body[0]).toMatchObject({ authorName: "Test Author", foreignAuthorId: "" });
    expect((await get("/readarr/api/v1/author/lookup?term=test")).body[0].authorName).toBe("Test Author");
    expect((await get("/readarr/api/v1/author/lookup?term=zzz")).body).toEqual([]);
  });

  it("answers no result for an id form no provider here can resolve", async () => {
    expect((await get("/readarr/api/v1/author/lookup?term=goodreads:12345")).body).toEqual([]);
    expect((await get("/readarr/api/v1/author/lookup?term=readarr:12345")).body).toEqual([]);
    expect((await get("/readarr/api/v1/author/lookup?term=OL1A")).body).toEqual([]);
  });
});

describe("adding an artist as a Lidarr client does", () => {
  it("adds it with its albums, the profile, the root folder and the tags asked for, and answers the artist", async () => {
    const tag = (await post("/lidarr/api/v1/tag", { label: "wanted" })).body.id;
    const res = await post("/lidarr/api/v1/artist", artistBody({ tags: [tag] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ artistName: "Test Artist", foreignArtistId: MBID, monitored: true, qualityProfileId: profileId, metadataProfileId, rootFolderPath: "/music", tags: [tag] });
    expect(res.body.id).toBeGreaterThan(0);
    expect(res.body.statistics).toMatchObject({ totalTrackCount: 3, albumCount: 3 });

    const row = (await db.prepare("SELECT type, root_folder_id, quality_profile_id, metadata_profile_id FROM media_items WHERE id = ?").get(res.body.id)) as any;
    expect(row.type).toBe("artist");
    expect(Number(row.quality_profile_id)).toBe(profileId);
    expect(Number(row.metadata_profile_id)).toBe(metadataProfileId);
    const albums = (await db.prepare("SELECT title, monitored FROM sub_items WHERE media_item_id = ? ORDER BY release_date").all(res.body.id)) as any[];
    expect(albums.map((a) => [a.title, Number(a.monitored)])).toEqual([["First Album", 1], ["Second Album", 1], ["Third Album", 1]]);
    // The albums are Lidarr's too, with the artist.
    const listed = (await get(`/lidarr/api/v1/album?artistId=${res.body.id}`)).body as any[];
    expect(listed.map((a) => a.title)).toEqual(["First Album", "Second Album", "Third Album"]);
  });

  it.each([
    ["none", [0, 0, 0]],
    ["first", [1, 0, 0]],
    ["latest", [0, 0, 1]],
    ["all", [1, 1, 1]],
    ["existing", [0, 0, 0]],
    ["future", [0, 0, 0]],
  ])("takes Lidarr's own Monitor option %s", async (option, monitored) => {
    const res = await post("/lidarr/api/v1/artist", artistBody({ addOptions: { monitor: option } }));
    expect(res.status).toBe(201);
    const albums = (await db.prepare("SELECT monitored FROM sub_items WHERE media_item_id = ? ORDER BY release_date").all(res.body.id)) as any[];
    expect(albums.map((a) => Number(a.monitored))).toEqual(monitored);
    await db.prepare("DELETE FROM media_items").run();
  });

  it("monitors only the albums it names when the Monitor option is a choice of albums", async () => {
    const res = await post("/lidarr/api/v1/artist", artistBody({ addOptions: { monitor: "unknown", albumsToMonitor: ["rg-2"] } }));
    expect(res.status).toBe(201);
    const albums = (await db.prepare("SELECT title, monitored FROM sub_items WHERE media_item_id = ? ORDER BY release_date").all(res.body.id)) as any[];
    expect(albums.map((a) => [a.title, Number(a.monitored)])).toEqual([["First Album", 0], ["Second Album", 1], ["Third Album", 0]]);
  });

  it("adds it unmonitored and with Monitor New Items off when asked", async () => {
    const res = await post("/lidarr/api/v1/artist", artistBody({ monitored: false, monitorNewItems: "none" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ monitored: false, monitorNewItems: "none" });
  });

  it("starts the search for missing albums after the disk scan, and only for a monitored artist", async () => {
    const quiet = await post("/lidarr/api/v1/artist", artistBody());
    expect(searchAfterAdd).not.toHaveBeenCalled();
    await db.prepare("DELETE FROM media_items WHERE id = ?").run(quiet.body.id);
    const res = await post("/lidarr/api/v1/artist", artistBody({ addOptions: { monitor: "all", searchForMissingAlbums: true } }));
    expect(searchAfterAdd).toHaveBeenCalledWith(res.body.id);
    searchAfterAdd.mockClear();
    await db.prepare("DELETE FROM media_items WHERE id = ?").run(res.body.id);
    const unmonitored = await post("/lidarr/api/v1/artist", artistBody({ monitored: false, addOptions: { searchForMissingAlbums: true } }));
    expect(unmonitored.status).toBe(201);
    expect(searchAfterAdd).not.toHaveBeenCalled();
  });

  it("refuses an artist twice, an id nobody knows, a missing id and a root folder that is not Lidarr's, all as a validation list", async () => {
    await post("/lidarr/api/v1/artist", artistBody());
    const again = await post("/lidarr/api/v1/artist", artistBody());
    expect(again.status).toBe(400);
    expect(again.body[0]).toMatchObject({ propertyName: "ForeignArtistId", errorMessage: "This artist has already been added" });
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(1);

    const unknown = await post("/lidarr/api/v1/artist", artistBody({ foreignArtistId: "11111111-1111-1111-1111-111111111111" }));
    expect(unknown.status).toBe(400);
    expect(unknown.body[0].errorMessage).toMatch(/No artist was found/);
    expect((await post("/lidarr/api/v1/artist", { artistName: "No id" })).body[0]).toMatchObject({ propertyName: "ForeignArtistId", errorMessage: "ForeignArtistId must be given" });
    expect((await post("/lidarr/api/v1/artist", artistBody({ foreignArtistId: "not-an-id" }))).body[0].propertyName).toBe("ForeignArtistId");
    await db.prepare("DELETE FROM media_items").run();
    const wrongFolder = await post("/lidarr/api/v1/artist", artistBody({ rootFolderPath: "/movies" }));
    expect(wrongFolder.status).toBe(400);
    expect(wrongFolder.body[0].propertyName).toBe("RootFolderPath");
    expect((await post("/lidarr/api/v1/artist", artistBody({ qualityProfileId: 999999 }))).body[0].propertyName).toBe("QualityProfileId");
    expect((await post("/lidarr/api/v1/artist", artistBody({ metadataProfileId: 999999 }))).body[0].propertyName).toBe("MetadataProfileId");
    expect((await post("/lidarr/api/v1/artist", artistBody({ tags: [99999] }))).body[0]).toMatchObject({ propertyName: "Tags" });
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(0);
  });

  it("makes one artist when the same add arrives twice at once", async () => {
    const [first, second] = await Promise.all([post("/lidarr/api/v1/artist", artistBody()), post("/lidarr/api/v1/artist", artistBody())]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as any).c)).toBe(1);
  });

  it("is Lidarr's alone: Sonarr and Readarr have no artist to add or look up", async () => {
    expect((await post("/sonarr/api/v3/artist", artistBody())).status).toBe(404);
    expect((await get("/sonarr/api/v3/artist/lookup?term=test")).status).toBe(404);
    expect((await get("/readarr/api/v1/artist/lookup?term=test")).status).toBe(404);
    expect((await get("/lidarr/api/v1/author/lookup?term=test")).status).toBe(404);
  });
});

describe("changing and removing an artist or author", () => {
  it("edits the artist: monitored, the profiles, Monitor New Items and tags", async () => {
    const added = await post("/lidarr/api/v1/artist", artistBody());
    const tag = (await post("/lidarr/api/v1/tag", { label: "later" })).body.id;
    const edited = await put(`/lidarr/api/v1/artist/${added.body.id}`, { id: added.body.id, monitored: false, monitorNewItems: "none", tags: [tag] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: added.body.id, monitored: false, monitorNewItems: "none", tags: [tag] });
    // The id may also come in the body of a PUT to the collection, as other clients send it.
    expect((await put("/lidarr/api/v1/artist", { id: added.body.id, monitored: true })).body.monitored).toBe(true);
    expect((await put(`/lidarr/api/v1/artist/${added.body.id}`, { id: added.body.id, tags: [99999] })).status).toBe(400);
    expect((await put(`/lidarr/api/v1/artist/${added.body.id}`, { id: added.body.id, metadataProfileId: 999999 })).body[0].propertyName).toBe("MetadataProfileId");
  });

  it("removes an artist and keeps it from coming back when asked, and the same for an author", async () => {
    const added = await post("/lidarr/api/v1/artist", artistBody());
    const removed = await request(app).delete(`/lidarr/api/v1/artist/${added.body.id}?deleteFiles=false&addImportListExclusion=true`).set("X-Api-Key", apiKey);
    expect(removed.status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM media_items WHERE id = ?").get(added.body.id)).toBeUndefined();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM import_exclusions").get()) as any).c)).toBe(1);

    const author = await post("/readarr/api/v1/author", authorBody());
    expect((await request(app).delete(`/readarr/api/v1/author/${author.body.id}`).set("X-Api-Key", apiKey)).status).toBe(200);
    expect((await get(`/readarr/api/v1/author/${author.body.id}`)).status).toBe(404);
  });
});

describe("adding an author as a Readarr client does", () => {
  it("adds it with its books, and answers the author", async () => {
    const res = await post("/readarr/api/v1/author", authorBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ authorName: "Test Author", foreignAuthorId: "OL79034A", monitored: true, qualityProfileId: profileId, metadataProfileId, rootFolderPath: "/books" });
    expect(res.body.statistics).toMatchObject({ totalBookCount: 2, bookCount: 2 });
    expect(((await db.prepare("SELECT type FROM media_items WHERE id = ?").get(res.body.id)) as any).type).toBe("author");
    expect(((await get(`/readarr/api/v1/book?authorId=${res.body.id}`)).body as any[]).map((b) => b.title)).toEqual(["First Book", "Second Book"]);
  });

  it("takes Readarr's Monitor option, a choice of books, and the search for missing books", async () => {
    const latest = await post("/readarr/api/v1/author", authorBody({ addOptions: { monitor: "latest", searchForMissingBooks: true } }));
    expect(latest.status).toBe(201);
    expect(((await db.prepare("SELECT title, monitored FROM sub_items WHERE media_item_id = ? ORDER BY release_date").all(latest.body.id)) as any[]).map((b) => [b.title, Number(b.monitored)])).toEqual([["First Book", 0], ["Second Book", 1]]);
    expect(searchAfterAdd).toHaveBeenCalledWith(latest.body.id);
    await db.prepare("DELETE FROM media_items").run();
    const chosen = await post("/readarr/api/v1/author", authorBody({ addOptions: { monitor: "unknown", booksToMonitor: ["OL1W"] } }));
    expect(((await db.prepare("SELECT title, monitored FROM sub_items WHERE media_item_id = ? ORDER BY release_date").all(chosen.body.id)) as any[]).map((b) => [b.title, Number(b.monitored)])).toEqual([["First Book", 1], ["Second Book", 0]]);
  });

  it("refuses what it cannot add, as a validation list", async () => {
    await post("/readarr/api/v1/author", authorBody());
    const again = await post("/readarr/api/v1/author", authorBody());
    expect(again.body[0]).toMatchObject({ propertyName: "ForeignAuthorId", errorMessage: "This author has already been added" });
    // A Goodreads number names no author any provider here can fetch.
    const goodreads = await post("/readarr/api/v1/author", authorBody({ foreignAuthorId: "12345" }));
    expect(goodreads.status).toBe(400);
    expect(goodreads.body[0].propertyName).toBe("ForeignAuthorId");
    expect((await post("/readarr/api/v1/author", { authorName: "x" })).body[0].errorMessage).toBe("ForeignAuthorId must be given");
    await db.prepare("DELETE FROM media_items").run();
    expect((await post("/readarr/api/v1/author", authorBody({ rootFolderPath: "/music" }))).body[0].propertyName).toBe("RootFolderPath");
  });
});

describe("looking an album or a book of the library up", () => {
  async function addBoth() {
    const artist = await post("/lidarr/api/v1/artist", artistBody());
    const author = await post("/readarr/api/v1/author", authorBody());
    return { artist, author };
  }

  it("finds albums by their foreign id and by words of the title or the artist's name, with the artist", async () => {
    const { artist } = await addBoth();
    const byId = (await get("/lidarr/api/v1/album/lookup?term=lidarr:rg-2")).body;
    expect(byId).toHaveLength(1);
    expect(byId[0]).toMatchObject({ title: "Second Album", foreignAlbumId: "rg-2", artistId: artist.body.id });
    expect(byId[0].artist.artistName).toBe("Test Artist");
    expect(((await get("/lidarr/api/v1/album/lookup?term=second")).body as any[]).map((a) => a.title)).toEqual(["Second Album"]);
    expect(((await get("/lidarr/api/v1/album/lookup?term=test%20artist%20album")).body as any[]).map((a) => a.title)).toEqual(["First Album", "Second Album", "Third Album"]);
    expect((await get("/lidarr/api/v1/album/lookup?term=nothing")).body).toEqual([]);
    expect((await get("/lidarr/api/v1/album/lookup?term=lidarr:unknown")).body).toEqual([]);
    expect((await get("/lidarr/api/v1/album/lookup")).status).toBe(400);
    // A wildcard in the term is a character of the term.
    expect((await get("/lidarr/api/v1/album/lookup?term=%25")).body).toEqual([]);
  });

  it("finds books the same way, and keeps the apps apart", async () => {
    const { author } = await addBoth();
    const byId = (await get("/readarr/api/v1/book/lookup?term=openlibrary:OL2W")).body;
    expect(byId[0]).toMatchObject({ title: "Second Book", foreignBookId: "OL2W", authorId: author.body.id });
    expect(byId[0].author.authorName).toBe("Test Author");
    expect(((await get("/readarr/api/v1/book/lookup?term=first")).body as any[]).map((b) => b.title)).toEqual(["First Book"]);
    // An album is not a book: each app sees its own titles only.
    expect((await get("/readarr/api/v1/book/lookup?term=album")).body).toEqual([]);
    expect((await get("/lidarr/api/v1/album/lookup?term=book")).body).toEqual([]);
  });
});

describe("the OpenAPI document of Lidarr and Readarr", () => {
  it("lists the lookup and add routes", async () => {
    const lidarr = (await get("/lidarr/api/v1/openapi.json")).body;
    expect(lidarr.paths["/api/v1/artist/lookup"].get).toBeDefined();
    expect(lidarr.paths["/api/v1/album/lookup"].get).toBeDefined();
    expect(lidarr.paths["/api/v1/artist"].post).toBeDefined();
    const readarr = (await get("/readarr/api/v1/openapi.json")).body;
    expect(readarr.paths["/api/v1/author/lookup"].get).toBeDefined();
    expect(readarr.paths["/api/v1/book/lookup"].get).toBeDefined();
    expect(readarr.paths["/api/v1/author"].post).toBeDefined();
    expect(readarr.paths["/api/v1/artist"]).toBeUndefined();
  });
});
