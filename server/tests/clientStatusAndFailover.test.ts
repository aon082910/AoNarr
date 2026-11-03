import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let status: typeof import("../src/services/clientStatus.js");
let scheduler: typeof import("../src/services/scheduler.js");
let getHealthReport: (typeof import("../src/services/healthReport.js"))["getHealthReport"];
let clearHealthReportCache: (typeof import("../src/services/healthReport.js"))["clearHealthReportCache"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  status = await import("../src/services/clientStatus.js");
  scheduler = await import("../src/services/scheduler.js");
  ({ getHealthReport, clearHealthReportCache } = await import("../src/services/healthReport.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  clearHealthReportCache();
});

async function insertClient(over: Record<string, unknown> = {}): Promise<number> {
  const row = { name: "Client", type: "qbittorrent", host: "dl.local", port: 8080, enabled: 1, priority: 1, ...over };
  return Number(
    (
      await db
        .prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.name, row.type, row.host, row.port, row.enabled, row.priority)
    ).lastInsertRowid
  );
}

const c = (over: Partial<DownloadClient> & { id: number }): DownloadClient =>
  ({ name: `Client ${over.id}`, type: "qbittorrent", host: "h", port: 1, useSsl: 0, username: null, password: null, apiKey: null, category: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1, ...over }) as DownloadClient;

describe("the download client failure ladder (DL10)", () => {
  it("leaves a failed client alone for longer each time, and starts over once it answers", async () => {
    const id = await insertClient();
    const t0 = Date.now();
    expect(status.isClientBackedOff(id, t0)).toBe(false);

    await status.recordClientFailure(id, "ECONNREFUSED", t0);
    expect(status.isClientBackedOff(id, t0 + 30_000)).toBe(true);
    expect(status.isClientBackedOff(id, t0 + 61_000)).toBe(false); // level 1: one minute

    await status.recordClientFailure(id, "ECONNREFUSED", t0 + 61_000);
    expect(status.isClientBackedOff(id, t0 + 61_000 + 4 * 60_000)).toBe(true); // level 2: five minutes
    expect(status.isClientBackedOff(id, t0 + 61_000 + 6 * 60_000)).toBe(false);
    expect(status.clientFailureLevel(id)).toBe(2);

    await status.recordClientSuccess(id);
    expect(status.isClientBackedOff(id, t0 + 61_000 + 1_000)).toBe(false);
    expect(status.clientFailureLevel(id)).toBe(0);
    expect(await db.prepare("SELECT 1 AS ok FROM download_client_status WHERE client_id = ?").get(id)).toBeUndefined();
  });

  it("never waits longer than a day", async () => {
    const id = await insertClient();
    const twoDays = 2 * 24 * 60 * 60_000;
    // Each failure comes after the wait of the one before it has run out.
    for (let n = 0; n < 20; n++) await status.recordClientFailure(id, "down", n * twoDays);
    expect(status.clientBackoffUntil(id)).toBeNull(); // 'now' is far past the epoch-based wait
    const row = (await db.prepare("SELECT escalation_level, disabled_till FROM download_client_status WHERE client_id = ?").get(id)) as any;
    expect(Number(row.escalation_level)).toBe(status.CLIENT_BACKOFF_MINUTES.length - 1);
    expect(Date.parse(row.disabled_till)).toBe(19 * twoDays + 24 * 60 * 60_000);
  });

  it("counts the failures of one outage once, however many grabs fail while the client is already being left alone", async () => {
    const id = await insertClient();
    const t0 = Date.now();
    await status.recordClientFailure(id, "ECONNREFUSED", t0);
    const until = status.clientBackoffUntil(id, t0);
    await status.recordClientFailure(id, "ECONNRESET", t0 + 5_000);
    await status.recordClientFailure(id, "ECONNRESET", t0 + 10_000);
    expect(status.clientFailureLevel(id)).toBe(1);
    expect(status.clientBackoffUntil(id, t0)).toBe(until);
    const row = (await db.prepare("SELECT last_error FROM download_client_status WHERE client_id = ?").get(id)) as any;
    expect(row.last_error).toBe("ECONNRESET");
  });

  it("survives a restart", async () => {
    const id = await insertClient();
    await status.recordClientFailure(id, "timed out", Date.now() + 10 * 60_000);
    status.resetClientStatuses();
    expect(status.isClientBackedOff(id, Date.now() + 10 * 60_000)).toBe(false);
    await status.loadClientStatuses();
    expect(status.isClientBackedOff(id, Date.now() + 10 * 60_000 + 30_000)).toBe(true);
    expect(status.clientFailureLevel(id)).toBe(1);
  });

  it("shows in Health while the client is being left alone", async () => {
    const id = await insertClient({ name: "Seedbox" });
    await status.recordClientFailure(id, "ECONNREFUSED");
    clearHealthReportCache();
    const report = await getHealthReport({ refresh: true });
    const issue = report.issues.find((i) => i.source === `download-client-backoff:${id}`);
    expect(issue?.message).toMatch(/"Seedbox" is being left alone until .* after failing \(ECONNREFUSED\)/);
  });
});

describe("choosing among clients (DL10, DL14)", () => {
  it("prefers the lower priority number, and keeps the old order among equals", () => {
    const a = c({ id: 1, priority: 5 });
    const b = c({ id: 2, priority: 1 });
    const d = c({ id: 3, priority: 1, type: "transmission" });
    expect(scheduler.pickClientForProtocol([a, b, d], "torrent")?.id).toBe(2);
    expect(scheduler.pickClientForProtocol([a, d], "torrent")?.id).toBe(3);
    expect(scheduler.pickClientForProtocol([c({ id: 7 }), c({ id: 4 })], "torrent")?.id).toBe(4);
  });

  it("leaves out a client that is being left alone, unless asked to ignore that", async () => {
    const first = c({ id: await insertClient(), priority: 1 });
    const second = c({ id: await insertClient(), priority: 2 });
    await status.recordClientFailure(first.id, "down");
    expect(scheduler.pickClientForProtocol([first, second], "torrent")?.id).toBe(second.id);
    expect(scheduler.pickClientForProtocol([first], "torrent")).toBeNull();
    expect(scheduler.pickClientForProtocol([first], "torrent", { ignoreBackoff: true })?.id).toBe(first.id);
  });

  it("knows the new client types by protocol", () => {
    expect(scheduler.pickClientForProtocol([c({ id: 1, type: "nzbget" })], "usenet")?.type).toBe("nzbget");
    expect(scheduler.pickClientForProtocol([c({ id: 1, type: "nzbget" })], "torrent")).toBeNull();
    expect(scheduler.pickClientForProtocol([c({ id: 1, type: "deluge" })], "torrent")?.type).toBe("deluge");
    expect(scheduler.pickClientForProtocol([c({ id: 1, type: "transmission" })], "usenet")).toBeNull();
  });
});

describe("failover inside a grab (DL10)", () => {
  const release = (title: string) => ({ indexerId: 1, indexerName: "Idx", title, size: 1, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=${title}`, protocol: "torrent", category: null }) as any;
  const choose = async (remaining: any[]) => (remaining.length > 0 ? { result: remaining[0], quality: "WEBDL-1080p" } : null);

  it("sends the release to the next client of the protocol when the first is unreachable", async () => {
    const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Film', 'film', 1, 'missing')").run()).lastInsertRowid);
    const first = c({ id: await insertClient({ name: "Primary" }), name: "Primary", priority: 1 });
    const second = c({ id: await insertClient({ name: "Backup", priority: 2 }), name: "Backup", priority: 2 });
    const sentTo: string[] = [];
    const outcome = await scheduler.grabBestRelease(
      [release("Film.2020.1080p")],
      [first, second],
      choose,
      async (client) => {
        sentTo.push(client.name);
        if (client.id === first.id) throw new scheduler.DownloadClientUnavailableError(client, new Error("ECONNREFUSED"));
        return true;
      },
      { itemId }
    );
    expect(outcome?.client.name).toBe("Backup");
    expect(sentTo).toEqual(["Primary", "Backup"]);
    // The failed client is left alone from now on, and the failure is on file.
    expect(status.isClientBackedOff(first.id)).toBe(true);
    expect(scheduler.pickClientForProtocol([first, second], "torrent")?.id).toBe(second.id);
  });

  it("raises the failure only when every client of the protocol is unreachable", async () => {
    const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Film2', 'film2', 1, 'missing')").run()).lastInsertRowid);
    const first = c({ id: await insertClient(), priority: 1 });
    const second = c({ id: await insertClient(), priority: 2 });
    await expect(
      scheduler.grabBestRelease(
        [release("Film2.2020.1080p")],
        [first, second],
        choose,
        async (client) => {
          throw new scheduler.DownloadClientUnavailableError(client, new Error("down"));
        },
        { itemId }
      )
    ).rejects.toBeInstanceOf(scheduler.DownloadClientUnavailableError);
    expect(status.isClientBackedOff(first.id)).toBe(true);
    expect(status.isClientBackedOff(second.id)).toBe(true);
  });

  it("leaves a client alone that failed for an earlier grab of the same run", async () => {
    const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Film3', 'film3', 1, 'missing')").run()).lastInsertRowid);
    const only = c({ id: await insertClient({ name: "Seedbox" }), name: "Seedbox" });
    await status.recordClientFailure(only.id, "ECONNREFUSED");
    const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
    const { mediaItemFromRow } = await import("../src/db/mappers.js");
    const chosen = { result: release("Film3.2020.1080p"), quality: "WEBDL-1080p" } as any;
    // Not sent to the client at all (its host would not answer): refused at once as unavailable.
    await expect(scheduler.grab(only, mediaItemFromRow(item), null, null, chosen, 0, null, "auto")).rejects.toThrow(/Download client "Seedbox" is unavailable: it is being left alone/);
    expect(status.clientFailureLevel(only.id)).toBe(1);
  });

  it("explains a search that found a client waiting out its back-off", async () => {
    const only = c({ id: await insertClient({ name: "Seedbox" }), name: "Seedbox" });
    await status.recordClientFailure(only.id, "down");
    const why = scheduler.whyNothingGrabbed([release("x")], [only], [only], undefined);
    expect(why).toMatch(/"Seedbox" failed and is being left alone until \d\d:\d\d UTC/);
  });
});

describe("the client routes (DL10, DL14, DL22)", () => {
  const post = (body: unknown) => request(app as any).post("/api/download-clients").set("X-Api-Key", apiKey).send(body);
  const patch = (id: number, body: unknown) => request(app as any).patch(`/api/download-clients/${id}`).set("X-Api-Key", apiKey).send(body);

  it("stores a priority, a normalized URL base and a category per type", async () => {
    const res = await post({ name: "Q", type: "qbittorrent", host: "h", port: 8080, priority: 3, urlBase: "qbit/", categoryByType: { movie: "movies", artist: "music " } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ priority: 3, urlBase: "/qbit", categoryByType: { movie: "movies", artist: "music" } });
    const edited = await patch(res.body.id, { priority: 9, urlBase: "", categoryByType: null });
    expect(edited.body).toMatchObject({ priority: 9, urlBase: null, categoryByType: null });
  });

  it("refuses a priority out of range and a category for a type that does not exist", async () => {
    expect((await post({ name: "Q", type: "qbittorrent", host: "h", port: 1, priority: 0 })).status).toBe(400);
    expect((await post({ name: "Q", type: "qbittorrent", host: "h", port: 1, priority: 51 })).status).toBe(400);
    expect((await post({ name: "Q", type: "qbittorrent", host: "h", port: 1, categoryByType: { notatype: "x" } })).status).toBe(400);
    expect((await post({ name: "Q", type: "qbittorrent", host: "h", port: 1, categoryByType: [1] })).status).toBe(400);
  });

  it("wants a host and a port for the new client types", async () => {
    for (const type of ["nzbget", "transmission", "deluge"]) {
      expect((await post({ name: type, type })).status, type).toBe(400);
      expect((await post({ name: type, type, host: "h", port: 1 })).status, type).toBe(201);
    }
  });

  it("saving the client with a new address or login ends the wait it was serving", async () => {
    const created = await post({ name: "Q2", type: "qbittorrent", host: "old", port: 8080 });
    await status.recordClientFailure(created.body.id, "ECONNREFUSED");
    expect(status.isClientBackedOff(created.body.id)).toBe(true);
    await patch(created.body.id, { priority: 4 });
    expect(status.isClientBackedOff(created.body.id)).toBe(true); // a change that cannot fix the connection leaves it
    await patch(created.body.id, { host: "new" });
    expect(status.isClientBackedOff(created.body.id)).toBe(false);
  });

  it("a successful test ends the wait the client was serving", async () => {
    const created = await post({ name: "Blackhole", type: "http" });
    expect(created.status).toBe(201);
    await status.recordClientFailure(created.body.id, "down");
    expect(status.isClientBackedOff(created.body.id)).toBe(true);
    const tested = await request(app as any).post(`/api/download-clients/${created.body.id}/test`).set("X-Api-Key", apiKey).send({});
    expect(tested.body.ok).toBe(true);
    expect(status.isClientBackedOff(created.body.id)).toBe(false);
  });
});

describe("history of what happened to a download or a file (DL17)", () => {
  async function queueRow(extra: Record<string, unknown> = {}) {
    const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('series', 'Show', 'show', 1, 'missing')").run()).lastInsertRowid);
    const episodeId = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, auto_search_misses) VALUES (?, 1, 1, 'Pilot', 1, 5)").run(itemId)).lastInsertRowid);
    const clientId = await insertClient();
    const result = await db
      .prepare(
        "INSERT INTO queue (media_item_id, episode_id, title, indexer_id, download_client_id, download_id, size, status, protocol, grab_source) VALUES (?, ?, 'Show.S01E01.1080p-GRP', NULL, ?, 'abc123', 1234, 'downloading', 'torrent', 'auto')"
      )
      .run(itemId, episodeId, clientId);
    return { itemId, episodeId, clientId, queueId: Number(result.lastInsertRowid), ...extra };
  }
  const missesOf = async (episodeId: number) => Number(((await db.prepare("SELECT auto_search_misses FROM episodes WHERE id = ?").get(episodeId)) as any).auto_search_misses);

  it("removing a download writes a 'removed' row that carries its download id, and blocklisting wakes the search", async () => {
    const q = await queueRow();
    const res = await request(app as any).delete(`/api/activity/queue/${q.queueId}?blocklist=1&removeFromClient=0`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);
    const row = (await db.prepare("SELECT event_type, data, episode_id FROM history WHERE media_item_id = ?").get(q.itemId)) as any;
    expect(row.event_type).toBe("removed");
    expect(Number(row.episode_id)).toBe(q.episodeId);
    expect(JSON.parse(row.data)).toMatchObject({ releaseTitle: "Show.S01E01.1080p-GRP", downloadId: "abc123", clientId: q.clientId, size: 1234, blocklisted: true, removedFromClient: false });
    expect(await missesOf(q.episodeId)).toBe(0);
  });

  it("blocklisting one episode wakes that episode and leaves the rest of the show waiting", async () => {
    const q = await queueRow();
    const sibling = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, auto_search_misses) VALUES (?, 1, 2, 'Second', 1, 5)").run(q.itemId)).lastInsertRowid);
    await db.prepare("INSERT INTO season_searches (media_item_id, season_number, misses) VALUES (?, 1, 3)").run(q.itemId);
    await request(app as any).delete(`/api/activity/queue/${q.queueId}?blocklist=1&removeFromClient=0`).set("X-Api-Key", apiKey);
    expect(await missesOf(q.episodeId)).toBe(0);
    expect(await missesOf(sibling)).toBe(5);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS n FROM season_searches WHERE media_item_id = ?").get(q.itemId)) as any).n)).toBe(1);
  });

  it("skipRedownload leaves the search wait alone, and a plain removal does not touch it", async () => {
    const first = await queueRow();
    await request(app as any).delete(`/api/activity/queue/${first.queueId}?blocklist=1&removeFromClient=0&skipRedownload=1`).set("X-Api-Key", apiKey);
    expect(await missesOf(first.episodeId)).toBe(5);
    const second = await queueRow();
    await request(app as any).delete(`/api/activity/queue/${second.queueId}?removeFromClient=0`).set("X-Api-Key", apiKey);
    expect(await missesOf(second.episodeId)).toBe(5);
  });

  it("a failed download's row names its client, indexer and download id", async () => {
    const q = await queueRow();
    const match = {
      id: q.queueId,
      mediaItemId: q.itemId,
      episodeId: q.episodeId,
      subItemId: null,
      title: "Show.S01E01.1080p-GRP",
      downloadId: "abc123",
      downloadClientId: q.clientId,
      indexerId: null,
      size: 1234,
      downloadPath: null,
      retryCount: 0,
      protocol: "torrent",
      grabSource: "auto",
    } as any;
    setSetting("failedDownloadBehavior", "blocklistOnly");
    await scheduler.retryFailedGrab(match, "corrupt");
    const row = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'failed'").get(q.itemId)) as any;
    expect(JSON.parse(row.data)).toMatchObject({ title: "Show.S01E01.1080p-GRP", reason: "corrupt", downloadId: "abc123", clientId: q.clientId, size: 1234 });
    setSetting("failedDownloadBehavior", "");
  });

  it("a file deleted by an admin leaves a 'deleted' row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-r27-del-"));
    const rootId = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(dir)).lastInsertRowid);
    const file = path.join(dir, "Film (2020)", "Film (2020).mkv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, path, status, root_folder_id) VALUES ('movie', 'Film', 'film', 2020, 1, 1, ?, 'downloaded', ?)").run(file, rootId)).lastInsertRowid
    );
    const res = await request(app as any).delete(`/api/media/${id}/file`).set("X-Api-Key", apiKey);
    expect(res.status).toBeLessThan(300);
    const row = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'deleted'").get(id)) as any;
    expect(JSON.parse(row.data)).toMatchObject({ fileName: "Film (2020).mkv", reason: "Deleted by an admin" });
    await db.prepare("DELETE FROM root_folders WHERE id = ?").run(rootId);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("what a household account sees of a history row (DL17)", () => {
  it("keeps the facts of the download and the library paths for the admin", async () => {
    const { redactHistoryData } = await import("../src/routes/media.js");
    const data = JSON.stringify({
      releaseTitle: "Show.S01E01.1080p-GRP",
      size: 1234,
      downloadId: "abc123",
      clientId: 4,
      indexerId: 2,
      sourcePath: "/downloads/complete/Show.S01E01",
      from: "/tv/Show/old.mkv",
      to: "/tv/Show/new.mkv",
      path: "/tv/Show/gone.mkv",
      downloadUrl: "https://idx.example.com/dl?apikey=secret",
    });
    expect(JSON.parse(redactHistoryData(data)!)).toEqual({ releaseTitle: "Show.S01E01.1080p-GRP", size: 1234 });
  });
});
