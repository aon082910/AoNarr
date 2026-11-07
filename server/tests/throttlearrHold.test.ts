import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";
import { DEFAULT_CLIENT_LIMITS, DEFAULT_SETTINGS } from "../src/services/throttlearr/settings.js";

// Phase 2 of Throttlearr: a grab to a limited client is held (status 'queued', gate_state 'held', no download id)
// instead of being sent, and nothing that sweeps the queue touches a held row.
const adapter = {
  addDownload: vi.fn(),
  getStatus: vi.fn(),
};
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: () => adapter,
}));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let status: typeof import("../src/services/clientStatus.js");
let gate: typeof import("../src/services/throttlearr/gate.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let mediaItemFromRow: (typeof import("../src/db/mappers.js"))["mediaItemFromRow"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  status = await import("../src/services/clientStatus.js");
  gate = await import("../src/services/throttlearr/gate.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ mediaItemFromRow } = await import("../src/db/mappers.js"));
});

let sent = 0;
beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  sent = 0;
  adapter.addDownload.mockReset();
  adapter.getStatus.mockReset();
  adapter.addDownload.mockImplementation(async () => ({ downloadId: `hash${++sent}` }));
  adapter.getStatus.mockResolvedValue([]);
  setGate({});
});

function setGate(over: Record<string, unknown>) {
  setSetting("throttlearr", JSON.stringify(over));
}

async function insertClient(name = "Seedbox"): Promise<DownloadClient> {
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, 'qbittorrent', 'dl.local', 8080, 1, 1)").run(name)).lastInsertRowid);
  return { id, name, type: "qbittorrent", host: "dl.local", port: 8080, useSsl: 0, username: null, password: null, apiKey: null, category: null, categoryByType: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1 } as DownloadClient;
}

let n = 0;
async function insertMovie(): Promise<number> {
  n++;
  return Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(`Film ${n}`, `film ${n}`)).lastInsertRowid);
}

const release = (title: string) => ({ indexerId: null, indexerName: "Idx", title, size: 1000, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=urn:btih:${title}`, protocol: "torrent", category: null }) as any;

async function grabMovie(client: DownloadClient, source: "auto" | "interactive" = "auto", options: { forced?: boolean } = {}) {
  const itemId = await insertMovie();
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  const chosen = { result: release(`Film.${itemId}.2020.1080p`), quality: "WEBDL-1080p" } as any;
  const ok = await scheduler.grab(client, mediaItemFromRow(item), null, null, chosen, 0, null, source, options);
  return { itemId, ok, item: mediaItemFromRow(item), chosen };
}

const rows = async () => (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
const held = async () => (await rows()).filter((r) => r.gate_state === "held");
const grabbedHistory = async () => Number(((await db.prepare("SELECT COUNT(*) AS c FROM history WHERE event_type = 'grabbed'").get()) as any).c);

describe("Throttlearr: holding a grab in grab()", () => {
  it("does nothing while the feature is off: every grab goes to the client", async () => {
    const client = await insertClient();
    setGate({ enabled: false, clients: { [client.id]: { maxActive: 1 } } });
    for (let i = 0; i < 4; i++) expect((await grabMovie(client)).ok).toBe(true);
    expect(adapter.addDownload).toHaveBeenCalledTimes(4);
    expect((await rows()).every((r) => r.gate_state === null && r.download_id)).toBe(true);
  });

  it("sends up to maxActive and holds the rest, with no history for a held grab", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 2 } } });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await grabMovie(client)).ok);

    expect(results).toEqual([true, true, true, true, true]); // a held grab is an accepted grab
    expect(adapter.addDownload).toHaveBeenCalledTimes(2);
    const h = await held();
    expect(h).toHaveLength(3);
    for (const r of h) {
      expect(r).toMatchObject({ status: "queued", download_id: null, download_client_id: client.id, gate_state: "held" });
      expect(r.gate_reason).toMatch(/Seedbox has 2 of 2 jobs|Waiting behind/);
      expect(r.gate_held_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      const payload = gate.parsePayload(r.gate_payload);
      expect(payload?.release.downloadUrl).toContain("magnet:");
      expect(payload?.quality).toBe("WEBDL-1080p");
      expect(payload?.history).toEqual({ episodeId: null, subItemId: null, seasonNumber: null });
    }
    expect(await grabbedHistory()).toBe(2); // only the two that were sent
  });

  it("counts a held grab as covering its target, so the target is not grabbed again", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    const second = await grabMovie(client); // held
    expect(await scheduler.isAlreadyQueued(second.itemId, null, null)).toBe(true);
    const again = await scheduler.grab(client, second.item, null, null, second.chosen, 0, null, "auto");
    expect(again).toBe(false);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(await held()).toHaveLength(1);
  });

  it("never jumps a new grab ahead of grabs already held, even when a slot has freed", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 2 } } });
    for (let i = 0; i < 3; i++) await grabMovie(client); // 2 sent, 1 held
    await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id = 'hash1'").run(); // one slot is free
    const next = await grabMovie(client);
    expect(next.ok).toBe(true);
    expect(adapter.addDownload).toHaveBeenCalledTimes(2); // not sent
    const h = await held();
    expect(h).toHaveLength(2);
    expect(h[1].gate_reason).toBe("Waiting behind 1 held grab");
  });

  it("lets a hand-picked or forced grab through, unless bypassManual is off", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    expect((await grabMovie(client, "interactive")).ok).toBe(true);
    expect((await grabMovie(client, "auto", { forced: true })).ok).toBe(true);
    expect(adapter.addDownload).toHaveBeenCalledTimes(3);

    setGate({ enabled: true, bypassManual: false, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client, "interactive");
    expect(adapter.addDownload).toHaveBeenCalledTimes(3);
    expect(await held()).toHaveLength(2);
  });

  it("dry run logs the hold and sends the grab", async () => {
    const client = await insertClient();
    setGate({ enabled: true, dryRun: true, clients: { [client.id]: { maxActive: 1 } } });
    for (let i = 0; i < 3; i++) await grabMovie(client);
    expect(adapter.addDownload).toHaveBeenCalledTimes(3);
    expect(await held()).toHaveLength(0);
  });

  it("leaves a client without limits alone, and holds everything with holdAll", async () => {
    const limited = await insertClient("Limited");
    const free = await insertClient("Free");
    setGate({ enabled: true, clients: { [limited.id]: { maxActive: 1 } } });
    for (let i = 0; i < 3; i++) await grabMovie(free);
    expect(adapter.addDownload).toHaveBeenCalledTimes(3);
    expect(await held()).toHaveLength(0);

    setGate({ enabled: true, holdAll: true });
    await grabMovie(free);
    expect(adapter.addDownload).toHaveBeenCalledTimes(3);
    expect((await held())[0].gate_reason).toBe("All grabs are being held");
  });

  it("never sends more than maxActive when many grabs arrive at once", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 3 } } });
    adapter.addDownload.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15)); // a slow client: the race window is wide
      return { downloadId: `hash${++sent}` };
    });
    await Promise.all(Array.from({ length: 10 }, () => grabMovie(client)));
    expect(adapter.addDownload).toHaveBeenCalledTimes(3);
    expect(await held()).toHaveLength(7);
  });

  it("keeps a held grab when the client call would have failed: it is not sent, so nothing can fail", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    adapter.addDownload.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await grabMovie(client)).ok).toBe(true);
    expect(await held()).toHaveLength(1);
  });

  it("still throws a client failure for a grab that is sent", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 5 } } });
    adapter.addDownload.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }));
    await expect(grabMovie(client)).rejects.toBeInstanceOf(scheduler.DownloadClientUnavailableError);
    expect(await rows()).toHaveLength(0);
  });
});

describe("Throttlearr: nothing that sweeps the queue touches a held row", () => {
  it("is left alone by the stalled and orphan sweeps after days, and the poller never asks the client about it", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    await db.prepare("UPDATE queue SET added_at = '2020-01-01 00:00:00', last_progress_at = NULL WHERE gate_state = 'held'").run();
    adapter.getStatus.mockResolvedValue([{ downloadId: "hash1", progress: 0.5, status: "downloading" }]);

    await scheduler.cleanupStalledDownloads();
    await scheduler.pollQueue();

    const h = await held();
    expect(h).toHaveLength(1);
    expect(h[0].status).toBe("queued");
    expect(h[0].client_state ?? null).toBeNull();
    expect(h[0].status_message ?? null).toBeNull();
    // Only the sent job's id was ever asked for.
    for (const call of adapter.getStatus.mock.calls) expect(call[1]).toEqual(["hash1"]);
  });

  it("notWaitingAtGate keeps rows that were never gated and rows already released", async () => {
    const client = await insertClient();
    const a = await insertMovie();
    const ins = (state: string | null, title: string) =>
      db.prepare("INSERT INTO queue (media_item_id, title, download_client_id, status, gate_state) VALUES (?, ?, ?, 'queued', ?)").run(a, title, client.id, state);
    await ins(null, "none");
    await ins("released", "released");
    await ins("held", "held");
    await ins("releasing", "releasing");
    const ok = ((await db.prepare(`SELECT title FROM queue WHERE ${gate.notWaitingAtGate()} ORDER BY title`).all()) as { title: string }[]).map((r) => r.title);
    expect(ok).toEqual(["none", "released"]);
  });

  it("is failed without blame when its client is deleted, so the target can be searched again", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    const res = await request(app as any).delete(`/api/download-clients/${client.id}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);
    expect((await rows()).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM blocklist").get()) as any).c)).toBe(0);
  });
});

describe("Throttlearr: evaluateHold", () => {
  const settings = (over: Record<string, unknown> = {}, limits: Record<string, unknown> = { maxActive: 2 }) =>
    ({
      ...DEFAULT_SETTINGS,
      enabled: true,
      clients: { "1": { ...DEFAULT_CLIENT_LIMITS, ...limits } },
      ...over,
    }) as any;
  const state = (active = 0) => ({ active, bytesLeft: null, addsLastHour: 0, freeBytes: null, titleActive: new Map<number, number>() });
  const base = { client: { id: 1, name: "C" }, source: "auto", forced: false, heldAhead: 0, candidate: { mediaItemId: 1, size: null, priorityClass: "movie" as const }, now: new Date() };

  it("holds only at the limit, or behind held grabs", async () => {
    expect(gate.evaluateHold({ ...base, settings: settings(), state: state(1) }).hold).toBe(false);
    expect(gate.evaluateHold({ ...base, settings: settings(), state: state(2) })).toEqual({ hold: true, reason: "C has 2 of 2 jobs" });
    expect(gate.evaluateHold({ ...base, settings: settings(), state: state(0), heldAhead: 3 })).toEqual({ hold: true, reason: "Waiting behind 3 held grabs" });
  });

  it("never holds when disabled, or for a client with no limit", async () => {
    expect(gate.evaluateHold({ ...base, settings: settings({ enabled: false }), state: state(99) }).hold).toBe(false);
    expect(gate.evaluateHold({ ...base, settings: settings({}, { maxActive: null }), state: state(99), heldAhead: 5 }).hold).toBe(false);
  });

  it("knows which clients need the lock", async () => {
    expect(gate.clientIsGated(settings(), 1)).toBe(true);
    expect(gate.clientIsGated(settings(), 2)).toBe(false);
    expect(gate.clientIsGated(settings({ holdAll: true }), 2)).toBe(true);
    expect(gate.clientIsGated(settings({ enabled: false }), 1)).toBe(false);
    // Any limit gates the client, not only the job count.
    expect(gate.clientIsGated(settings({}, { maxActive: null, addsPerHour: 60 }), 1)).toBe(true);
    expect(gate.clientIsGated(settings({}, { maxActive: null, windows: [{ days: [1], from: "01:00", to: "02:00" }] }), 1)).toBe(true);
  });
});
