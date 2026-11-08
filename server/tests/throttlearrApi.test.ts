import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

// Phase 7 of Throttlearr, server side: the settings and status routes, the actions on a held grab, health, system counts.
const fake = { active: new Set<string>() };
const adapter: any = { addDownload: vi.fn(), getStatus: vi.fn(), queueLoad: vi.fn() };
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: () => adapter,
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let scheduler: typeof import("../src/services/scheduler.js");
let status: typeof import("../src/services/clientStatus.js");
let actions: typeof import("../src/services/throttlearr/actions.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let mediaItemFromRow: (typeof import("../src/db/mappers.js"))["mediaItemFromRow"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  status = await import("../src/services/clientStatus.js");
  actions = await import("../src/services/throttlearr/actions.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ mediaItemFromRow } = await import("../src/db/mappers.js"));
});

let sent = 0;
beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  sent = 0;
  fake.active.clear();
  adapter.addDownload.mockReset();
  adapter.getStatus.mockReset();
  adapter.queueLoad = vi.fn(async () => ({ active: fake.active.size, bytesLeft: null }));
  adapter.addDownload.mockImplementation(async () => {
    const id = `hash${++sent}`;
    fake.active.add(id);
    return { downloadId: id };
  });
  adapter.getStatus.mockResolvedValue([]);
  setSetting("throttlearr", JSON.stringify({}));
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);
const get = (url: string) => authed(request(app).get(url));
const post = (url: string, body: unknown = {}) => authed(request(app).post(url)).send(body as object);
const put = (url: string, body: unknown) => authed(request(app).put(url)).send(body as object);
const setGate = (over: Record<string, unknown>) => setSetting("throttlearr", JSON.stringify(over));

async function insertClient(name = "Seedbox"): Promise<DownloadClient> {
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, 'qbittorrent', 'dl.local', 8080, 1, 1)").run(name)).lastInsertRowid);
  return { id, name, type: "qbittorrent", host: "dl.local", port: 8080, useSsl: 0, username: null, password: null, apiKey: null, category: null, categoryByType: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1 } as DownloadClient;
}

let n = 0;
async function grabMovie(client: DownloadClient) {
  n++;
  const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(`Api ${n}`, `api ${n}`)).lastInsertRowid);
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  const result = { indexerId: null, indexerName: "Idx", title: `Api.${itemId}.2020.1080p`, size: 1000, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=urn:btih:${itemId}`, protocol: "torrent", category: null } as any;
  await scheduler.grab(client, mediaItemFromRow(item), null, null, { result, quality: "WEBDL-1080p" } as any, 0, null, "auto");
  return itemId;
}

const rows = async () => (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
const heldRows = async () => (await rows()).filter((r) => r.gate_state === "held");

describe("Throttlearr: settings and status routes", () => {
  it("returns the defaults, then saves what it is given after validating it", async () => {
    const first = await get("/api/throttlearr/settings");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ enabled: false, dryRun: false, holdAll: false, maxHeldAgeHours: 72 });

    const saved = await put("/api/throttlearr/settings", { ...first.body, enabled: true, maxHeldAgeHours: 99999, clients: { "7": { maxActive: 3 } } });
    expect(saved.status).toBe(200);
    expect(saved.body.enabled).toBe(true);
    expect(saved.body.maxHeldAgeHours).toBe(720); // clamped
    expect(saved.body.clients["7"].maxActive).toBe(3);
    expect((await get("/api/throttlearr/settings")).body.clients["7"].maxActive).toBe(3);
  });

  it("refuses a body that is not an object, and needs an admin", async () => {
    expect((await put("/api/throttlearr/settings", [1, 2])).status).toBe(400);
    expect((await request(app).get("/api/throttlearr/settings")).status).toBe(401);
    expect((await request(app).get("/api/throttlearr/status")).status).toBe(401);
  });

  it("says per client how many grabs are held, since when, and how busy the client is", async () => {
    const client = await insertClient();
    const other = await insertClient("Idle box");
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await grabMovie(client);

    const body = (await get("/api/throttlearr/status")).body;
    expect(body).toMatchObject({ enabled: true, held: 2 });
    const mine = body.clients.find((c: any) => c.id === client.id);
    expect(mine).toMatchObject({ name: "Seedbox", limited: true, held: 2, active: 1, source: "client" });
    expect(mine.oldestHeldAt).toMatch(/^\d{4}-\d\d-\d\d/);
    expect(body.clients.find((c: any) => c.id === other.id)).toMatchObject({ limited: false, held: 0, active: null });
  });
});

describe("Throttlearr: actions on a held grab", () => {
  it("shows the gate fields in the queue list for a held grab, and none for a sent one", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    const items = (await get("/api/activity/queue")).body.items as any[];
    const sentRow = items.find((i) => i.downloadId);
    const heldRow = items.find((i) => !i.downloadId);
    expect(sentRow.gateState).toBeUndefined();
    expect(heldRow).toMatchObject({ gateState: "held", gateClass: "movie", status: "queued" });
    expect(heldRow.gateReason).toMatch(/Seedbox has 1 of 1 jobs/);
    expect(heldRow.gateHeldAt).toMatch(/^\d{4}-\d\d-\d\d/);
  });

  it("moves a held grab to the top of its client, and back", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await grabMovie(client);
    const [first, second] = await heldRows();
    expect(Number(first.gate_priority)).toBe(Number(second.gate_priority));

    expect((await post(`/api/activity/queue/${second.id}/priority`, { priority: "top" })).status).toBe(200);
    const after = await heldRows();
    expect(Number(after[1].gate_priority)).toBeGreaterThan(Number(after[0].gate_priority));

    expect((await post(`/api/activity/queue/${second.id}/priority`, { priority: "normal" })).status).toBe(200);
    expect(Number((await heldRows())[1].gate_priority)).toBe(Number(first.gate_priority));
  });

  it("moves the top grab ahead in the real order of release", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await grabMovie(client);
    const [, second] = await heldRows();
    await post(`/api/activity/queue/${second.id}/priority`, { priority: "top" });
    fake.active.clear(); // the first download finishes
    await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id IS NOT NULL").run();
    const release = await import("../src/services/throttlearr/release.js");
    await release.releaseHeldGrabs();
    expect((await rows()).find((r) => r.id === second.id)?.gate_state).toBe("released");
    expect((await heldRows()).map((r) => r.id)).not.toContain(second.id);
  });

  it("releases a held grab now, over the client's limit, and writes its history", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    const itemId = await grabMovie(client);
    const [held] = await heldRows();

    const res = await post(`/api/activity/queue/${held.id}/release-now`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, released: true });
    expect(fake.active.size).toBe(2); // over the limit of 1, on purpose
    const row = (await rows()).find((r) => r.id === held.id);
    expect(row).toMatchObject({ gate_state: "released", download_id: "hash2" });
    const events = (await db.prepare("SELECT event_type FROM history WHERE media_item_id = ? ORDER BY id").all(itemId)) as any[];
    expect(events.map((e) => e.event_type)).toEqual(["held", "grabbed"]);
  });

  it("refuses to release or move a grab that is not held, and keeps one whose client is down", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    const [sentRow] = (await rows()).filter((r) => r.gate_state === null);
    expect((await post(`/api/activity/queue/${sentRow.id}/release-now`)).status).toBe(409);
    expect((await post(`/api/activity/queue/99999/release-now`)).status).toBe(409);

    const [held] = await heldRows();
    adapter.addDownload.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect((await post(`/api/activity/queue/${held.id}/release-now`)).status).toBe(503);
    expect((await heldRows()).map((r) => r.id)).toContain(held.id);
  });

  it("removes a held grab like any queue row, with nothing to remove at the client", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    const [held] = await heldRows();
    adapter.removeDownload = vi.fn();
    const res = await authed(request(app).delete(`/api/activity/queue/${held.id}`));
    expect(res.status).toBe(204);
    expect(adapter.removeDownload).not.toHaveBeenCalled();
    expect(await heldRows()).toHaveLength(0);
  });
});

describe("Throttlearr: health and system counts", () => {
  it("has nothing to say while nothing is held", async () => {
    setGate({ enabled: true });
    expect(await actions.throttlearrIssues()).toEqual([]);
  });

  it("warns about grabs held for more than half the age limit, and about hold-everything", async () => {
    const client = await insertClient();
    setGate({ enabled: true, maxHeldAgeHours: 24, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    expect((await actions.throttlearrIssues()).find((i) => i.source === "throttlearr-old-held")).toBeUndefined();

    const ago = new Date(Date.now() - 13 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    await db.prepare("UPDATE queue SET gate_held_at = ? WHERE gate_state = 'held'").run(ago);
    const issue = (await actions.throttlearrIssues()).find((i) => i.source === "throttlearr-old-held");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toMatch(/1 grab has been held by Throttlearr for more than 12 hours/);

    setGate({ enabled: true, holdAll: true });
    expect((await actions.throttlearrIssues()).some((i) => i.source === "throttlearr-hold-all")).toBe(true);
  });

  it("warns when the release job is not scheduled while grabs are held (a test process never schedules it)", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    const issue = (await actions.throttlearrIssues()).find((i) => i.source === "throttlearr-job");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toMatch(/1 grab is held by Throttlearr but its release job/);
  });

  it("counts held grabs apart from the queue in the system status", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await grabMovie(client);
    const body = (await get("/api/system/status")).body;
    expect(body.queueCount).toBe(1);
    expect(body.heldCount).toBe(2);
  });
});
