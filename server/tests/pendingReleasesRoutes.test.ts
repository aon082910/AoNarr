import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let recordPending: (typeof import("../src/services/pendingStore.js"))["recordPending"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ recordPending } = await import("../src/services/pendingStore.js"));
});

beforeEach(async () => {
  for (const t of ["pending_releases", "history", "queue", "episodes", "sub_items", "media_items", "download_clients", "delay_profiles"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  getDownloadClientAdapter.mockReset().mockReturnValue({
    addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: url })),
    getStatus: vi.fn(async () => []),
  });
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

function release(overrides: Record<string, unknown> = {}) {
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title: "Show.S01E02.1080p.WEB-DL-GRP",
    size: 2_000_000_000,
    seeders: 20,
    leechers: 1,
    publishDate: new Date(Date.now() - 30 * 60_000).toISOString(),
    downloadUrl: "http://indexer.invalid/dl?apikey=SECRETKEY",
    protocol: "usenet",
    category: null,
    ...overrides,
  } as any;
}

async function setup() {
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('SAB', 'sabnzbd', 1)").run();
  const show = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Show', 'show', 1, 0, 'missing')").run()).lastInsertRowid);
  const ep = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, 2, 'Second', '2020-01-08', 1, 0)").run(show)).lastInsertRowid);
  return { show, ep };
}

describe("GET /api/activity/pending (SR5)", () => {
  it("lists a held release with its target, why it is held and when the delay ends, without its download link", async () => {
    const { show, ep } = await setup();
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes, torrent_delay_minutes) VALUES (NULL, 120, 240)").run();
    await recordPending("episodes", ep, show, release());

    const res = await authed(request(app).get("/api/activity/pending"));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const [item] = res.body.items;
    expect(item).toMatchObject({ mediaTitle: "Show", mediaType: "series", target: "S01E02 Second", reason: "delay", delayMinutes: 120 });
    expect(item.readyInMinutes).toBeGreaterThanOrEqual(88);
    expect(item.readyInMinutes).toBeLessThanOrEqual(90);
    expect(item.release).toMatchObject({ title: "Show.S01E02.1080p.WEB-DL-GRP", protocol: "usenet", quality: "WEBDL-1080p" });
    expect(JSON.stringify(res.body)).not.toContain("SECRETKEY");
    expect(Date.parse(item.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("is empty when nothing is held", async () => {
    const res = await authed(request(app).get("/api/activity/pending"));
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it("says nothing about a time for a release with no publish date", async () => {
    const { show, ep } = await setup();
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes) VALUES (NULL, 120)").run();
    await recordPending("episodes", ep, show, release({ publishDate: null }));

    const res = await authed(request(app).get("/api/activity/pending"));

    expect(res.body.items[0].readyInMinutes).toBeNull();
  });
});

describe("POST /api/activity/pending/:id/grab and DELETE (SR5)", () => {
  async function heldId(): Promise<{ id: number; show: number; ep: number }> {
    const { show, ep } = await setup();
    await recordPending("episodes", ep, show, release());
    const row = (await db.prepare("SELECT id FROM pending_releases").get()) as { id: number };
    return { id: Number(row.id), show, ep };
  }

  it("grabs the held release now for its episode, as a manual grab, and forgets it", async () => {
    const { id, show, ep } = await heldId();

    const res = await authed(request(app).post(`/api/activity/pending/${id}/grab`));

    expect(res.status).toBe(201);
    const queued = (await db.prepare("SELECT episode_id, grab_source, title FROM queue WHERE media_item_id = ?").get(show)) as any;
    expect(Number(queued.episode_id)).toBe(ep);
    expect(queued.grab_source).toBe("interactive");
    expect(await db.prepare("SELECT 1 FROM pending_releases WHERE id = ?").get(id)).toBeFalsy();
  });

  it("keeps the release waiting when the grab is refused", async () => {
    const { id } = await heldId();
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn(async () => {
        throw new Error("404 not found");
      }),
      getStatus: vi.fn(async () => []),
    });

    const res = await authed(request(app).post(`/api/activity/pending/${id}/grab`));

    expect(res.status).toBe(502);
    expect(await db.prepare("SELECT 1 FROM pending_releases WHERE id = ?").get(id)).toBeTruthy();
  });

  it("forgets a held release on delete", async () => {
    const { id } = await heldId();

    await authed(request(app).delete(`/api/activity/pending/${id}`)).expect(204);

    expect(await db.prepare("SELECT 1 FROM pending_releases WHERE id = ?").get(id)).toBeFalsy();
  });

  it("answers 404 for a release that is not waiting", async () => {
    await authed(request(app).post("/api/activity/pending/99999/grab")).expect(404);
    await authed(request(app).delete("/api/activity/pending/99999")).expect(404);
  });
});

describe("GET /api/activity/pending does not ask the database more per held release (round 30c)", () => {
  async function countQueries(fn: () => Promise<void>): Promise<number> {
    const { initDb } = await import("../src/db/index.js");
    const instance = await initDb();
    const spy = vi.spyOn(instance, "prepare");
    try {
      await fn();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  async function holdEpisodes(count: number): Promise<void> {
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes, torrent_delay_minutes) VALUES (NULL, 120, 240)").run();
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES (?)").run(`held-tag-${count}-${Date.now()}`)).lastInsertRowid);
    const shows: number[] = [];
    for (let s = 0; s < Math.min(count, 6); s++) {
      const show = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', ?, ?, 1, 0, 'missing')").run(`Show ${s}`, `show ${s}`)).lastInsertRowid);
      await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(show, tagId);
      shows.push(show);
    }
    for (let i = 0; i < count; i++) {
      const show = shows[i % shows.length];
      const ep = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 1, ?, 'Held', '2020-01-08', 1, 0)").run(show, i + 1)).lastInsertRowid);
      await recordPending("episodes", ep, show, release({ title: `Show.S01E${String(i + 1).padStart(2, "0")}.1080p.WEB-DL-GRP`, downloadUrl: `http://indexer.invalid/dl/${i}` }));
    }
  }

  it("asks the same number of questions for 1 held release as for 30", async () => {
    await db.prepare("DELETE FROM media_item_tags").run();
    await holdEpisodes(1);
    const one = await countQueries(async () => {
      const res = await authed(request(app).get("/api/activity/pending"));
      expect(res.body.total).toBe(1);
    });

    for (const t of ["pending_releases", "episodes", "media_items", "delay_profiles"]) await db.prepare(`DELETE FROM ${t}`).run();
    await db.prepare("DELETE FROM media_item_tags").run();
    await holdEpisodes(30);
    const thirty = await countQueries(async () => {
      const res = await authed(request(app).get("/api/activity/pending"));
      expect(res.body.total).toBe(30);
      expect(res.body.items.every((i: any) => i.target && i.mediaTitle && i.delayMinutes === 120)).toBe(true);
    });

    expect(thirty).toBe(one);
  });
});

describe("Forget on a held release sticks (round 30c)", () => {
  const forgottenCount = async () => Number(((await db.prepare("SELECT COUNT(*) AS c FROM forgotten_releases").get()) as { c: number }).c);
  const pendingCount = async () => Number(((await db.prepare("SELECT COUNT(*) AS c FROM pending_releases").get()) as { c: number }).c);

  beforeEach(async () => {
    await db.prepare("DELETE FROM forgotten_releases").run();
  });

  it("is not held again by the next search while the delay would still have been running", async () => {
    const { show, ep } = await setup();
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes) VALUES (NULL, 120)").run();
    await recordPending("episodes", ep, show, release());
    const id = Number(((await db.prepare("SELECT id FROM pending_releases").get()) as { id: number }).id);

    await authed(request(app).delete(`/api/activity/pending/${id}`)).expect(204);
    expect(await pendingCount()).toBe(0);

    // The next search finds the same release and the delay profile holds it again.
    await recordPending("episodes", ep, show, release());
    expect(await pendingCount()).toBe(0);
    // Another release of the same episode is still held.
    await recordPending("episodes", ep, show, release({ downloadUrl: "http://indexer.invalid/dl?other=1" }));
    expect(await pendingCount()).toBe(1);
  });

  it("keeps a hash of the link, never the link, for the delay window plus a day", async () => {
    const { show, ep } = await setup();
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes) VALUES (NULL, 120)").run();
    await recordPending("episodes", ep, show, release());
    const id = Number(((await db.prepare("SELECT id FROM pending_releases").get()) as { id: number }).id);

    await authed(request(app).delete(`/api/activity/pending/${id}`)).expect(204);

    const row = (await db.prepare("SELECT * FROM forgotten_releases").get()) as any;
    expect(JSON.stringify(row)).not.toContain("SECRETKEY");
    expect(Number(row.media_item_id)).toBe(show);
    const expires = Date.parse(`${String(row.expires_at).replace(" ", "T")}Z`);
    const expected = Date.now() + 120 * 60_000 + 86_400_000;
    expect(Math.abs(expires - expected)).toBeLessThan(2 * 60_000);
  });

  it("holds the release again once the time has passed, and the pending job prunes the old note", async () => {
    const { show, ep } = await setup();
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes) VALUES (NULL, 120)").run();
    await recordPending("episodes", ep, show, release());
    const id = Number(((await db.prepare("SELECT id FROM pending_releases").get()) as { id: number }).id);
    await authed(request(app).delete(`/api/activity/pending/${id}`)).expect(204);
    await db.prepare("UPDATE forgotten_releases SET expires_at = '2000-01-01 00:00:00'").run();

    await recordPending("episodes", ep, show, release());
    expect(await pendingCount()).toBe(1);

    const { runPendingReleases } = await import("../src/services/pendingReleases.js");
    await runPendingReleases();
    expect(await forgottenCount()).toBe(0);
  });

  it("is dropped with its title", async () => {
    const { show, ep } = await setup();
    await recordPending("episodes", ep, show, release());
    const id = Number(((await db.prepare("SELECT id FROM pending_releases").get()) as { id: number }).id);
    await authed(request(app).delete(`/api/activity/pending/${id}`)).expect(204);
    expect(await forgottenCount()).toBe(1);

    await db.prepare("DELETE FROM media_items WHERE id = ?").run(show);

    expect(await forgottenCount()).toBe(0);
  });
});
