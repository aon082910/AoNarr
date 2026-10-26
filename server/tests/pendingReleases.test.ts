import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const grab = vi.fn(async () => true);
vi.mock("../src/services/scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/scheduler.js")>();
  return { ...actual, grab: (...args: unknown[]) => grab(...(args as [])) };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let store: typeof import("../src/services/pendingStore.js");
let job: typeof import("../src/services/pendingReleases.js");
let sched: typeof import("../src/services/scheduler.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  store = await import("../src/services/pendingStore.js");
  job = await import("../src/services/pendingReleases.js");
  sched = await import("../src/services/scheduler.js");
  const { loadQualityCaches } = await import("../src/services/quality.js");
  await loadQualityCaches();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
let n = 0;
const release = (over: Record<string, unknown> = {}): any => ({
  indexerId: null,
  indexerName: "Test",
  title: `Pending.Movie.2020.1080p.WEB-DL.x264-GRP${++n}`,
  size: 4_000_000_000,
  seeders: 50,
  leechers: 1,
  publishDate: ago(10),
  downloadUrl: `magnet:?xt=urn:btih:pending${n}`,
  protocol: "torrent",
  category: null,
  ...over,
});

async function movie(title = `Pending Movie ${++n}`): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES ('movie', ?, ?, 2020, 1, 0, 'unknown')").run(title, title.toLowerCase()))
      .lastInsertRowid
  );
}

async function delayProfile(torrentMinutes: number): Promise<void> {
  await db.prepare("DELETE FROM delay_profiles").run();
  await db.prepare("INSERT INTO delay_profiles (enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes) VALUES (1, 1, 0, ?)").run(torrentMinutes);
}

beforeEach(async () => {
  grab.mockClear();
  await db.prepare("DELETE FROM pending_releases").run();
  await db.prepare("DELETE FROM download_clients").run();
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('qBit', 'qbittorrent', 1)").run();
});

describe("pending store", () => {
  it("keeps a release once per target and forgets it on request", async () => {
    const id = await movie();
    const r = release();
    await store.recordPending("media_items", id, id, r);
    await store.recordPending("media_items", id, id, r);
    const rows = await store.loadPending();
    expect(rows).toHaveLength(1);
    expect(rows[0].release.title).toBe(r.title);
    await store.clearPendingFor("media_items", id);
    expect(await store.loadPending()).toHaveLength(0);
  });

  it("expires a release a week after it was first seen", () => {
    expect(store.pendingExpired(new Date(Date.now() - 8 * 86_400_000).toISOString())).toBe(true);
    expect(store.pendingExpired("2999-01-01 00:00:00")).toBe(false);
    expect(store.pendingExpired(new Date().toISOString())).toBe(false);
  });
});

describe("runPendingReleases", () => {
  it("grabs a saved release once its delay has run out, and drops it", async () => {
    await delayProfile(120);
    const id = await movie();
    const r = release({ publishDate: ago(130) });
    await store.recordPending("media_items", id, id, r);

    const result = await job.runPendingReleases();

    expect(result).toEqual({ checked: 1, grabbed: 1 });
    expect(grab).toHaveBeenCalledTimes(1);
    expect(await store.loadPending()).toHaveLength(0);
  });

  it("keeps a release that is still inside its delay", async () => {
    await delayProfile(120);
    const id = await movie();
    await store.recordPending("media_items", id, id, release({ publishDate: ago(30) }));

    const result = await job.runPendingReleases();

    expect(result.grabbed).toBe(0);
    expect(grab).not.toHaveBeenCalled();
    expect(await store.loadPending()).toHaveLength(1);
  });

  it("drops a release whose target now has a file, or that is queued, or whose delay profile is gone", async () => {
    await delayProfile(120);
    const withFile = await movie();
    await db.prepare("UPDATE media_items SET has_file = 1 WHERE id = ?").run(withFile);
    const queued = await movie();
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'already', 'queued')").run(queued);
    await store.recordPending("media_items", withFile, withFile, release({ publishDate: ago(300) }));
    await store.recordPending("media_items", queued, queued, release({ publishDate: ago(300) }));

    await job.runPendingReleases();
    expect(grab).not.toHaveBeenCalled();
    expect(await store.loadPending()).toHaveLength(0);

    const free = await movie();
    await store.recordPending("media_items", free, free, release({ publishDate: ago(30) }));
    await db.prepare("DELETE FROM delay_profiles").run();
    await job.runPendingReleases();
    expect(await store.loadPending()).toHaveLength(0);
  });

  it("is saved by a search the delay profile held back", async () => {
    // isHeldByDelay hands the release that would have been grabbed to the store.
    const young = release({ publishDate: ago(30) });
    const choose = async (remaining: any[], delay: unknown) => (delay ? null : { result: remaining[0], quality: "WEBDL-1080p" });
    const kept: any[] = [];
    const held = await sched.isHeldByDelay([young], "WEBDL-1080p", { preferredProtocol: "none" } as any, choose as any, async (r) => {
      kept.push(r);
    });
    expect(held).toBe(true);
    expect(kept).toEqual([young]);
  });
});
