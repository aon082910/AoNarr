import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const refreshOneMediaItem = vi.fn();
const refreshLibraryMetadata = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/libraryScan.js")>()),
  refreshOneMediaItem: (...args: unknown[]) => refreshOneMediaItem(...args),
  refreshLibraryMetadata: (...args: unknown[]) => refreshLibraryMetadata(...args),
}));

const corruptReason = vi.fn();
const handleCorrupt = vi.fn();
vi.mock("../src/services/corruptMediaCheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/corruptMediaCheck.js")>()),
  corruptReason: (...args: unknown[]) => corruptReason(...args),
  handleCorrupt: (...args: unknown[]) => handleCorrupt(...args),
}));

const convertSubItemToM4b = vi.fn();
vi.mock("../src/services/audiobookConvert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/audiobookConvert.js")>()),
  convertSubItemToM4b: (...args: unknown[]) => convertSubItemToM4b(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

async function insertItem(type: string, title: string, extra: { hasFile?: number; path?: string | null } = {}): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, path) VALUES (?, ?, ?, 1, ?, 'missing', ?)`)
    .run(type, title, title.toLowerCase(), extra.hasFile ?? 0, extra.path ?? null);
  return Number(result.lastInsertRowid);
}

async function mediaRow(id: number): Promise<any> {
  return db.prepare("SELECT * FROM media_items WHERE id = ?").get(id);
}

const SCREENSCRAPER_POSTER =
  "https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=dev&devpassword=devsecret&ssid=me&sspassword=mysecret&systemeid=1&jeuid=3&media=box-2D";
const SCREENSCRAPER_BACKDROP_REF = "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?systemeid=1&jeuid=3&media=fanart";

function expectProxied(url: string, localPath: string | null, token: string | null, source: string) {
  expect(url).toMatch(/^\/api\/media\/local-artwork\/[0-9a-f]+$/);
  expect(url).toBe(`/api/media/local-artwork/${token}`);
  expect(localPath).toMatch(/^screenscraper:https:\/\/neoclone\.screenscraper\.fr\/api2\/mediaJeu\.php\?/);
  expect(localPath).toContain(source);
  expect(localPath).not.toMatch(/devid|devpassword|ssid|sspassword|secret/);
}

describe("ScreenScraper artwork stored through the local-artwork proxy", () => {
  it("POST /api/media stores a ScreenScraper poster/backdrop as a proxied url with the reference in local_*_path", async () => {
    const res = await request(app)
      .post("/api/media")
      .set("X-Api-Key", apiKey)
      .send({ type: "rom", title: "Proxied Game", posterUrl: SCREENSCRAPER_POSTER, backdropUrl: SCREENSCRAPER_BACKDROP_REF, confirmDuplicate: true });

    expect(res.status).toBe(201);
    const row = await mediaRow(res.body.id);
    expectProxied(row.poster_url, row.local_poster_path, row.local_poster_token, "media=box-2D");
    expectProxied(row.backdrop_url, row.local_backdrop_path, row.local_backdrop_token, "media=fanart");
    expect(row.local_poster_token).not.toBe(row.local_backdrop_token);
  });

  it("POST /api/media stores an ordinary https poster unchanged", async () => {
    const res = await request(app)
      .post("/api/media")
      .set("X-Api-Key", apiKey)
      .send({ type: "movie", title: "Plain Poster Film", posterUrl: "https://image.tmdb.org/t/p/w500/abc.jpg", confirmDuplicate: true });

    expect(res.status).toBe(201);
    const row = await mediaRow(res.body.id);
    expect(row.poster_url).toBe("https://image.tmdb.org/t/p/w500/abc.jpg");
    expect(row.local_poster_path).toBeNull();
    expect(row.local_poster_token).toBeNull();
  });

  it("rematch stores a ScreenScraper poster behind the proxy, and an ordinary one as-is with the old local artwork cleared", async () => {
    refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
    const id = await insertItem("rom", "Old Match");
    await db
      .prepare("UPDATE media_items SET poster_url = ?, local_poster_path = ?, local_poster_token = ? WHERE id = ?")
      .run("/api/media/local-artwork/oldtoken", "/library/Old Match/poster.jpg", "oldtoken", id);

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "New Match", posterUrl: SCREENSCRAPER_POSTER });

    expect(res.status).toBe(200);
    const row = await mediaRow(id);
    expectProxied(row.poster_url, row.local_poster_path, row.local_poster_token, "media=box-2D");
    expect(row.local_poster_token).not.toBe("oldtoken");
    expect(row.backdrop_url).toBeNull();
    expect(row.local_backdrop_path).toBeNull();

    await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Other Match", posterUrl: "https://img.example/other.jpg" });
    const after = await mediaRow(id);
    expect(after.poster_url).toBe("https://img.example/other.jpg");
    expect(after.local_poster_path).toBeNull();
    expect(after.local_poster_token).toBeNull();
  });

  it("PATCH /api/media/:id stores a ScreenScraper poster behind the proxy and leaves an ordinary one as-is", async () => {
    const id = await insertItem("rom", "Patched Game");

    const res = await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ posterUrl: SCREENSCRAPER_BACKDROP_REF });

    expect(res.status).toBe(200);
    const row = await mediaRow(id);
    expectProxied(row.poster_url, row.local_poster_path, row.local_poster_token, "media=fanart");

    await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ backdropUrl: "https://img.example/fanart.jpg" });
    const after = await mediaRow(id);
    expect(after.backdrop_url).toBe("https://img.example/fanart.jpg");
    expect(after.local_backdrop_path).toBeNull();
    expect(after.poster_url).toBe(row.poster_url);
  });

  it("PATCH /api/media/:id keeps a proxied poster when its URL is sent back, and drops it when replaced", async () => {
    const id = await insertItem("rom", "Replaced Poster Game");
    await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ posterUrl: SCREENSCRAPER_POSTER, backdropUrl: SCREENSCRAPER_BACKDROP_REF });
    const proxied = await mediaRow(id);

    await request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ title: "Renamed Game", posterUrl: proxied.poster_url });
    const echoed = await mediaRow(id);
    expect(echoed.poster_url).toBe(proxied.poster_url);
    expect(echoed.local_poster_path).toBe(proxied.local_poster_path);
    expect(echoed.local_poster_token).toBe(proxied.local_poster_token);

    const res = await request(app)
      .patch(`/api/media/${id}`)
      .set("X-Api-Key", apiKey)
      .send({ posterUrl: "https://image.tmdb.org/t/p/w500/new.jpg", backdropUrl: null });

    expect(res.status).toBe(200);
    const after = await mediaRow(id);
    expect(after.poster_url).toBe("https://image.tmdb.org/t/p/w500/new.jpg");
    expect(after.local_poster_path).toBeNull();
    expect(after.local_poster_token).toBeNull();
    expect(after.backdrop_url).toBeNull();
    expect(after.local_backdrop_path).toBeNull();
    expect(after.local_backdrop_token).toBeNull();
    expect((await request(app).get(proxied.poster_url).set("X-Api-Key", apiKey)).status).toBe(404);
  });
});

describe("Mark as missing on an episode or sub-item", () => {
  async function insertEpisode(mediaItemId: number, episodeNumber: number): Promise<number> {
    const result = await db
      .prepare(
        `INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, file_path, quality, size_bytes, media_info)
         VALUES (?, 1, ?, 'Ep', 1, 1, ?, 'HDTV-720p', 734003200, ?)`
      )
      .run(mediaItemId, episodeNumber, `/tv/Show/S01E0${episodeNumber}.mkv`, JSON.stringify({ videoCodec: "h264" }));
    return Number(result.lastInsertRowid);
  }

  it("clears the episode's size and media info, and the show's has_file once its last episode file is gone", async () => {
    const showId = await insertItem("series", "Missing Show", { hasFile: 1 });
    const first = await insertEpisode(showId, 1);
    const second = await insertEpisode(showId, 2);

    const res = await request(app)
      .patch(`/api/media/${showId}/episodes/${first}`)
      .set("X-Api-Key", apiKey)
      .send({ hasFile: false, filePath: null, quality: null });

    expect(res.status).toBe(200);
    expect(Number(res.body.hasFile)).toBe(0);
    const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(first)) as any;
    expect(Number(ep.has_file)).toBe(0);
    expect(ep.size_bytes).toBeNull();
    expect(ep.media_info).toBeNull();
    expect(Number((await mediaRow(showId)).has_file)).toBe(1);

    await request(app).patch(`/api/media/${showId}/episodes/${second}`).set("X-Api-Key", apiKey).send({ hasFile: 0, filePath: null, quality: null });
    expect(Number((await mediaRow(showId)).has_file)).toBe(0);
  });

  it("never marks a single-file parent missing through a child", async () => {
    const itemId = await insertItem("series", "Parent With Own File", { hasFile: 1, path: "/tv/Parent/file.mkv" });
    const ep = await insertEpisode(itemId, 1);

    await request(app).patch(`/api/media/${itemId}/episodes/${ep}`).set("X-Api-Key", apiKey).send({ hasFile: 0 });

    expect(Number((await mediaRow(itemId)).has_file)).toBe(1);
  });

  it("accepts a JSON true for hasFile/monitored and leaves the size of a file that's still there alone", async () => {
    const showId = await insertItem("series", "Boolean Show", { hasFile: 1 });
    const ep = await insertEpisode(showId, 1);

    const res = await request(app).patch(`/api/media/${showId}/episodes/${ep}`).set("X-Api-Key", apiKey).send({ hasFile: true, monitored: false });

    expect(res.status).toBe(200);
    const row = (await db.prepare("SELECT has_file, monitored, size_bytes FROM episodes WHERE id = ?").get(ep)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(Number(row.monitored)).toBe(0);
    expect(Number(row.size_bytes)).toBe(734003200);
  });

  it("clears a sub-item's size and media info, and the parent's has_file once its last sub-item file is gone", async () => {
    const artistId = await insertItem("artist", "Missing Artist", { hasFile: 1 });
    const insertAlbum = async (title: string) =>
      Number(
        (
          await db
            .prepare(
              `INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path, size_bytes, media_info) VALUES (?, ?, 1, 1, ?, 52428800, ?)`
            )
            .run(artistId, title, `/music/Missing Artist/${title}`, JSON.stringify({ audioCodec: "flac" }))
        ).lastInsertRowid
      );
    const first = await insertAlbum("First Album");
    const second = await insertAlbum("Second Album");

    const res = await request(app)
      .patch(`/api/media/${artistId}/subitems/${first}`)
      .set("X-Api-Key", apiKey)
      .send({ hasFile: false, filePath: null, quality: null });

    expect(res.status).toBe(200);
    const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(first)) as any;
    expect(Number(sub.has_file)).toBe(0);
    expect(sub.size_bytes).toBeNull();
    expect(sub.media_info).toBeNull();
    expect(Number((await mediaRow(artistId)).has_file)).toBe(1);

    await request(app).patch(`/api/media/${artistId}/subitems/${second}`).set("X-Api-Key", apiKey).send({ hasFile: 0 });
    expect(Number((await mediaRow(artistId)).has_file)).toBe(0);
  });

  it("404s for an episode or sub-item under a different item, changing neither item", async () => {
    const showId = await insertItem("series", "Real Parent Show", { hasFile: 1 });
    const ep = await insertEpisode(showId, 1);
    const artistId = await insertItem("artist", "Real Parent Artist", { hasFile: 1 });
    const sub = Number(
      (
        await db
          .prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path, size_bytes) VALUES (?, 'Only Album', 1, 1, '/music/a', 100)`)
          .run(artistId)
      ).lastInsertRowid
    );
    const unrelatedId = await insertItem("series", "Unrelated Show", { hasFile: 1 });

    const epRes = await request(app).patch(`/api/media/${unrelatedId}/episodes/${ep}`).set("X-Api-Key", apiKey).send({ hasFile: 0 });
    const subRes = await request(app).patch(`/api/media/${unrelatedId}/subitems/${sub}`).set("X-Api-Key", apiKey).send({ hasFile: 0 });

    expect(epRes.status).toBe(404);
    expect(subRes.status).toBe(404);
    const epRow = (await db.prepare("SELECT has_file, size_bytes FROM episodes WHERE id = ?").get(ep)) as any;
    expect(Number(epRow.has_file)).toBe(1);
    expect(Number(epRow.size_bytes)).toBe(734003200);
    const subRow = (await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(sub)) as any;
    expect(Number(subRow.has_file)).toBe(1);
    expect(Number((await mediaRow(unrelatedId)).has_file)).toBe(1);
    expect(Number((await mediaRow(showId)).has_file)).toBe(1);
    expect(Number((await mediaRow(artistId)).has_file)).toBe(1);
  });
});

describe("POST /api/media/:id/check-corrupt", () => {
  async function flaggedMovie(): Promise<number> {
    corruptReason.mockReset().mockResolvedValue("ffprobe couldn't read this file (corrupt or unrecognized data)");
    return insertItem("movie", "Flagged Film", { hasFile: 1, path: "/movies/Flagged Film/Flagged Film.mkv" });
  }

  it("says nothing was moved when the file couldn't be moved to the recycle bin", async () => {
    const id = await flaggedMovie();
    handleCorrupt.mockReset().mockResolvedValue("failed");

    const res = await request(app).post(`/api/media/${id}/check-corrupt`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ corrupt: true, checked: true, action: "failed", queuedForReview: false });
    expect(res.body.message).toMatch(/recycle bin/i);
  });

  it("says nothing was moved when the file's storage is offline", async () => {
    const id = await flaggedMovie();
    handleCorrupt.mockReset().mockResolvedValue("unavailable");

    const res = await request(app).post(`/api/media/${id}/check-corrupt`).set("X-Api-Key", apiKey);

    expect(res.body).toMatchObject({ corrupt: true, checked: true, action: "unavailable", queuedForReview: false });
    expect(res.body.message).toMatch(/offline/i);
  });

  it("reports a file held for review as queued, with no message", async () => {
    const id = await flaggedMovie();
    handleCorrupt.mockReset().mockResolvedValue("queued");

    const res = await request(app).post(`/api/media/${id}/check-corrupt`).set("X-Api-Key", apiKey);

    expect(res.body).toMatchObject({ corrupt: true, action: "queued", queuedForReview: true, message: null });
  });
});

describe("POST /api/media/:id/subitems/:subItemId/convert-to-m4b", () => {
  async function insertAudiobook(): Promise<{ id: number; subId: number }> {
    const id = await insertItem("audiobook", "Convert Author");
    const subId = Number(
      (await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Long Book', 1, 1)`).run(id)).lastInsertRowid
    );
    return { id, subId };
  }

  it("409s while a conversion of the same audiobook is already running", async () => {
    const { M4bConversionInProgressError } = await import("../src/services/audiobookConvert.js");
    convertSubItemToM4b.mockReset().mockRejectedValue(new M4bConversionInProgressError());
    const { id, subId } = await insertAudiobook();

    const res = await request(app).post(`/api/media/${id}/subitems/${subId}/convert-to-m4b`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(409);
    expect(res.body.error ?? res.text).toMatch(/already being converted/);
  });

  it("still 400s for a conversion that fails", async () => {
    convertSubItemToM4b.mockReset().mockRejectedValue(new Error("No downloaded tracks to merge"));
    const { id, subId } = await insertAudiobook();

    const res = await request(app).post(`/api/media/${id}/subitems/${subId}/convert-to-m4b`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/media/bulk-import.csv", () => {
  it("reads TRUE/FALSE/yes/no monitored cells, and skips rows with an unreadable monitored or quality profile", async () => {
    const profileId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as any).id);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await insertItem("movie", `CSV Film ${i}`));
    await db.prepare("UPDATE media_items SET monitored = 0 WHERE id = ?").run(ids[0]);
    const csv = [
      "id,title,monitored,qualityProfileId",
      `${ids[0]},CSV Film 0, TRUE ,${profileId}`,
      `${ids[1]},CSV Film 1,no,`,
      `${ids[2]},CSV Film 2,maybe,`,
      `${ids[3]},CSV Film 3,1,abc`,
      `${ids[4]},CSV Film 4,1,999999`,
      `${ids[5]},CSV Film 5,,1.5`,
      `${ids[0]}.5,Fractional Id,0,`,
      "1e20,Huge Id,0,",
      "2147483648,Past Int Range,0,",
    ].join("\r\n");

    const res = await request(app)
      .post("/api/media/bulk-import.csv")
      .set("X-Api-Key", apiKey)
      .attach("file", Buffer.from(csv, "utf-8"), { filename: "library.csv", contentType: "text/csv" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, skipped: 7 });
    const rows = (await Promise.all(ids.map(mediaRow))) as any[];
    expect(Number(rows[0].monitored)).toBe(1);
    expect(Number(rows[0].quality_profile_id)).toBe(profileId);
    expect(Number(rows[1].monitored)).toBe(0);
    for (const row of rows.slice(2)) {
      expect(Number(row.monitored)).toBe(1);
      expect(row.quality_profile_id).toBeNull();
    }
  });
});

describe("POST /api/media/refresh", () => {
  it("logs an overlapping refresh as skipped rather than as a run that found nothing", async () => {
    const { log } = await import("../src/services/logger.js");
    const info = vi.spyOn(log, "info");
    refreshLibraryMetadata.mockReset().mockResolvedValue({ updated: 0, failed: 0, childrenAdded: 0, alreadyRunning: true });

    const res = await request(app).post("/api/media/refresh?type=movie").set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('[refresh] "movie": already running - skipped'));
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/^\[refresh\] "movie": updated/));
    info.mockRestore();
  });
});
