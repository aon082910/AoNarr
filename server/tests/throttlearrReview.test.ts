import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

// Regression tests for the findings of the independent review of Throttlearr (phase 8).
const fake = { active: new Set<string>() };
const adapter: any = { addDownload: vi.fn(), getStatus: vi.fn(), queueLoad: vi.fn(), removeDownload: vi.fn() };
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: () => adapter,
}));

// retryFailedGrab ends in grab(), which takes the client's lock: the stand-in checks that the lock is free when it runs.
const retry = { calls: 0, lockWasFree: [] as boolean[], clientId: 0 };
vi.mock("../src/services/scheduler.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/scheduler.js")>();
  return {
    ...real,
    retryFailedGrab: async () => {
      retry.calls++;
      const { withClientGate } = await import("../src/services/throttlearr/gate.js");
      const free = await Promise.race([withClientGate(retry.clientId, async () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 700))]);
      retry.lockWasFree.push(free);
    },
  };
});

const record = { failNext: false };
vi.mock("../src/services/grabHistory.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/grabHistory.js")>();
  return {
    ...real,
    recordGrabbed: async (...args: Parameters<typeof real.recordGrabbed>) => {
      if (record.failNext) {
        record.failNext = false;
        throw new Error("database is locked");
      }
      return real.recordGrabbed(...args);
    },
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let status: typeof import("../src/services/clientStatus.js");
let release: typeof import("../src/services/throttlearr/release.js");
let actions: typeof import("../src/services/throttlearr/actions.js");
let gate: typeof import("../src/services/throttlearr/gate.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let mediaItemFromRow: (typeof import("../src/db/mappers.js"))["mediaItemFromRow"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  status = await import("../src/services/clientStatus.js");
  release = await import("../src/services/throttlearr/release.js");
  actions = await import("../src/services/throttlearr/actions.js");
  gate = await import("../src/services/throttlearr/gate.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ mediaItemFromRow } = await import("../src/db/mappers.js"));
});

let sent = 0;
beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  gate.resetAddLog();
  sent = 0;
  fake.active.clear();
  retry.calls = 0;
  retry.lockWasFree = [];
  record.failNext = false;
  adapter.addDownload.mockReset();
  adapter.getStatus.mockReset();
  adapter.removeDownload.mockReset();
  adapter.queueLoad = vi.fn(async () => ({ active: fake.active.size, bytesLeft: null }));
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
  retry.clientId = id;
  return { id, name, type: "qbittorrent", host: "dl.local", port: 8080, useSsl: 0, username: null, password: null, apiKey: null, category: null, categoryByType: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1 } as DownloadClient;
}

let n = 0;
async function grabMovie(client: DownloadClient, source: "auto" | "interactive" = "auto") {
  n++;
  const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(`Rv ${n}`, `rv ${n}`)).lastInsertRowid);
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  const result = { indexerId: null, indexerName: "Idx", title: `Rv.${itemId}.2020.1080p`, size: 1000, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=urn:btih:${itemId}`, protocol: "torrent", category: null } as any;
  await scheduler.grab(client, mediaItemFromRow(item), null, null, { result, quality: "WEBDL-1080p" } as any, 0, null, source);
  return itemId;
}

const rows = async () => (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
const held = async () => (await rows()).filter((r) => r.gate_state === "held");

describe("a refused release does not deadlock the client's lock", () => {
  it("searches for the replacement after the lock is free, so the worker, release-now and later grabs keep going", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    await grabMovie(client); // held
    fake.active.clear();
    await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id IS NOT NULL").run();
    adapter.addDownload.mockRejectedValueOnce(new Error("Invalid NZB")); // the next release is refused

    const summary = await Promise.race([release.releaseHeldGrabs(), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    expect(summary).not.toBeNull();
    expect(retry.calls).toBe(1);
    expect(retry.lockWasFree).toEqual([true]); // the old code held the lock here and the search could never take it
    expect(summary?.failed).toBe(1);
    // The refused grab is out of the way: the next pass sends the one behind it.
    expect(sent).toBe(1);
    expect((await held()).length).toBe(1);
    await release.releaseHeldGrabs();
    expect(sent).toBe(2);
    expect((await rows()).filter((r) => r.gate_state === "released")).toHaveLength(1);

    // A later grab for the client is not stuck behind a lock that never frees.
    const late = await Promise.race([grabMovie(client, "interactive"), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    expect(late).not.toBeNull();
  });

  it("does the same for release-now on a grab the client refuses", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    const [target] = await held();
    adapter.addDownload.mockRejectedValueOnce(new Error("Invalid NZB"));
    const outcome = await Promise.race([actions.releaseHeldNow(Number(target.id)), new Promise<string>((r) => setTimeout(() => r("hung"), 5000))]);
    expect(outcome).toBe("failed");
    expect(retry.lockWasFree).toEqual([true]);
  });
});

describe("a database error after a successful send", () => {
  it("keeps the download tracked instead of leaving the row 'releasing'", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    fake.active.clear();
    await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id IS NOT NULL").run();
    record.failNext = true; // writing the grabbed history fails after the client took the add

    const summary = await release.releaseHeldGrabs();
    expect(summary.released).toBe(1);
    const row = (await rows()).find((r) => r.download_id === "hash2");
    expect(row).toMatchObject({ gate_state: "released", status: "queued" });
    expect((await rows()).some((r) => r.gate_state === "releasing")).toBe(false);
    expect(adapter.removeDownload).not.toHaveBeenCalled();
  });
});

describe("a hand-picked grab does not wait behind a release pass", () => {
  it("is decided without the client's lock when it skips the hold", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    let open!: () => void;
    const hold = gate.withClientGate(client.id, () => new Promise<void>((resolve) => (open = resolve))); // a long release pass
    const picked = await Promise.race([grabMovie(client, "interactive").then(() => "sent"), new Promise<string>((r) => setTimeout(() => r("waited"), 1500))]);
    expect(picked).toBe("sent");
    expect(sent).toBe(2);
    // An automatic grab still waits for the lock, as it must.
    const auto = await Promise.race([grabMovie(client, "auto").then(() => "sent"), new Promise<string>((r) => setTimeout(() => r("waited"), 400))]);
    expect(auto).toBe("waited");
    open();
    await hold;
  });
});

describe("a season pack is classed by the season's own air dates", () => {
  async function seasonGrab(client: DownloadClient, airDate: string) {
    const showId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('series', 'Old Show', 'old show', 1, 'missing')").run()).lastInsertRowid);
    for (const ep of [1, 2]) {
      await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?, 2, ?, 'E', ?, 1, 0)").run(showId, ep, airDate);
    }
    const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(showId)) as any;
    const result = { indexerId: null, indexerName: "Idx", title: "Old.Show.S02.1080p.WEB-DL-GRP", size: 1000, seeders: 5, leechers: 0, publishDate: null, downloadUrl: "magnet:?xt=urn:btih:ff", protocol: "torrent", category: null } as any;
    await scheduler.grab(client, mediaItemFromRow(item), null, null, { result, quality: "WEBDL-1080p" } as any, 0, 2, "auto");
  }

  it("is backlog for an old season, recent for a new one", async () => {
    const client = await insertClient();
    setGate({ enabled: true, holdAll: true });
    await seasonGrab(client, "2005-03-01");
    const old = gate.parsePayload((await held())[0].gate_payload);
    expect(old?.priorityClass).toBe("backlog");

    await db.prepare("DELETE FROM queue").run();
    await db.prepare("DELETE FROM episodes").run();
    await db.prepare("DELETE FROM media_items").run();
    await seasonGrab(client, new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10));
    expect(gate.parsePayload((await held())[0].gate_payload)?.priorityClass).toBe("recentTv");
  });
});

describe("release-now goes through a client that is being left alone", () => {
  it("is not stopped by the back-off, while the automatic pass leaves the client alone", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    await grabMovie(client);
    await grabMovie(client); // held
    const [target] = await held();
    await status.recordClientFailure(client.id, "connection reset");
    expect(status.isClientBackedOff(client.id)).toBe(true);

    expect((await release.releaseHeldGrabs()).skippedClients).toBe(1);
    expect(await held()).toHaveLength(1);
    expect(await actions.releaseHeldNow(Number(target.id))).toBe("released");
    expect(sent).toBe(2);
  });
});
