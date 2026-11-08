import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";
import { parsePayload } from "../src/services/throttlearr/gate.js";

// Phase 4 of Throttlearr: bytes, adds per hour, hours, free disk, priority classes and fairness, end to end through
// grab() and the release worker.
const fake = { active: new Set<string>() };
const adapter: any = { addDownload: vi.fn(), getStatus: vi.fn(), queueLoad: undefined };
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: () => adapter,
}));
let freeNow: number | null = null;
vi.mock("../src/services/freeSpace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/freeSpace.js")>()),
  freeBytesAt: async () => freeNow,
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let status: typeof import("../src/services/clientStatus.js");
let release: typeof import("../src/services/throttlearr/release.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let mediaItemFromRow: (typeof import("../src/db/mappers.js"))["mediaItemFromRow"];
let gateModule: typeof import("../src/services/throttlearr/gate.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  status = await import("../src/services/clientStatus.js");
  gateModule = await import("../src/services/throttlearr/gate.js");
  release = await import("../src/services/throttlearr/release.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ mediaItemFromRow } = await import("../src/db/mappers.js"));
});

let sent = 0;
beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  gateModule.resetAddLog();
  sent = 0;
  freeNow = null;
  fake.active.clear();
  adapter.queueLoad = undefined; // load is counted from AoNarr's own rows, with sizes
  adapter.addDownload.mockReset();
  adapter.addDownload.mockImplementation(async () => {
    const id = `hash${++sent}`;
    fake.active.add(id);
    return { downloadId: id };
  });
  adapter.getStatus.mockResolvedValue([]);
  setGate({});
});

const setGate = (over: Record<string, unknown>) => setSetting("throttlearr", JSON.stringify(over));

async function insertClient(name = "Seedbox"): Promise<DownloadClient> {
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, 'qbittorrent', 'dl.local', 8080, 1, 1)").run(name)).lastInsertRowid);
  return { id, name, type: "qbittorrent", host: "dl.local", port: 8080, useSsl: 0, username: null, password: null, apiKey: null, category: null, categoryByType: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1 } as DownloadClient;
}

let n = 0;
const result = (id: number, size: number) =>
  ({ indexerId: null, indexerName: "Idx", title: `Rel.${id}.2020.1080p`, size, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=urn:btih:${id}`, protocol: "torrent", category: null }) as any;

async function grabMovie(client: DownloadClient, size = 1000) {
  n++;
  const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(`Lim ${n}`, `lim ${n}`)).lastInsertRowid);
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  await scheduler.grab(client, mediaItemFromRow(item), null, null, { result: result(itemId, size), quality: "WEBDL-1080p" } as any, 0, null, "auto");
  return itemId;
}

async function insertSeries(title: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('series', ?, ?, 1, 'missing')").run(title, title.toLowerCase())).lastInsertRowid);
}

let epNo = 0;
async function grabEpisode(client: DownloadClient, seriesId: number, airDate: string | null, size = 1000) {
  epNo++;
  const episodeId = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, air_date) VALUES (?, 1, ?, ?)").run(seriesId, epNo, airDate)).lastInsertRowid);
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(seriesId)) as any;
  await scheduler.grab(client, mediaItemFromRow(item), episodeId, null, { result: result(900000 + epNo, size), quality: "WEBDL-1080p" } as any, 0, null, "auto");
  return episodeId;
}

async function finishDownloads() {
  for (const id of fake.active) await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id = ?").run(id);
  fake.active.clear();
}

const rows = async () => (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
const held = async () => (await rows()).filter((r) => r.gate_state === "held");
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const ALL = [0, 1, 2, 3, 4, 5, 6];

describe("Throttlearr limits end to end", () => {
  it("holds grabs past the byte limit, and sends them as the client's bytes drain", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActiveBytes: 100 } } });
    for (let i = 0; i < 4; i++) await grabMovie(client, 40);
    expect(sent).toBe(2); // 40 + 40 = 80 fits; a third would make 120
    const h = await held();
    expect(h).toHaveLength(2);
    expect(h[0].gate_reason).toMatch(/left of/);

    await release.releaseHeldGrabs(); // nothing has drained
    expect(sent).toBe(2);
    await finishDownloads();
    await release.releaseHeldGrabs();
    expect(sent).toBe(4);
    expect(await held()).toHaveLength(0);
  });

  it("lets a single job bigger than the byte limit through an idle client", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActiveBytes: 100 } } });
    await grabMovie(client, 500);
    expect(sent).toBe(1);
    await grabMovie(client, 10); // the client now has 500 left
    expect(sent).toBe(1);
    expect(await held()).toHaveLength(1);
  });

  it("limits adds per hour by what was sent in the last hour, finished or not", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { addsPerHour: 2 } } });
    for (let i = 0; i < 5; i++) await grabMovie(client);
    expect(sent).toBe(2);
    expect((await held())[0].gate_reason).toMatch(/took 2 of 2 adds this hour/);

    await finishDownloads(); // finished, but the hour is not over
    await release.releaseHeldGrabs();
    expect(sent).toBe(2);

    await db.prepare("UPDATE queue SET added_at = '2020-01-01 00:00:00' WHERE download_id IS NOT NULL").run(); // an hour passes
    gateModule.resetAddLog();
    await release.releaseHeldGrabs();
    expect(sent).toBe(4);
    expect(await held()).toHaveLength(1);
  });

  it("still counts the adds of rows that were imported and deleted within the hour", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { addsPerHour: 2 } } });
    for (let i = 0; i < 2; i++) await grabMovie(client);
    expect(sent).toBe(2);
    await db.prepare("DELETE FROM queue WHERE download_id IS NOT NULL").run(); // imported, rows gone
    fake.active.clear();
    await grabMovie(client);
    expect(sent).toBe(2); // the hour's two adds are still on file
    expect((await held())[0].gate_reason).toMatch(/took 2 of 2 adds this hour/);
  });

  it("holds grabs outside the client's hours and releases them inside", async () => {
    const client = await insertClient();
    const nowD = new Date();
    const later = new Date(nowD.getTime() + 2 * 3_600_000);
    const later2 = new Date(nowD.getTime() + 3 * 3_600_000);
    setGate({ enabled: true, clients: { [client.id]: { windows: [{ days: ALL, from: hhmm(later), to: hhmm(later2) }] } } });
    for (let i = 0; i < 3; i++) await grabMovie(client);
    expect(sent).toBe(0);
    expect((await held())[0].gate_reason).toBe("Outside Seedbox's hours");

    await release.releaseHeldGrabs(nowD);
    expect(sent).toBe(0);
    const inside = new Date(later.getTime() + 60_000);
    await release.releaseHeldGrabs(inside);
    expect(sent).toBe(3);
  });

  it("keeps the free disk above the minimum, counting what the client still has to write", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { minFreeBytes: 500 } } });
    freeNow = 550;
    await grabMovie(client, 10); // an idle client takes one job whatever the disk says
    expect(sent).toBe(1);
    await grabMovie(client, 100); // 550 - 10 - 100 = 440 < 500
    expect(sent).toBe(1);
    expect((await held())[0].gate_reason).toMatch(/Free disk would drop under/);

    await release.releaseHeldGrabs();
    expect(sent).toBe(1);
    freeNow = 5000;
    await release.releaseHeldGrabs();
    expect(sent).toBe(2);
  });

  it("never blocks on a disk it cannot read", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { minFreeBytes: 500 } } });
    freeNow = null;
    await grabMovie(client, 100);
    expect(sent).toBe(1);
  });

  it("gives each held grab the priority of its class: movies, then recent episodes, then old ones", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client); // takes the one slot
    const series = await insertSeries("Old Show");
    const recentDate = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await grabEpisode(client, series, "2015-01-01"); // backlog
    await grabEpisode(client, series, recentDate); // recent
    await grabMovie(client); // movie
    const h = await held();
    expect(h.map((r) => r.gate_priority)).toEqual([0, 10, 20]);
    expect(h.map((r) => parsePayload(r.gate_payload)?.priorityClass)).toEqual(["backlog", "recentTv", "movie"]);

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      await finishDownloads();
      await release.releaseHeldGrabs();
      const next = (await rows()).find((r) => r.gate_state === "released" && !order.includes(r.title));
      order.push(next.title);
    }
    // Movie first (priority 20), then the recent episode (10), then the old one (0).
    const byTitle = new Map((await rows()).map((r) => [r.title, r.gate_priority]));
    expect(order.map((t) => byTitle.get(t))).toEqual([20, 10, 0]);
  });

  it("keeps old episodes waiting until the night when asked", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } }, priority: { backlogOnlyAtNight: true } });
    await grabMovie(client);
    const series = await insertSeries("Archive Show");
    await grabEpisode(client, series, "2010-05-05"); // backlog, held
    await grabEpisode(client, series, new Date().toISOString().slice(0, 10)); // recent, held
    await finishDownloads();

    await release.releaseHeldGrabs(new Date(2026, 10, 9, 12, 0)); // noon
    let r = await rows();
    expect(r.filter((x) => x.gate_state === "released")).toHaveLength(1);
    expect(parsePayload(r.find((x) => x.gate_state === "released")!.gate_payload)?.priorityClass).toBe("recentTv");
    expect(r.filter((x) => x.gate_state === "held")).toHaveLength(1);

    await finishDownloads();
    await release.releaseHeldGrabs(new Date(2026, 10, 9, 23, 30)); // night
    r = await rows();
    expect(r.filter((x) => x.gate_state === "held")).toHaveLength(0);
  });

  it("stops one series taking every slot", async () => {
    const client = await insertClient();
    setGate({ enabled: true, perTitleLimit: 2, clients: { [client.id]: { maxActive: 4 } } });
    const series = await insertSeries("Long Show");
    const recent = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 4; i++) await grabEpisode(client, series, recent);
    expect(sent).toBe(2); // two of the show; the other two wait although the client has room
    expect((await held())[0].gate_reason).toMatch(/2 jobs of this title are already running/);

    await grabMovie(client); // held behind the show's episodes (they were first), then released ahead of them: movies rank higher
    await release.releaseHeldGrabs();
    const r = await rows();
    const movie = r[r.length - 1];
    expect(movie.gate_state).toBe("released");
    expect(r.filter((x) => x.gate_state === "held")).toHaveLength(2); // the show's other two episodes
  });

  it("leaves a client with only a title limit alone: fairness applies to limited clients", async () => {
    const client = await insertClient();
    setGate({ enabled: true, perTitleLimit: 1 });
    const series = await insertSeries("Free Show");
    for (let i = 0; i < 3; i++) await grabEpisode(client, series, null);
    expect(sent).toBe(3);
  });
});
