import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  notifyGrabbed: vi.fn(),
  notifyFailed: vi.fn(),
  notifyHealthIssue: vi.fn(),
  notifyManualInteractionRequired: vi.fn(),
  notifyUpdateAvailable: vi.fn(),
}));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let adapter: { addDownload: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "pending_releases", "rss_decisions", "queue", "delay_profiles", "episodes", "sub_items", "media_items", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  adapter = { addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: `id-${url.length}-${url.slice(-12)}` })), getStatus: vi.fn().mockResolvedValue([]) };
  getDownloadClientAdapter.mockReset().mockReturnValue(adapter);
  setSetting("autoUpgradeEnabled", "0");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = "SECRET-PASSKEY-123";
const MATRIX = "The.Matrix.1999.1080p.WEB-DL-GRP";

const radarr = (body: unknown) => request(app).post("/radarr/api/v3/release/push").set("X-Api-Key", apiKey).send(body as object);
const sonarr = (body: unknown) => request(app).post("/sonarr/api/v3/release/push").set("X-Api-Key", apiKey).send(body as object);
const lidarr = (body: unknown) => request(app).post("/lidarr/api/v1/release/push").set("X-Api-Key", apiKey).send(body as object);
const readarr = (body: unknown) => request(app).post("/readarr/api/v1/release/push").set("X-Api-Key", apiKey).send(body as object);
const native = (body: unknown) => request(app).post("/api/releases/push").set("X-Api-Key", apiKey).send(body as object);

const push = (over: Record<string, unknown> = {}) => ({
  title: MATRIX,
  downloadUrl: `https://tracker.example/dl/42.torrent?passkey=${SECRET}`,
  protocol: "Torrent",
  publishDate: "2020-01-01T00:00:00Z",
  size: 5_000_000_000,
  indexer: "Idx",
  ...over,
});

async function client(type = "qbittorrent"): Promise<number> {
  return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES (?, ?, 1)").run(`Client ${type}`, type)).lastInsertRowid);
}
async function indexer(name = "Idx", mediaTypes = "movie,series,anime,artist,author"): Promise<number> {
  return Number((await db.prepare("INSERT INTO indexers (name, protocol, url, enabled, media_types) VALUES (?, 'torznab', 'http://idx.example.com', 1, ?)").run(name, mediaTypes)).lastInsertRowid);
}
async function profile(allowed: string[], cutoff: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)").run(`Profile ${Math.random()}`, JSON.stringify(allowed), cutoff)).lastInsertRowid);
}
async function movie(over: { title?: string; year?: number; hasFile?: number; quality?: string | null; profileId?: number | null; monitored?: number } = {}): Promise<number> {
  const title = over.title ?? "The Matrix";
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, quality, quality_profile_id, status) VALUES ('movie', ?, ?, ?, ?, ?, ?, ?, 'missing')")
        .run(title, title.toLowerCase(), over.year ?? 1999, over.monitored ?? 1, over.hasFile ?? 0, over.quality ?? null, over.profileId ?? null)
    ).lastInsertRowid
  );
}
async function series(title: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', ?, ?, 1, 0, 'missing')").run(title, title.toLowerCase())).lastInsertRowid);
}
async function episode(showId: number, season: number, number: number): Promise<number> {
  return Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, ?, ?, 'Ep', 1, 0, '2020-01-01')").run(showId, season, number)).lastInsertRowid);
}
const queue = async (): Promise<any[]> => (await db.prepare("SELECT media_item_id, episode_id, sub_item_id, title, grab_source, protocol, indexer_id FROM queue ORDER BY id").all()) as any[];
const count = async (table: string): Promise<number> => Number(((await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()) as any).c);

describe("POST /release/push: an approved release", () => {
  it("is grabbed through the client adapter, recorded as a pushed grab, and answered as an approved release resource", async () => {
    await client();
    const indexerId = await indexer();
    const movieId = await movie();
    const res = await radarr(push());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      title: MATRIX,
      approved: true,
      rejected: false,
      temporarilyRejected: false,
      rejections: [],
      downloadAllowed: true,
      protocol: "torrent",
      indexer: "Idx",
      indexerId,
      size: 5_000_000_000,
      mappedMovieId: movieId,
      quality: { quality: { name: "WEBDL-1080p" } },
      publishDate: "2020-01-01T00:00:00.000Z",
    });
    expect(res.body[0].guid).toMatch(/^PushedRelease-[0-9a-f]{20}$/);
    expect(await queue()).toEqual([{ media_item_id: movieId, episode_id: null, sub_item_id: null, title: MATRIX, grab_source: "push", protocol: "torrent", indexer_id: indexerId }]);
    // The client was handed the link; the answer does not repeat it (it carries a passkey).
    expect(adapter.addDownload.mock.calls[0][1]).toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain("tracker.example");
    const history = (await db.prepare("SELECT event_type, data FROM history WHERE media_item_id = ?").all(movieId)) as any[];
    expect(history.map((h) => h.event_type)).toContain("grabbed");
    expect(JSON.parse(history.find((h) => h.event_type === "grabbed").data).grabSource).toBe("push");
    // It shows in the list of recent releases, which never carries the link.
    const decisions = (await db.prepare("SELECT outcome, title FROM rss_decisions").all()) as any[];
    expect(decisions).toEqual([{ outcome: "grabbed", title: MATRIX }]);
  });

  it("takes a magnet link, and a magnet link given as the download link", async () => {
    await client();
    await indexer();
    await movie();
    const res = await radarr(push({ downloadUrl: undefined, magnetUrl: "magnet:?xt=urn:btih:aaaabbbbccccddddeeeeffff0000111122223333&tr=https%3A%2F%2Ftracker.example%2Fannounce%3Fpasskey%3DSECRET" }));
    expect(res.status).toBe(200);
    expect(res.body[0].approved).toBe(true);
    expect(adapter.addDownload.mock.calls[0][1]).toMatch(/^magnet:\?xt=urn:btih:aaaabbbb/);

    await db.prepare("DELETE FROM queue").run();
    await db.prepare("DELETE FROM history").run();
    const asDownload = await radarr(push({ downloadUrl: "magnet:?xt=urn:btih:1111222233334444555566667777888899990000" }));
    expect(asDownload.body[0].approved).toBe(true);
  });

  it("grabs a Usenet release for an episode through a Usenet client", async () => {
    await client("sabnzbd");
    await indexer();
    const showId = await series("Push Show");
    await episode(showId, 1, 1);
    const two = await episode(showId, 1, 2);
    const res = await sonarr(push({ title: "Push.Show.S01E02.1080p.WEB-DL-GRP", downloadUrl: "https://usenet.example/getnzb/abc.nzb?apikey=" + SECRET, protocol: "Usenet" }));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: true, protocol: "usenet", mappedSeriesId: showId });
    expect(await queue()).toMatchObject([{ media_item_id: showId, episode_id: two, protocol: "usenet", grab_source: "push" }]);
  });

  it("answers the same list from the native route, and finds the Starr app by the title it names", async () => {
    await client();
    await indexer();
    const movieId = await movie();
    const res = await native(push());
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: true, mappedMovieId: movieId, title: MATRIX });
  });

  it("matches the indexer by its name, whatever the case, and keeps a name AoNarr does not know as a label", async () => {
    await client();
    const indexerId = await indexer("My Tracker");
    await movie();
    const known = await radarr(push({ indexer: "my tracker" }));
    expect(known.body[0]).toMatchObject({ indexer: "My Tracker", indexerId });
    await db.prepare("DELETE FROM queue").run();
    await db.prepare("DELETE FROM history").run();
    const unknown = await radarr(push({ indexer: "Somewhere Else" }));
    expect(unknown.body[0]).toMatchObject({ indexer: "Somewhere Else", indexerId: 0, approved: true });
    expect(((await queue())[0] as any).indexer_id).toBeNull();
  });
});

describe("POST /release/push: a release that is not taken", () => {
  it("is rejected for a quality the profile does not allow, with the reason, and nothing is grabbed", async () => {
    await client();
    await indexer();
    const profileId = await profile(["Bluray-1080p"], "Bluray-1080p");
    await movie({ profileId });
    const res = await radarr(push({ title: "The.Matrix.1999.720p.WEB-DL-GRP" }));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: false, rejected: true, temporarilyRejected: false, downloadAllowed: false });
    expect(res.body[0].rejections).toHaveLength(1);
    expect(res.body[0].rejections[0]).toMatch(/quality|allowed|profile/i);
    expect(await queue()).toEqual([]);
    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(await count("pending_releases")).toBe(0);
  });

  it("is rejected when its name is on the blocklist", async () => {
    await client();
    await indexer();
    const movieId = await movie();
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title, reason) VALUES (?, ?, 'failed')").run(movieId, MATRIX);
    const res = await radarr(push());
    expect(res.body[0]).toMatchObject({ approved: false, rejected: true });
    expect(res.body[0].rejections[0]).toMatch(/blocklist/i);
    expect(await queue()).toEqual([]);
  });

  it("is rejected when the title already has its file and the release is no upgrade", async () => {
    await client();
    await indexer();
    await movie({ hasFile: 1, quality: "WEBDL-1080p" });
    const res = await radarr(push());
    expect(res.body[0]).toMatchObject({ approved: false, rejected: true });
    expect(await queue()).toEqual([]);
  });

  it("is rejected for a title that is not monitored", async () => {
    await client();
    await indexer();
    await movie({ monitored: 0 });
    const res = await radarr(push());
    expect(res.body[0]).toMatchObject({ approved: false, rejected: true });
    expect(await queue()).toEqual([]);
  });

  it("is rejected with the reason, and nothing is stored, when it names no title of the library", async () => {
    await client();
    await indexer();
    await movie();
    const res = await radarr(push({ title: "Some.Unknown.Film.2012.1080p.WEB-DL-GRP" }));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: false, rejected: true, temporarilyRejected: false });
    expect(res.body[0].rejections[0]).toMatch(/no wanted title is named/i);
    expect(res.body[0].mappedMovieId).toBeUndefined();
    expect(await queue()).toEqual([]);
    expect(await count("rss_decisions")).toBe(0);
    expect(await count("pending_releases")).toBe(0);
    expect(await count("history")).toBe(0);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("is rejected by an app that does not hold what it names: a film to Sonarr, an episode to Radarr", async () => {
    await client();
    await indexer();
    await movie();
    const showId = await series("Push Show");
    await episode(showId, 1, 1);
    const toSonarr = await sonarr(push());
    expect(toSonarr.body[0]).toMatchObject({ approved: false, rejected: true });
    const toRadarr = await radarr(push({ title: "Push.Show.S01E01.1080p.WEB-DL-GRP" }));
    expect(toRadarr.body[0]).toMatchObject({ approved: false, rejected: true });
    expect(await queue()).toEqual([]);
  });

  it("is rejected, not grabbed, when no download client is configured", async () => {
    await indexer();
    await movie();
    const res = await radarr(push());
    expect(res.body[0]).toMatchObject({ approved: false, temporarilyRejected: true, rejected: false });
    expect(res.body[0].rejections[0]).toMatch(/download client/i);
  });
});

describe("POST /release/push: a delay profile", () => {
  const delay = (minutes: number) =>
    db
      .prepare("INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index) VALUES (NULL, 1, 1, 0, ?, 0, 0)")
      .run(minutes);

  it("holds a fresh release as pending and answers it as temporarily rejected, once however often it is pushed", async () => {
    await client();
    await indexer();
    const movieId = await movie();
    await db.prepare("UPDATE media_items SET auto_search_misses = 9 WHERE id = ?").run(movieId);
    await delay(24 * 60);
    const fresh = push({ publishDate: new Date().toISOString() });
    const first = await radarr(fresh);
    expect(first.body[0]).toMatchObject({ approved: false, temporarilyRejected: true, rejected: false, downloadAllowed: false });
    expect(first.body[0].rejections[0]).toMatch(/delay/i);
    expect(await queue()).toEqual([]);
    expect(await count("pending_releases")).toBe(1);
    expect(Number(((await db.prepare("SELECT auto_search_misses FROM media_items WHERE id = ?").get(movieId)) as any).auto_search_misses)).toBe(0);

    const again = await radarr(fresh);
    expect(again.body[0].temporarilyRejected).toBe(true);
    expect(await count("pending_releases")).toBe(1);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("grabs a release that is old enough", async () => {
    await client();
    await indexer();
    await movie();
    await delay(60);
    const res = await radarr(push({ publishDate: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    expect(res.body[0]).toMatchObject({ approved: true, temporarilyRejected: false });
    expect(await queue()).toHaveLength(1);
  });
});

describe("POST /release/push: the same release twice", () => {
  it("is grabbed once; the second push is rejected as already queued", async () => {
    await client();
    await indexer();
    await movie();
    const first = await radarr(push());
    const second = await radarr(push());
    expect(first.body[0]).toMatchObject({ approved: true, guid: expect.any(String) });
    expect(second.body[0]).toMatchObject({ approved: false, rejected: true, guid: first.body[0].guid });
    expect(second.body[0].rejections[0]).toMatch(/queued/i);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(await queue()).toHaveLength(1);
  });

  it("is grabbed once when the two pushes arrive together", async () => {
    await client();
    await indexer();
    await movie();
    const [a, b] = await Promise.all([radarr(push()), radarr(push())]);
    expect([a.body[0].approved, b.body[0].approved].sort()).toEqual([false, true]);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(await queue()).toHaveLength(1);
  });
});

describe("POST /release/push: albums and books", () => {
  it("grabs a wanted album pushed to Lidarr, and a wanted book pushed to Readarr", async () => {
    await client();
    await indexer();
    const artist = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Push Band', 'push band', 1, 0, 'missing')").run()).lastInsertRowid);
    const album = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Second Record', 1, 0)").run(artist)).lastInsertRowid);
    const author = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Push Writer', 'push writer', 1, 0, 'missing')").run()).lastInsertRowid);
    const book = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Long Novel', 1, 0)").run(author)).lastInsertRowid);

    const toLidarr = await lidarr(push({ title: "Push Band - Second Record (2019) [FLAC]", downloadUrl: "https://tracker.example/dl/album.torrent" }));
    expect(toLidarr.status).toBe(200);
    expect(toLidarr.body[0]).toMatchObject({ approved: true, mappedArtistId: artist });
    const toReadarr = await readarr(push({ title: "Push Writer - Long Novel (2015) [EPUB]", downloadUrl: "https://tracker.example/dl/book.torrent" }));
    expect(toReadarr.body[0]).toMatchObject({ approved: true, mappedAuthorId: author });
    expect((await queue()).map((q) => [q.media_item_id, q.sub_item_id, q.grab_source])).toEqual([
      [artist, album, "push"],
      [author, book, "push"],
    ]);
    // Each app takes only its own kind.
    const wrong = await readarr(push({ title: "Push Band - Second Record (2019) [FLAC]", downloadUrl: "https://tracker.example/dl/other.torrent" }));
    expect(wrong.body[0]).toMatchObject({ approved: false, rejected: true });
  });
});

describe("POST /release/push: what the body must be", () => {
  const invalid = async (over: Record<string, unknown>) => {
    const res = await radarr(push(over));
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
    return res.body as { propertyName: string; errorMessage: string }[];
  };

  it("needs a title, a link, a protocol and a publish date, and names the field", async () => {
    expect((await invalid({ title: "" }))[0].propertyName).toBe("Title");
    expect((await invalid({ downloadUrl: undefined }))[0].propertyName).toBe("DownloadUrl");
    expect((await invalid({ protocol: "carrier-pigeon" }))[0].propertyName).toBe("Protocol");
    expect((await invalid({ protocol: undefined }))[0].propertyName).toBe("Protocol");
    expect((await invalid({ publishDate: undefined }))[0].propertyName).toBe("PublishDate");
    expect((await invalid({ publishDate: "last tuesday" }))[0].propertyName).toBe("PublishDate");
    const several = await invalid({ title: "", protocol: "x", publishDate: undefined });
    expect(several.map((e) => e.propertyName).sort()).toEqual(["Protocol", "PublishDate", "Title"]);
  });

  it("takes a link only if it is http(s) or a magnet link, and a magnet link only for a torrent", async () => {
    for (const downloadUrl of ["ftp://tracker.example/x.torrent", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "//tracker.example/x", "not a link"]) {
      expect((await invalid({ downloadUrl }))[0].propertyName, downloadUrl).toBe("DownloadUrl");
    }
    expect((await invalid({ downloadUrl: undefined, magnetUrl: "https://tracker.example/x" }))[0].propertyName).toBe("MagnetUrl");
    expect((await invalid({ protocol: "Usenet", downloadUrl: undefined, magnetUrl: "magnet:?xt=urn:btih:abc" }))[0].propertyName).toBe("MagnetUrl");
    expect((await invalid({ downloadUrl: "https://tracker.example/" + "a".repeat(9000) }))[0].propertyName).toBe("DownloadUrl");
    // The refusal does not repeat the link.
    expect(JSON.stringify(await invalid({ downloadUrl: "ftp://x.example/?key=" + SECRET }))).not.toContain(SECRET);
  });

  it("takes the protocol in any case, and refuses a size or a count that is not a number", async () => {
    await client();
    await indexer();
    await movie();
    expect((await radarr(push({ protocol: "torrent" }))).body[0].approved).toBe(true);
    expect((await invalid({ size: -5 }))[0].propertyName).toBe("Size");
    expect((await invalid({ size: "lots" }))[0].propertyName).toBe("Size");
    expect((await invalid({ seeders: 1.5 }))[0].propertyName).toBe("Seeders");
  });

  it("refuses a size or a count too big to keep: the queue holds a 64-bit size and 32-bit counts (L5)", async () => {
    await client();
    await indexer();
    await movie();
    expect((await invalid({ size: 1e20 }))[0]).toMatchObject({ propertyName: "Size", errorMessage: expect.stringContaining(String(Number.MAX_SAFE_INTEGER)) });
    expect((await invalid({ size: 2 ** 53 }))[0].propertyName).toBe("Size");
    expect((await invalid({ seeders: 2147483648 }))[0]).toMatchObject({ propertyName: "Seeders", errorMessage: expect.stringContaining("2147483647") });
    expect((await invalid({ leechers: 1e12 }))[0].propertyName).toBe("Leechers");
    expect(adapter.addDownload).not.toHaveBeenCalled();
    // The largest the queue keeps is not refused as a body.
    const edge = await radarr(push({ size: Number.MAX_SAFE_INTEGER, seeders: 2147483647, leechers: 2147483647 }));
    expect(edge.status).toBe(200);
  });

  it("refuses a body that is not an object", async () => {
    const res = await request(app).post("/radarr/api/v3/release/push").set("X-Api-Key", apiKey).send([push()]);
    expect(res.status).toBe(400);
    const nothing = await request(app).post("/radarr/api/v3/release/push").set("X-Api-Key", apiKey);
    expect(nothing.status).toBe(400);
    expect((await native({})).status).toBe(400);
    const nativeBad = await native(push({ protocol: "x" }));
    expect(nativeBad.status).toBe(400);
    expect(nativeBad.body.error).toMatch(/Protocol/);
  });
});

describe("POST /release/push: who may push", () => {
  it("needs the key: as a header, as the apikey query parameter or as a Bearer token on a Starr mount, and as a header only on the native route", async () => {
    await client();
    await indexer();
    await movie();
    expect((await request(app).post("/radarr/api/v3/release/push").send(push())).status).toBe(401);
    expect((await request(app).post("/radarr/api/v3/release/push").set("X-Api-Key", "wrong").send(push())).status).toBe(401);
    expect((await request(app).post("/api/releases/push").send(push())).status).toBe(401);
    // The native API keeps its key out of the URL.
    expect((await request(app).post(`/api/releases/push?apikey=${apiKey}`).send(push())).status).toBe(401);
    expect((await request(app).post("/radarr/api/v3/release/push").set("Authorization", `Bearer ${apiKey}`).send(push({ title: "Nothing.Here.2000.1080p.WEB-DL-GRP" }))).status).toBe(200);
    expect((await request(app).post(`/radarr/api/v3/release/push?apikey=${apiKey}`).send(push())).status).toBe(200);
  });

  it("is for the admin: a household session is refused on both routes", async () => {
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const userId = Number((await db.prepare("INSERT INTO users (username, password_hash, role, auto_approve) VALUES ('pusher', ?, 'user', 1)").run(hashPassword("x"))).lastInsertRowid);
    const { token } = await createSession(userId);
    expect((await request(app).post("/api/releases/push").set("X-Session-Token", token).send(push())).status).toBe(403);
    expect((await request(app).post("/radarr/api/v3/release/push").set("X-Session-Token", token).send(push())).status).toBe(403);
    await db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
});

describe("POST /release/push: the link never reaches a log or an answer", () => {
  it("keeps the passkey out of the log lines and the answer when the client refuses the release", async () => {
    await client();
    await indexer();
    await movie();
    adapter.addDownload.mockRejectedValue(new Error(`HTTP 404 from https://tracker.example/dl/42.torrent?passkey=${SECRET}`));
    const logged: string[] = [];
    const { log } = await import("../src/services/logger.js");
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(log, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));

    const res = await radarr(push());
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ approved: false });
    expect(res.body[0].rejections[0]).toMatch(/download client refused/i);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(await queue()).toEqual([]);
  });

  it("writes a pushed link into the log without its query string, and a magnet link by its hash", async () => {
    await client();
    await indexer();
    await movie();
    const logged: string[] = [];
    const { log } = await import("../src/services/logger.js");
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(log, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    await radarr(push());
    const line = logged.find((l) => l.includes("[push]"));
    expect(line).toContain("https://tracker.example/*.torrent");
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain("passkey");

    logged.length = 0;
    await radarr(push({ title: "Other.Film.2001.1080p.WEB-DL-GRP", downloadUrl: "magnet:?xt=urn:btih:ffff0000ffff0000ffff0000ffff0000ffff0000&tr=https%3A%2F%2Ft.example%2Fa%3Fpasskey%3D" + SECRET }));
    expect(logged.join("\n")).toContain("magnet:ffff0000ffff0000ffff0000ffff0000ffff0000");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("writes no path of a link into the log: a tracker can put its passkey in the path (L6)", async () => {
    await client();
    await indexer();
    await movie();
    const logged: string[] = [];
    const { log } = await import("../src/services/logger.js");
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(log, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    await radarr(push({ downloadUrl: "https://t.example/download/PASSKEY123/45.torrent?apikey=K" }));
    const text = logged.join("\n");
    expect(logged.find((l) => l.includes("[push]"))).toContain("https://t.example/*.torrent");
    for (const secret of ["PASSKEY123", "/download", "apikey"]) expect(text, secret).not.toContain(secret);
  });

  it("describes a link by its host and, at most, the kind of file it ends in", async () => {
    const { describeLink, redactLinks } = await import("../src/services/linkRedaction.js");
    expect(describeLink("https://t.example/download/PASSKEY123/45.torrent?apikey=K")).toBe("https://t.example/*.torrent");
    expect(describeLink("http://u:pw@t.example:8080/api?t=search&apikey=K")).toBe("http://t.example:8080/*");
    expect(describeLink("https://t.example/rss/PASSKEY.abc123")).toBe("https://t.example/*");
    expect(describeLink("https://t.example/getnzb/abc.NZB")).toBe("https://t.example/*.nzb");
    expect(describeLink("https://t.example/")).toBe("https://t.example");
    expect(describeLink("not a link")).toBe("a link");
    expect(redactLinks("HTTP 404 from https://t.example/dl/PASSKEY123/1.torrent?apikey=K (retry)")).toBe("HTTP 404 from https://t.example/*.torrent (retry)");
  });

  it("redacts the message of a client that is unavailable, in the log and in what is kept for the answer (L6)", async () => {
    const { DownloadClientUnavailableError, noteUnavailableClient } = await import("../src/services/scheduler.js");
    const logged: string[] = [];
    const { log } = await import("../src/services/logger.js");
    for (const level of ["info", "warn", "error"] as const) vi.spyOn(log, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const err = new DownloadClientUnavailableError({ id: 7, name: "Seeder" } as any, new Error("HTTP 502 from https://t.example/download/PASSKEY123/45.torrent?apikey=K"));
    const unavailable = new Map<number, string>();
    expect(noteUnavailableClient(err, unavailable)).toBe(true);
    expect(logged.join("\n")).toContain('Download client "Seeder" is unavailable');
    expect(logged.join("\n")).not.toMatch(/PASSKEY123|apikey/);
    expect(unavailable.get(7)).toContain("HTTP 502 from https://t.example/*.torrent");
    expect(unavailable.get(7)).not.toMatch(/PASSKEY123|apikey/);
  });
});

describe("the documents", () => {
  it("lists the push in each Starr app's OpenAPI document and in the native one", async () => {
    for (const [mount, version] of [["sonarr", "v3"], ["radarr", "v3"], ["lidarr", "v1"], ["readarr", "v1"]] as const) {
      const doc = (await request(app).get(`/${mount}/api/${version}/openapi.json`).set("X-Api-Key", apiKey)).body;
      expect(doc.paths[`/api/${version}/release/push`].post, mount).toBeDefined();
    }
    const nativeDoc = (await request(app).get("/api/openapi.json").set("X-Api-Key", apiKey)).body;
    expect(nativeDoc.paths["/releases/push"].post.summary).toMatch(/release/);
  });
});
