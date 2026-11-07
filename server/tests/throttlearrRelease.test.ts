import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";
import { qbittorrentQueueLoad, sabnzbdQueueLoad } from "../src/services/downloadClient.js";

// Phase 3 of Throttlearr: the release worker sends held grabs as the download client has room.
const fake = { active: new Set<string>(), maxSeen: 0 };
const adapter: any = {
  addDownload: vi.fn(),
  getStatus: vi.fn(),
  queueLoad: vi.fn(),
};
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: () => adapter,
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let status: typeof import("../src/services/clientStatus.js");
let release: typeof import("../src/services/throttlearr/release.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let mediaItemFromRow: (typeof import("../src/db/mappers.js"))["mediaItemFromRow"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  status = await import("../src/services/clientStatus.js");
  release = await import("../src/services/throttlearr/release.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ mediaItemFromRow } = await import("../src/db/mappers.js"));
});

let sent = 0;
beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  sent = 0;
  fake.active.clear();
  fake.maxSeen = 0;
  adapter.addDownload.mockReset();
  adapter.getStatus.mockReset();
  adapter.queueLoad = vi.fn(async () => ({ active: fake.active.size, bytesLeft: null }));
  adapter.addDownload.mockImplementation(async () => {
    const id = `hash${++sent}`;
    fake.active.add(id);
    fake.maxSeen = Math.max(fake.maxSeen, fake.active.size);
    return { downloadId: id };
  });
  adapter.getStatus.mockResolvedValue([]);
  setGate({});
});

const setGate = (over: Record<string, unknown>) => setSetting("throttlearr", JSON.stringify(over));

async function insertClient(name = "Seedbox", enabled = 1): Promise<DownloadClient> {
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, 'qbittorrent', 'dl.local', 8080, ?, 1)").run(name, enabled)).lastInsertRowid);
  return { id, name, type: "qbittorrent", host: "dl.local", port: 8080, useSsl: 0, username: null, password: null, apiKey: null, category: null, categoryByType: null, enabled, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1 } as DownloadClient;
}

let n = 0;
async function grabMovie(client: DownloadClient) {
  n++;
  const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(`Rel ${n}`, `rel ${n}`)).lastInsertRowid);
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  const result = { indexerId: null, indexerName: "Idx", title: `Rel.${itemId}.2020.1080p`, size: 1000, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=urn:btih:${itemId}`, protocol: "torrent", category: null } as any;
  await scheduler.grab(client, mediaItemFromRow(item), null, null, { result, quality: "WEBDL-1080p" } as any, 0, null, "auto");
  return itemId;
}

/** Everything the fake client holds finishes: its rows are completed and its slots free. */
async function finishDownloads() {
  for (const id of fake.active) await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id = ?").run(id);
  fake.active.clear();
}

const rows = async () => (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
const held = async () => (await rows()).filter((r) => r.gate_state === "held");
const count = async (sql: string) => Number(((await db.prepare(sql).get()) as any).c);

describe("Throttlearr: the release worker", () => {
  for (const mode of ["the adapter's own count", "AoNarr's queue rows"]) {
    it(`feeds a client 50 grabs without ever holding more than its limit of 5, counted from ${mode}, and loses none`, async () => {
      if (mode !== "the adapter's own count") delete adapter.queueLoad;
      const client = await insertClient();
      setGate({ enabled: true, clients: { [client.id]: { maxActive: 5 } } });
      for (let i = 0; i < 50; i++) await grabMovie(client);
      expect(sent).toBe(5);
      expect(await held()).toHaveLength(45);

      let rounds = 0;
      while ((await held()).length > 0) {
        if (++rounds > 30) throw new Error("grabs stay held");
        await finishDownloads();
        const summary = await release.releaseHeldGrabs();
        expect(summary.released).toBeGreaterThan(0);
        expect(fake.active.size).toBeLessThanOrEqual(5);
        // A restart now and then costs nothing.
        if (rounds === 3) await release.resetReleasingRows();
      }
      expect(sent).toBe(50);
      expect(fake.maxSeen).toBeLessThanOrEqual(5);
      expect(adapter.addDownload).toHaveBeenCalledTimes(50);
      const all = await rows();
      expect(all).toHaveLength(50);
      expect(all.every((r) => r.download_id && (r.gate_state === null || r.gate_state === "released"))).toBe(true);
      expect(new Set(all.map((r) => r.download_id)).size).toBe(50);
    });
  }

  it("writes the grab history and the new clock only when the grab is sent", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    const histories = () => count("SELECT COUNT(*) AS c FROM history WHERE event_type = 'grabbed'");
    expect(await histories()).toBe(1);
    await db.prepare("UPDATE queue SET added_at = '2020-01-01 00:00:00' WHERE gate_state = 'held'").run();

    await release.releaseHeldGrabs(); // no room
    expect(await histories()).toBe(1);
    await finishDownloads();
    await release.releaseHeldGrabs();

    expect(await histories()).toBe(2);
    const row = (await rows())[1];
    expect(row).toMatchObject({ gate_state: "released", gate_reason: null, download_id: "hash2", status: "queued" });
    expect(row.added_at > "2020-01-01 00:00:00").toBe(true);
    expect(row.last_progress_at).toBeNull();
  });

  it("releases the highest priority first, then the oldest", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    const a = await grabMovie(client);
    const b = await grabMovie(client);
    const c = await grabMovie(client);
    await db.prepare("UPDATE queue SET gate_priority = 10 WHERE media_item_id = ?").run(c);
    // Older than the others, but well inside maxHeldAgeHours.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
    await db.prepare("UPDATE queue SET gate_held_at = ? WHERE media_item_id = ?").run(hourAgo, b);
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      await finishDownloads();
      await release.releaseHeldGrabs();
      const r = (await rows()).find((x) => x.gate_state === "released" && !order.includes(x.media_item_id));
      order.push(r.media_item_id);
    }
    expect(order).toEqual([c, b, a]);
  });

  it("claims a row once: two passes at the same time send it once, and a row someone else claimed is left", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await finishDownloads();
    await Promise.all([release.releaseHeldGrabs(), release.releaseHeldGrabs()]);
    expect(sent).toBe(2);

    await grabMovie(client); // held again
    await db.prepare("UPDATE queue SET gate_state = 'releasing' WHERE gate_state = 'held'").run();
    await finishDownloads();
    await release.releaseHeldGrabs();
    expect(sent).toBe(2); // the claimed row is not sent by this pass
  });

  it("puts a row left 'releasing' by a stop back to held, and sends it once", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await db.prepare("UPDATE queue SET gate_state = 'releasing' WHERE gate_state = 'held'").run();
    expect(await release.resetReleasingRows()).toBe(1);
    expect(await held()).toHaveLength(1);
    await finishDownloads();
    await release.releaseHeldGrabs();
    expect(sent).toBe(2);
    expect(await held()).toHaveLength(0);
  });

  it("keeps the grabs held while the client is down, and releases them when it comes back", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await finishDownloads();

    adapter.addDownload.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const down = await release.releaseHeldGrabs();
    expect(down.released).toBe(0);
    const h = await held();
    expect(h).toHaveLength(1);
    expect(h[0].gate_reason).toBe("Seedbox is unavailable");
    expect(status.clientFailureLevel(client.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS c FROM blocklist")).toBe(0);

    status.resetClientStatuses();
    await release.releaseHeldGrabs();
    expect(await held()).toHaveLength(0);
    expect(sent).toBe(2);
  });

  it("leaves the grabs held when the client's load cannot be read", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await finishDownloads();
    adapter.queueLoad = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    const summary = await release.releaseHeldGrabs();
    expect(summary).toMatchObject({ released: 0, skippedClients: 1 });
    expect(await held()).toHaveLength(1);
    expect(sent).toBe(1);
  });

  it("fails and blocklists a release the client refuses, and sends the next held grab", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held, will be refused
    await grabMovie(client); // held
    await finishDownloads();
    adapter.addDownload.mockRejectedValueOnce(new Error("Invalid NZB: no files"));
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 2 } } });
    const summary = await release.releaseHeldGrabs();
    expect(summary).toMatchObject({ released: 1, failed: 1 });
    const all = await rows();
    expect(all[1]).toMatchObject({ status: "failed", gate_state: null });
    expect(all[2]).toMatchObject({ gate_state: "released" });
    expect(await count("SELECT COUNT(*) AS c FROM blocklist")).toBe(1);
    expect(await count("SELECT COUNT(*) AS c FROM history WHERE event_type = 'failed'")).toBe(1);
  });

  it("fails an unreadable held grab without blaming a release", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await db.prepare("UPDATE queue SET gate_payload = 'not json' WHERE gate_state = 'held'").run();
    await finishDownloads();
    const summary = await release.releaseHeldGrabs();
    expect(summary.failed).toBe(1);
    expect((await rows())[1]).toMatchObject({ status: "failed", gate_state: null });
    expect(await count("SELECT COUNT(*) AS c FROM blocklist")).toBe(0);
  });

  it("drops a held grab older than maxHeldAgeHours, without blame, and sends nothing for it", async () => {
    const client = await insertClient();
    setGate({ enabled: true, maxHeldAgeHours: 72, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await grabMovie(client);
    await db.prepare("UPDATE queue SET gate_held_at = '2020-01-01 00:00:00' WHERE id = (SELECT MIN(id) FROM queue WHERE gate_state = 'held')").run();
    const summary = await release.releaseHeldGrabs();
    expect(summary.expired).toBe(1);
    const all = await rows();
    expect(all[1]).toMatchObject({ status: "failed", gate_state: null });
    expect(all[2].gate_state).toBe("held");
    expect(await count("SELECT COUNT(*) AS c FROM blocklist")).toBe(0);
    expect(sent).toBe(1);
  });

  it("releases everything at once when Throttlearr is turned off, and nothing while holdAll is on", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    for (let i = 0; i < 4; i++) await grabMovie(client);
    expect(await held()).toHaveLength(3);

    setGate({ enabled: true, holdAll: true, clients: { [client.id]: { maxActive: 10 } } });
    await release.releaseHeldGrabs();
    expect(await held()).toHaveLength(3);

    setGate({ enabled: false });
    const summary = await release.releaseHeldGrabs();
    expect(summary.released).toBe(3);
    expect(await held()).toHaveLength(0);
    expect(sent).toBe(4);
  });

  it("leaves the grabs of a disabled client held", async () => {
    const client = await insertClient("Seedbox", 1);
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client);
    await db.prepare("UPDATE download_clients SET enabled = 0 WHERE id = ?").run(client.id);
    await finishDownloads();
    const summary = await release.releaseHeldGrabs();
    expect(summary).toMatchObject({ released: 0, skippedClients: 1 });
    expect(await held()).toHaveLength(1);
  });

  it("drops a held grab whose download the client already tracks for another row", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client); // hash1
    await grabMovie(client); // held
    await finishDownloads();
    adapter.addDownload.mockResolvedValueOnce({ downloadId: "hash1" });
    await release.releaseHeldGrabs();
    expect(await rows()).toHaveLength(1);
  });
});

describe("queue load counts", () => {
  it("counts SABnzbd jobs that are not paused, and their megabytes left", () => {
    const load = sabnzbdQueueLoad([
      { status: "Downloading", mbleft: "100.5" },
      { status: "Queued", mbleft: "50" },
      { status: "Paused", mbleft: "9999" },
      { status: "Propagating", mbleft: "0" },
    ]);
    expect(load).toEqual({ active: 3, bytesLeft: Math.round(150.5 * 1024 * 1024) });
    expect(sabnzbdQueueLoad([])).toEqual({ active: 0, bytesLeft: 0 });
    expect(sabnzbdQueueLoad(undefined)).toEqual({ active: 0, bytesLeft: 0 });
    expect(sabnzbdQueueLoad([{ status: "Downloading" }])).toEqual({ active: 1, bytesLeft: null });
  });

  it("counts qBittorrent torrents that are downloading or waiting, not seeding, paused or in error", () => {
    const load = qbittorrentQueueLoad([
      { state: "downloading", amount_left: 1000 },
      { state: "stalledDL", amount_left: 500 },
      { state: "queuedDL", amount_left: 200 },
      { state: "metaDL", amount_left: 0 },
      { state: "pausedDL", amount_left: 7000 },
      { state: "stoppedDL", amount_left: 7000 },
      { state: "uploading", amount_left: 0 },
      { state: "stalledUP", amount_left: 0 },
      { state: "error", amount_left: 5 },
    ]);
    expect(load).toEqual({ active: 4, bytesLeft: 1700 });
    expect(qbittorrentQueueLoad(null)).toEqual({ active: 0, bytesLeft: 0 });
  });
});
