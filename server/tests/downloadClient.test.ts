import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

type SpawnCallback = { event: string; handler: (...args: any[]) => void };
class FakeChildProcess {
  stdout = { on: (event: string, handler: any) => this.stdoutHandlers.push({ event, handler }) };
  stderr = { on: (event: string, handler: any) => this.stderrHandlers.push({ event, handler }) };
  stdoutHandlers: SpawnCallback[] = [];
  stderrHandlers: SpawnCallback[] = [];
  procHandlers: SpawnCallback[] = [];
  on(event: string, handler: any) {
    this.procHandlers.push({ event, handler });
    return this;
  }
  emitStdout(text: string) {
    for (const h of this.stdoutHandlers) if (h.event === "data") h.handler(Buffer.from(text));
  }
  emitExit(code: number) {
    for (const h of this.procHandlers) if (h.event === "exit") h.handler(code);
  }
  emitError(err: Error) {
    for (const h of this.procHandlers) if (h.event === "error") h.handler(err);
  }
}
let lastSpawned: FakeChildProcess | null = null;
let spawnArgs: { command: string; args: string[] } | null = null;
const spawnMock = vi.fn((command: string, args: string[]) => {
  spawnArgs = { command, args };
  lastSpawned = new FakeChildProcess();
  return lastSpawned;
});
vi.mock("node:child_process", async (importOriginal) => {
  // ffprobe.ts (loaded transitively via the full app in setupTestDb()) also imports execFile from
  // this same module — a full replacement providing only `spawn` breaks it. Keep everything else real.
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    spawn: (...args: any[]) => spawnMock(...(args as [string, string[]])),
  };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let config: (typeof import("../src/config.js"))["config"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let getDownloadClientAdapter: (typeof import("../src/services/downloadClient.js"))["getDownloadClientAdapter"];
let testDownloadClientConnection: (typeof import("../src/services/downloadClient.js"))["testDownloadClientConnection"];
let applyRemotePathMapping: (typeof import("../src/services/downloadClient.js"))["applyRemotePathMapping"];
let removeQueueItemDownload: (typeof import("../src/services/downloadClient.js"))["removeQueueItemDownload"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ config } = await import("../src/config.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ getDownloadClientAdapter, testDownloadClientConnection, applyRemotePathMapping, removeQueueItemDownload } = await import(
    "../src/services/downloadClient.js"
  ));
});

let downloadsDir: string;

beforeEach(async () => {
  await db.prepare("DELETE FROM remote_path_mappings").run();
  await db.prepare("DELETE FROM download_clients").run();
  downloadsDir = path.join(config.downloadsDir, "test-fixtures"); // see importer.test.ts for why this must be a subfolder, not config.downloadsDir itself
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  spawnMock.mockClear();
  lastSpawned = null;
  spawnArgs = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function routedFetch(routes: { test: (url: string, init?: any) => boolean; response: any }[]) {
  return vi.fn(async (url: string, init?: any) => {
    const route = routes.find((r) => r.test(url, init));
    if (!route) throw new Error(`unmocked fetch call: ${url}`);
    return typeof route.response === "function" ? route.response(url, init) : route.response;
  });
}
function ok(body: unknown, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)), // resolveDownloadSource's torrent-bytes path reads this
    ...extra,
  };
}
function notOk(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body, text: async () => "" };
}
function fileResponse(content: string, headers: Record<string, string> = {}) {
  // HttpDownloadAdapter reads res.headers.get("content-length") for progress tracking.
  return { ok: true, status: 200, headers: new Headers({ "content-length": String(content.length), ...headers }), body: new Response(content).body };
}

async function insertClient(overrides: Record<string, unknown> = {}): Promise<any> {
  const row = {
    name: "Test Client",
    type: "qbittorrent",
    host: "client.local",
    port: 8080,
    use_ssl: 0,
    username: null,
    password: null,
    api_key: null,
    category: null,
    enabled: 1,
    audio_only: 0,
    ...overrides,
  };
  const result = await db
    .prepare(
      `INSERT INTO download_clients (name, type, host, port, use_ssl, username, password, api_key, category, enabled, audio_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.name, row.type, row.host, row.port, row.use_ssl, row.username, row.password, row.api_key, row.category, row.enabled, row.audio_only);
  return {
    id: Number(result.lastInsertRowid),
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    useSsl: row.use_ssl,
    username: row.username,
    password: row.password,
    apiKey: row.api_key,
    category: row.category,
    enabled: row.enabled,
    audioOnly: row.audio_only,
  };
}

// ---------------------------------------------------------------------------
// applyRemotePathMapping
// ---------------------------------------------------------------------------

describe("applyRemotePathMapping", () => {
  it("returns the path unchanged when no mappings are configured", async () => {
    await expect(applyRemotePathMapping(999, "/remote/x.mkv")).resolves.toBe("/remote/x.mkv");
  });

  it("rewrites a matching remote prefix to its local counterpart", async () => {
    const client = await insertClient();
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/downloads', '/mnt/media')").run(client.id);

    await expect(applyRemotePathMapping(client.id, "/downloads/movies/x.mkv")).resolves.toBe("/mnt/media/movies/x.mkv");
  });

  it("matches case-insensitively and tolerates mixed slash styles", async () => {
    const client = await insertClient();
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, 'C:\\Downloads', '/mnt/media')").run(client.id);

    await expect(applyRemotePathMapping(client.id, "c:/downloads/x.mkv")).resolves.toBe("/mnt/media/x.mkv");
  });

  it("prefers the longest matching prefix when multiple mappings could apply", async () => {
    const client = await insertClient();
    await db
      .prepare(
        "INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/downloads', '/generic'), (?, '/downloads/movies', '/specific')"
      )
      .run(client.id, client.id);

    await expect(applyRemotePathMapping(client.id, "/downloads/movies/x.mkv")).resolves.toBe("/specific/x.mkv");
  });

  it("returns the path unchanged when it doesn't start with any configured remote prefix", async () => {
    const client = await insertClient();
    await db.prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, '/downloads', '/mnt/media')").run(client.id);

    await expect(applyRemotePathMapping(client.id, "/completely/different/x.mkv")).resolves.toBe("/completely/different/x.mkv");
  });
});

// ---------------------------------------------------------------------------
// getDownloadClientAdapter / removeQueueItemDownload
// ---------------------------------------------------------------------------

describe("getDownloadClientAdapter / removeQueueItemDownload", () => {
  it("returns an adapter implementing removeDownload for qbittorrent", () => {
    expect(typeof getDownloadClientAdapter("qbittorrent").removeDownload).toBe("function");
  });

  it("is a no-op when the queue item has no downloadClientId/downloadId", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await removeQueueItemDownload({ downloadClientId: null, downloadId: null, title: "X" } as any, true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the underlying removal fails", async () => {
    const client = await insertClient({ type: "qbittorrent" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(removeQueueItemDownload({ downloadClientId: client.id, downloadId: "hash1", title: "X" }, true)).resolves.toBeUndefined();
  });

  it("does nothing when the adapter has no removeDownload (blackhole)", async () => {
    const client = await insertClient({ type: "blackhole", host: downloadsDir });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await removeQueueItemDownload({ downloadClientId: client.id, downloadId: "x", title: "X" }, true);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// testDownloadClientConnection
// ---------------------------------------------------------------------------

describe("testDownloadClientConnection", () => {
  it("qbittorrent: throws on a rejected login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "Fails." }));
    await expect(testDownloadClientConnection(await insertClient({ type: "qbittorrent" }))).rejects.toThrow("Login rejected");
  });

  it("qbittorrent: succeeds on a real login response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "Ok." }));
    await expect(testDownloadClientConnection(await insertClient({ type: "qbittorrent" }))).resolves.toBeUndefined();
  });

  it("sabnzbd: throws when the API reports an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ error: "API Key Incorrect" })));
    await expect(testDownloadClientConnection(await insertClient({ type: "sabnzbd", api_key: "bad" }))).rejects.toThrow("API Key Incorrect");
  });

  it("realdebrid: reports a friendly message on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk(401)));
    await expect(testDownloadClientConnection(await insertClient({ type: "realdebrid", api_key: "bad" }))).rejects.toThrow("API token rejected");
  });

  it("blackhole: throws when the watch folder isn't writable", async () => {
    await expect(testDownloadClientConnection(await insertClient({ type: "blackhole", host: path.join(downloadsDir, "does-not-exist") }))).rejects.toThrow(
      "doesn't exist or isn't writable"
    );
  });

  it("blackhole: succeeds when the watch folder is writable", async () => {
    await expect(testDownloadClientConnection(await insertClient({ type: "blackhole", host: downloadsDir }))).resolves.toBeUndefined();
  });

  it("http/ytdlp: always succeed — no external service to reach", async () => {
    await expect(testDownloadClientConnection(await insertClient({ type: "http" }))).resolves.toBeUndefined();
    await expect(testDownloadClientConnection(await insertClient({ type: "ytdlp" }))).resolves.toBeUndefined();
  });

  it("throws for a type with no implemented connection test", async () => {
    await expect(testDownloadClientConnection(await insertClient({ type: "made-up-type" }))).rejects.toThrow("No connection test implemented");
  });
});

// ---------------------------------------------------------------------------
// QBittorrentAdapter
// ---------------------------------------------------------------------------

describe("QBittorrentAdapter", () => {
  const adapter = () => getDownloadClientAdapter("qbittorrent");

  it("logs in once and reuses the session cookie across calls", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/auth/login"), response: ok({}, { headers: new Headers({ "set-cookie": "SID=abc123; Path=/" }) }) },
      { test: (u) => u.includes("/torrents/info"), response: ok([]) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "qbittorrent" });

    await adapter().getStatus(client, []);
    await adapter().getStatus(client, []);

    const loginCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/auth/login"));
    expect(loginCalls).toHaveLength(1); // second call reused the cached cookie
  });

  it("drops the cached cookie and retries once on a 403", async () => {
    let loginCount = 0;
    const fetchMock = routedFetch([
      {
        test: (u) => u.includes("/auth/login"),
        response: () => {
          loginCount++;
          return ok({}, { headers: new Headers({ "set-cookie": `SID=session${loginCount}; Path=/` }) });
        },
      },
      {
        test: (u) => u.includes("/torrents/info"),
        response: (_u: string, init: any) => (init.headers.Cookie === "SID=session1" ? { ok: false, status: 403, json: async () => ({}) } : ok([])),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter().getStatus(await insertClient({ type: "qbittorrent" }), []);

    expect(loginCount).toBe(2);
    expect(result).toEqual([]);
  });

  const INFO_HASH = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";
  const INFO_HASH_BASE32 = "YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK"; // the same 20 bytes, base32-encoded
  const loginRoute = { test: (u: string) => u.includes("/auth/login"), response: ok({}, { headers: new Headers({ "set-cookie": "SID=abc; Path=/" }) }) };

  it("addDownload returns a hex-btih magnet's own hash (lowercased) without any tag polling", async () => {
    const fetchMock = routedFetch([loginRoute, { test: (u) => u.includes("/torrents/add"), response: ok({}) }]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter().addDownload(
      await insertClient({ type: "qbittorrent" }),
      `magnet:?xt=urn:btih:${INFO_HASH.toUpperCase()}&dn=Some.Release`,
      "movies"
    );

    expect(result.downloadId).toBe(INFO_HASH);
    const addCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/add"));
    expect(addCall![1].body.get("category")).toBe("movies");
    expect(addCall![1].body.get("tags")).toBe("aonarr");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/torrents/info"))).toBe(false);
  });

  it("addDownload converts a base32-btih magnet to the hex hash qBittorrent reports", async () => {
    vi.stubGlobal("fetch", routedFetch([loginRoute, { test: (u) => u.includes("/torrents/add"), response: ok({}) }]));

    const result = await adapter().addDownload(await insertClient({ type: "qbittorrent" }), `magnet:?xt=urn:btih:${INFO_HASH_BASE32}&dn=x`, null);

    expect(result.downloadId).toBe(INFO_HASH);
  });

  it("addDownload resolves a .torrent URL's hash through its pending tag, then removes that tag", async () => {
    vi.useFakeTimers();
    const fetchMock = routedFetch([
      loginRoute,
      { test: (u) => u.includes("/torrents/add"), response: ok({}) },
      {
        test: (u) => u.includes("/torrents/info?tag="),
        response: (u: string) => {
          const tag = new URL(u).searchParams.get("tag");
          // The decoy is what a pre-4.2 qBittorrent (which ignores ?tag=) would put first.
          return ok([
            { hash: "decoy", tags: "" },
            { hash: INFO_HASH, tags: `aonarr, ${tag}` },
          ]);
        },
      },
      { test: (u) => u.includes("/torrents/removeTags"), response: ok({}) },
      { test: (u) => u.includes("/torrents/deleteTags"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "qbittorrent" });

    const pending = adapter().addDownload(client, "https://indexer/get/123.torrent", "tv");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.downloadId).toBe(INFO_HASH);
    const addForm = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/add"))![1].body as URLSearchParams;
    const [permanentTag, pendingTag] = addForm.get("tags")!.split(",");
    expect(permanentTag).toBe("aonarr");
    expect(pendingTag).toMatch(/^aonarr-pending-[0-9a-f]+$/);
    const removeForm = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/removeTags"))![1].body as URLSearchParams;
    expect(removeForm.get("hashes")).toBe(INFO_HASH);
    expect(removeForm.get("tags")).toBe(pendingTag);
    const deleteForm = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/deleteTags"))![1].body as URLSearchParams;
    expect(deleteForm.get("tags")).toBe(pendingTag);
  });

  it("addDownload falls back to a tag: placeholder id when the torrent never shows up", async () => {
    vi.useFakeTimers();
    const fetchMock = routedFetch([
      loginRoute,
      { test: (u) => u.includes("/torrents/add"), response: ok({}) },
      { test: (u) => u.includes("/torrents/info?tag="), response: ok([]) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "qbittorrent" });

    const pending = adapter().addDownload(client, "https://indexer/get/456.torrent", null);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    const addForm = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/add"))![1].body as URLSearchParams;
    expect(result.downloadId).toBe(`tag:${addForm.get("tags")!.split(",")[1]}`);
  });

  it("getStatus reports a pending-tag or legacy-magnet queue id as an alias resolved to the real hash", async () => {
    const legacyMagnet = `magnet:?xt=urn:btih:${INFO_HASH_BASE32}&dn=Show.S01E01`;
    vi.stubGlobal(
      "fetch",
      routedFetch([
        loginRoute,
        {
          test: (u) => u.includes("/torrents/info"),
          response: ok([{ hash: INFO_HASH, progress: 0.3, state: "downloading", tags: "aonarr, aonarr-pending-0a1b2c" }]),
        },
      ])
    );

    const updates = await adapter().getStatus(await insertClient({ type: "qbittorrent" }), ["tag:aonarr-pending-0a1b2c", legacyMagnet]);

    expect(updates).toContainEqual({ downloadId: INFO_HASH, progress: 0.3, status: "downloading", remotePath: undefined });
    expect(updates).toContainEqual({
      downloadId: "tag:aonarr-pending-0a1b2c",
      resolvedDownloadId: INFO_HASH,
      progress: 0.3,
      status: "downloading",
      remotePath: undefined,
    });
    expect(updates).toContainEqual({ downloadId: legacyMagnet, resolvedDownloadId: INFO_HASH, progress: 0.3, status: "downloading", remotePath: undefined });
  });

  it("getStatus resolves a v1-hash or magnet queue id to a hybrid torrent's own id via infohash_v1", async () => {
    const torrentId = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"; // libtorrent-2.x: a hybrid torrent's truncated v2 id
    const magnet = `magnet:?xt=urn:btih:${INFO_HASH}&dn=Hybrid.Release`;
    vi.stubGlobal(
      "fetch",
      routedFetch([
        loginRoute,
        { test: (u) => u.includes("/torrents/info"), response: ok([{ hash: torrentId, infohash_v1: INFO_HASH, progress: 0.4, state: "downloading", tags: "aonarr" }]) },
      ])
    );

    const updates = await adapter().getStatus(await insertClient({ type: "qbittorrent" }), [INFO_HASH, magnet, torrentId]);

    const own = { progress: 0.4, status: "downloading", remotePath: undefined };
    expect(updates).toHaveLength(3);
    expect(updates).toContainEqual({ downloadId: torrentId, ...own });
    expect(updates).toContainEqual({ downloadId: INFO_HASH, resolvedDownloadId: torrentId, ...own });
    expect(updates).toContainEqual({ downloadId: magnet, resolvedDownloadId: torrentId, ...own });
  });

  it("getStatus prefers content_path over save_path, and maps progress/state to a status", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/auth/login"), response: ok({}, { headers: new Headers({ "set-cookie": "SID=abc; Path=/" }) }) },
      {
        test: (u) => u.includes("/torrents/info"),
        response: ok([
          { hash: "h1", progress: 1, state: "uploading", content_path: "/data/movie/movie.mkv", save_path: "/data/movie" },
          { hash: "h2", progress: 0.5, state: "downloading" },
          { hash: "h3", progress: 0, state: "error" },
        ]),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const updates = await adapter().getStatus(await insertClient({ type: "qbittorrent" }), []);

    expect(updates).toEqual([
      { downloadId: "h1", progress: 1, status: "completed", remotePath: "/data/movie/movie.mkv" },
      { downloadId: "h2", progress: 0.5, status: "downloading", remotePath: undefined },
      { downloadId: "h3", progress: 0, status: "failed", remotePath: undefined },
    ]);
  });

  it("getHealthStats computes the global ratio and counts torrents over the configured limit", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/auth/login"), response: ok({}, { headers: new Headers({ "set-cookie": "SID=abc; Path=/" }) }) },
      { test: (u) => u.includes("/transfer/info"), response: ok({ up_info_data: 200, dl_info_data: 100 }) },
      { test: (u) => u.includes("/app/preferences"), response: ok({ max_ratio_enabled: true, max_ratio: 2 }) },
      { test: (u) => u.includes("/torrents/info"), response: ok([{ ratio: 3 }, { ratio: 1 }]) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const stats = await adapter().getHealthStats!(await insertClient({ type: "qbittorrent" }));

    expect(stats).toEqual({
      uploadedTotalBytes: 200,
      downloadedTotalBytes: 100,
      globalRatio: 2,
      ratioLimitEnabled: true,
      ratioLimit: 2,
      torrentsOverRatioLimit: 1,
    });
  });

  it("removeSeededTorrents only removes torrents that are actually seeding and meet the ratio or time goal", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/auth/login"), response: ok({}, { headers: new Headers({ "set-cookie": "SID=abc; Path=/" }) }) },
      {
        test: (u) => u.includes("/torrents/info"),
        response: ok([
          { hash: "still-downloading", state: "downloading", ratio: 5, tags: "aonarr" }, // not seeding yet, must never be removed despite a huge ratio
          { hash: "seeding-goal-met", state: "uploading", ratio: 3, tags: "aonarr" },
          { hash: "seeding-goal-not-met", state: "stalledUP", ratio: 0.1, seeding_time: 60, tags: "aonarr" },
        ]),
      },
      { test: (u) => u.includes("/torrents/delete"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const removed = await adapter().removeSeededTorrents!(await insertClient({ type: "qbittorrent" }), 2, null);

    expect(removed).toBe(1);
    const deleteCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/delete"));
    expect(deleteCall![1].body.get("hashes")).toBe("seeding-goal-met");
  });

  it("removeSeededTorrents only touches AoNarr's own torrents (its tag or its category), never other apps'", async () => {
    const fetchMock = routedFetch([
      loginRoute,
      {
        test: (u) => u.includes("/torrents/info"),
        response: ok([
          { hash: "ours-by-tag", state: "uploading", ratio: 3, tags: "aonarr, aonarr-pending-x", category: "" },
          { hash: "ours-by-category", state: "uploading", ratio: 3, tags: "", category: "aonarr-movies" },
          { hash: "sonarrs", state: "uploading", ratio: 3, tags: "", category: "tv-sonarr" },
          { hash: "manual-untagged", state: "uploading", ratio: 3 },
        ]),
      },
      { test: (u) => u.includes("/torrents/delete"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const removed = await adapter().removeSeededTorrents!(await insertClient({ type: "qbittorrent", category: "aonarr-movies" }), 2, null);

    expect(removed).toBe(2);
    const deleteCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/delete"));
    expect(deleteCall![1].body.get("hashes")).toBe("ours-by-tag|ours-by-category");
  });

  it("removeDownload posts the hash and deleteFiles flag", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/auth/login"), response: ok({}, { headers: new Headers({ "set-cookie": "SID=abc; Path=/" }) }) },
      { test: (u) => u.includes("/torrents/delete"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await adapter().removeDownload!(await insertClient({ type: "qbittorrent" }), "hash1", true);

    const deleteCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/torrents/delete"));
    expect(deleteCall![1].body.get("deleteFiles")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// SabnzbdAdapter
// ---------------------------------------------------------------------------

describe("SabnzbdAdapter", () => {
  const adapter = () => getDownloadClientAdapter("sabnzbd");

  it("addDownload posts the URL and returns the nzo id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ nzo_ids: ["SABnzbd_nzo_123"] })));

    const result = await adapter().addDownload(await insertClient({ type: "sabnzbd" }), "http://indexer/nzb", null);

    expect(result.downloadId).toBe("SABnzbd_nzo_123");
  });

  it("reports 'downloading' for a job still in the queue even at 100%, not 'completed'", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([{ test: (u) => u.includes("mode=queue"), response: ok({ queue: { slots: [{ nzo_id: "id1", percentage: "100", status: "Extracting" }] } }) }])
    );

    const updates = await adapter().getStatus(await insertClient({ type: "sabnzbd" }), ["id1"]);

    expect(updates).toEqual([{ downloadId: "id1", progress: 1, status: "downloading" }]);
  });

  it("only checks history for ids that have disappeared from the queue, and reports real completion from there", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("mode=queue"), response: ok({ queue: { slots: [{ nzo_id: "still-active", percentage: "50", status: "Downloading" }] } }) },
      {
        test: (u) => u.includes("mode=history"),
        response: (u: string) => {
          expect(u).toContain("nzo_ids=finished-id");
          return ok({ history: { slots: [{ nzo_id: "finished-id", status: "Completed", storage: "/sab/complete/movie" }] } });
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const updates = await adapter().getStatus(await insertClient({ type: "sabnzbd" }), ["still-active", "finished-id"]);

    expect(updates).toContainEqual({ downloadId: "still-active", progress: 0.5, status: "downloading" });
    expect(updates).toContainEqual({ downloadId: "finished-id", progress: 1, status: "completed", remotePath: "/sab/complete/movie" });
  });

  it("reports a failed history entry as failed, with no remotePath", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("mode=queue"), response: ok({ queue: { slots: [] } }) },
        { test: (u) => u.includes("mode=history"), response: ok({ history: { slots: [{ nzo_id: "id1", status: "Failed" }] } }) },
      ])
    );

    const updates = await adapter().getStatus(await insertClient({ type: "sabnzbd" }), ["id1"]);

    expect(updates).toEqual([{ downloadId: "id1", progress: 1, status: "failed", remotePath: undefined }]);
  });

  it("keeps reporting 'downloading' for a history entry that's still post-processing", async () => {
    const stages = ["QuickCheck", "Verifying", "Repairing", "Fetching", "Extracting", "Moving", "Running", "Queued"];
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("mode=queue"), response: ok({ queue: { slots: [] } }) },
        {
          test: (u) => u.includes("mode=history"),
          response: ok({ history: { slots: stages.map((status, i) => ({ nzo_id: `pp${i}`, status, storage: "/sab/incomplete/x" })) } }),
        },
      ])
    );

    const updates = await adapter().getStatus(
      await insertClient({ type: "sabnzbd" }),
      stages.map((_, i) => `pp${i}`)
    );

    expect(updates).toEqual(stages.map((_, i) => ({ downloadId: `pp${i}`, progress: 0.99, status: "downloading" })));
  });

  it("removeDownload tries both the queue and history locations", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("mode=queue") && u.includes("name=delete"), response: ok({}) },
      { test: (u) => u.includes("mode=history") && u.includes("name=delete"), response: ok({}) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await adapter().removeDownload!(await insertClient({ type: "sabnzbd" }), "id1", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removeDownload does not throw if one location's delete fails but the other succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u.includes("mode=queue")) throw new Error("connection reset");
        return ok({});
      })
    );

    await expect(adapter().removeDownload!(await insertClient({ type: "sabnzbd" }), "id1", true)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HttpDownloadAdapter
// ---------------------------------------------------------------------------

describe("HttpDownloadAdapter", () => {
  const adapter = () => getDownloadClientAdapter("http");

  it("downloads the file in the background and reports completed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fileResponse("fake file bytes")));

    const { downloadId } = await adapter().addDownload(await insertClient({ type: "http" }), "https://example.com/movie.mkv", null, "My Release");
    await vi.waitFor(async () => {
      const [status] = await adapter().getStatus({} as any, [downloadId]);
      expect(status.status).toBe("completed");
    });

    // HttpDownloadAdapter writes straight into config.downloadsDir itself (hardcoded, not
    // configurable), not the test-fixtures subfolder used for input fixtures elsewhere in this file.
    const files = fs.readdirSync(config.downloadsDir);
    expect(files.some((f) => f.startsWith("My Release"))).toBe(true);
  });

  it("reports failed when the fetch itself fails, and getStatus omits unknown ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { downloadId } = await adapter().addDownload(await insertClient({ type: "http" }), "https://example.com/gone.mkv", null);
    await vi.waitFor(async () => {
      const [status] = await adapter().getStatus({} as any, [downloadId]);
      expect(status.status).toBe("failed");
    });

    expect(await adapter().getStatus({} as any, ["never-existed"])).toEqual([]);
  });

  it("takes the file extension from Content-Disposition or Content-Type when the URL has no usable one", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        {
          test: (u) => u === "https://ddl.example/download/12345",
          response: () => fileResponse("bytes", { "content-disposition": 'attachment; filename="Some.Movie.2020.1080p.WEB-DL.mkv"' }),
        },
        { test: (u) => u === "https://ddl.example/get.php?id=9", response: () => fileResponse("bytes", { "content-type": "video/mp4; charset=binary" }) },
        // A real media extension in the URL outranks a generic content type (a .cbz served as application/zip).
        { test: (u) => u === "https://ddl.example/files/Issue.001.cbz", response: () => fileResponse("bytes", { "content-type": "application/zip" }) },
      ])
    );
    const client = await insertClient({ type: "http" });
    const cases = [
      { url: "https://ddl.example/download/12345", title: "DDL Disposition Release", expected: "DDL Disposition Release.mkv" },
      { url: "https://ddl.example/get.php?id=9", title: "DDL ContentType Release", expected: "DDL ContentType Release.mp4" },
      { url: "https://ddl.example/files/Issue.001.cbz", title: "DDL UrlPath Release", expected: "DDL UrlPath Release.cbz" },
    ];

    for (const c of cases) {
      const { downloadId } = await adapter().addDownload(client, c.url, null, c.title);
      await vi.waitFor(async () => {
        const [status] = await adapter().getStatus({} as any, [downloadId]);
        expect(status.status).toBe("completed");
      });
    }

    const files = fs.readdirSync(config.downloadsDir);
    for (const c of cases) {
      expect(files).toContain(c.expected);
      fs.rmSync(path.join(config.downloadsDir, c.expected), { force: true });
    }
  });

  it("keeps the requested URL's extension when the link redirects to an extensionless CDN URL", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        {
          test: (u) => u === "https://ddl.example/dl/Movie.2020.mkv",
          // fetch() follows the redirect itself, so only the final URL shows up on the response.
          response: () => ({ ...fileResponse("bytes", { "content-type": "application/octet-stream" }), url: "https://cdn.example/f/8a3f9c?sig=abc" }),
        },
      ])
    );

    const { downloadId } = await adapter().addDownload(await insertClient({ type: "http" }), "https://ddl.example/dl/Movie.2020.mkv", null, "DDL Redirect Release");
    await vi.waitFor(async () => {
      const [status] = await adapter().getStatus({} as any, [downloadId]);
      expect(status.status).toBe("completed");
    });

    expect(fs.readdirSync(config.downloadsDir)).toContain("DDL Redirect Release.mkv");
    fs.rmSync(path.join(config.downloadsDir, "DDL Redirect Release.mkv"), { force: true });
  });
});

// ---------------------------------------------------------------------------
// YtdlpAdapter
// ---------------------------------------------------------------------------

describe("YtdlpAdapter", () => {
  const adapter = () => getDownloadClientAdapter("ytdlp");

  beforeEach(() => {
    setSetting("ytdlpDownloadArchiveEnabled", "0");
    setSetting("ytdlpSponsorBlockCategories", "");
    setSetting("ytdlpEmbedSubtitles", "0");
  });

  it("spawns yt-dlp with the output template and reports progress parsed from stdout", async () => {
    const client = await insertClient({ type: "ytdlp" });
    const promise = adapter().addDownload(client, "https://youtube.com/watch?v=x", null, "My Video");
    const { downloadId } = await promise;

    expect(spawnArgs!.command).toBe("yt-dlp");
    expect(spawnArgs!.args).toContain("--newline");
    lastSpawned!.emitStdout("[download]  42.0% of 10MiB");
    const [status] = await adapter().getStatus(client, [downloadId]);
    expect(status.progress).toBeCloseTo(0.42);
    expect(status.status).toBe("downloading");
  });

  it("adds audio-only flags when the client is configured for audio", async () => {
    await adapter().addDownload(await insertClient({ type: "ytdlp", audio_only: 1 }), "https://youtube.com/watch?v=x", null);

    expect(spawnArgs!.args).toEqual(expect.arrayContaining(["-x", "--audio-format", "mp3"]));
  });

  it("adds the download-archive/SponsorBlock/subtitle flags only when opted in via settings", async () => {
    setSetting("ytdlpDownloadArchiveEnabled", "1");
    setSetting("ytdlpSponsorBlockCategories", "sponsor,intro");
    setSetting("ytdlpEmbedSubtitles", "1");

    await adapter().addDownload(await insertClient({ type: "ytdlp" }), "https://youtube.com/watch?v=x", null);

    expect(spawnArgs!.args).toEqual(expect.arrayContaining(["--download-archive", expect.stringContaining("ytdlp-archive.txt")]));
    expect(spawnArgs!.args).toEqual(expect.arrayContaining(["--sponsorblock-remove", "sponsor,intro"]));
    expect(spawnArgs!.args).toEqual(expect.arrayContaining(["--embed-subs"]));
  });

  it("reports completed on exit code 0, failed on a non-zero exit code", async () => {
    const client = await insertClient({ type: "ytdlp" });
    const { downloadId: id1 } = await adapter().addDownload(client, "https://x", null);
    lastSpawned!.emitExit(0);
    expect((await adapter().getStatus(client, [id1]))[0].status).toBe("completed");

    const { downloadId: id2 } = await adapter().addDownload(client, "https://x", null);
    lastSpawned!.emitExit(1);
    expect((await adapter().getStatus(client, [id2]))[0].status).toBe("failed");
  });

  it("reports failed when the binary itself can't be spawned", async () => {
    const client = await insertClient({ type: "ytdlp" });
    const { downloadId } = await adapter().addDownload(client, "https://x", null);

    lastSpawned!.emitError(new Error("ENOENT: yt-dlp not found"));

    expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// RealDebridAdapter
// ---------------------------------------------------------------------------

describe("RealDebridAdapter", () => {
  const adapter = () => getDownloadClientAdapter("realdebrid");

  it("adds a magnet directly, then unrestricts and downloads once caching completes on the first check", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd1" }) },
        { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
        { test: (u) => u.includes("/torrents/info/rd1"), response: ok({ status: "downloaded", links: ["https://rd/link1"] }) },
        { test: (u) => u.includes("/unrestrict/link"), response: ok({ download: "https://rd/direct1", filename: "Movie.mkv" }) },
        { test: (u) => u === "https://rd/direct1", response: fileResponse("movie bytes") },
      ])
    );
    const client = await insertClient({ type: "realdebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=urn:btih:abc", null, "Some Release");
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("completed");
    });

    expect(fs.existsSync(path.join(config.downloadsDir, "Movie.mkv"))).toBe(true); // hardcoded write target, see the http adapter test's comment above
  });

  it("saves a multi-file job into a folder named for the release and reports that folder as its path", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd-multi" }) },
        { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
        { test: (u) => u.includes("/torrents/info/rd-multi"), response: ok({ status: "downloaded", links: ["https://rd/t1", "https://rd/t2"] }) },
        {
          test: (u) => u.includes("/unrestrict/link"),
          response: (_u: string, init: any) => {
            const n = String(init.body).endsWith(encodeURIComponent("https://rd/t1")) ? 1 : 2;
            return ok({ download: `https://rd/direct-t${n}`, filename: `0${n} - Track.flac` });
          },
        },
        { test: (u) => u.startsWith("https://rd/direct-t"), response: () => fileResponse("track bytes") },
      ])
    );
    const client = await insertClient({ type: "realdebrid", api_key: "key" });
    const releaseTitle = "Some Artist - Some Album (2020) [FLAC]";
    const albumDir = path.join(config.downloadsDir, releaseTitle);
    fs.rmSync(albumDir, { recursive: true, force: true });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=urn:btih:multi", null, releaseTitle);
    let status: any;
    await vi.waitFor(async () => {
      [status] = await adapter().getStatus(client, [downloadId]);
      expect(status.status).toBe("completed");
    });

    expect(status.remotePath).toBe(albumDir);
    expect(fs.readdirSync(albumDir).sort()).toEqual(["01 - Track.flac", "02 - Track.flac"]);
    expect(fs.existsSync(path.join(config.downloadsDir, "01 - Track.flac"))).toBe(false);
    // The importer finds the job's files inside that folder whether or not it's given the path.
    const { findDownloadedFile } = await import("../src/services/importer.js");
    expect(path.dirname(findDownloadedFile(releaseTitle, "artist", undefined, status.remotePath)!)).toBe(albumDir);
    expect(path.dirname(findDownloadedFile(releaseTitle, "artist")!)).toBe(albumDir);
    fs.rmSync(albumDir, { recursive: true, force: true });
  });

  it("resolves a non-magnet download URL (proxy redirecting to a magnet) before uploading", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u === "https://indexer/get", response: { status: 302, headers: new Headers({ location: "magnet:?xt=urn:btih:resolved" }) } },
        {
          test: (u, init) => u.includes("/torrents/addMagnet"),
          response: (u: string, init: any) => {
            expect(init.body.toString()).toContain(encodeURIComponent("magnet:?xt=urn:btih:resolved"));
            return ok({ id: "rd2" });
          },
        },
        { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
        { test: (u) => u.includes("/torrents/info/rd2"), response: ok({ status: "downloaded", links: [] }) },
      ])
    );
    const client = await insertClient({ type: "realdebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "https://indexer/get", null);
    await vi.waitFor(async () => {
      // No links at all is still a defined outcome (failed, "reported no files") — proves the
      // magnet was actually resolved and accepted rather than the flow silently never running.
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });

  it("reports failed when Real-Debrid reports an error/dead/virus status", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd3" }) },
        { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
        { test: (u) => u.includes("/torrents/info/rd3"), response: ok({ status: "dead" }) },
      ])
    );
    const client = await insertClient({ type: "realdebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });

  it("uploads raw .torrent bytes via PUT /torrents/addTorrent when the resolved source isn't a magnet", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u === "https://indexer/get", response: ok({}) }, // resolveDownloadSource: 200, not a redirect -> torrent bytes
        {
          test: (u, init) => u.includes("/torrents/addTorrent"),
          response: (u: string, init: any) => {
            expect(init.method).toBe("PUT");
            return ok({ id: "rd-bytes" });
          },
        },
        { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
        { test: (u) => u.includes("/torrents/info/rd-bytes"), response: ok({ status: "downloaded", links: [] }) },
      ])
    );
    const client = await insertClient({ type: "realdebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "https://indexer/get", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"); // "reported no files" -- proves addTorrent's id was accepted and reached the poll
    });
  });

  it("treats selectFiles's 202 (already selected) as success rather than an error", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd202" }) },
        { test: (u) => u.includes("/torrents/selectFiles"), response: notOk(202) },
        { test: (u) => u.includes("/torrents/info/rd202"), response: ok({ status: "downloaded", links: ["https://rd/link"] }) },
        { test: (u) => u.includes("/unrestrict/link"), response: ok({ download: "https://rd/direct", filename: "Movie.mkv" }) },
        { test: (u) => u === "https://rd/direct", response: fileResponse("bytes") },
      ])
    );
    const client = await insertClient({ type: "realdebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("completed");
    });
  });

  it("reports failed when selectFiles or unrestrict/link return a real (non-202) error status", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd-sf-fail" }) },
        { test: (u) => u.includes("/torrents/selectFiles"), response: notOk(500) },
      ])
    );
    let client = await insertClient({ type: "realdebrid", api_key: "key" });
    let { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));

    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd-unr-fail" }) },
        { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
        { test: (u) => u.includes("/torrents/info/rd-unr-fail"), response: ok({ status: "downloaded", links: ["https://rd/link"] }) },
        { test: (u) => u.includes("/unrestrict/link"), response: notOk(500) },
      ])
    );
    client = await insertClient({ type: "realdebrid", api_key: "key" });
    ({ downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null));
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));
  });

  it("reports progress while polling, and fails once the 6-hour polling window elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/torrents/addMagnet"), response: ok({ id: "rd-poll" }) },
      { test: (u) => u.includes("/torrents/selectFiles"), response: ok({}) },
      { test: (u) => u.includes("/torrents/info/rd-poll"), response: ok({ status: "downloading", progress: 55 }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "realdebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.advanceTimersByTimeAsync(1); // let the first (in-progress) poll land
    expect((await adapter().getStatus(client, [downloadId]))[0].progress).toBeCloseTo(0.55);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 10_000); // past DEBRID_POLL_TIMEOUT_MS
    await vi.waitFor(
      async () => {
        expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
      },
      { timeout: 2000 }
    );
  });
});

// ---------------------------------------------------------------------------
// TorBoxAdapter
// ---------------------------------------------------------------------------

describe("TorBoxAdapter", () => {
  const adapter = () => getDownloadClientAdapter("torbox");

  it("normalizes a 0-100 percentage progress value to a 0-1 fraction while polling", async () => {
    vi.useFakeTimers();
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb1" } }) },
      {
        test: (u) => u.includes("/torrents/mylist"),
        response: () => {
          const stillGoing = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/torrents/mylist")).length <= 1;
          return ok({ data: stillGoing ? { progress: 42, download_finished: false } : { progress: 100, download_finished: true, files: [{ id: 1, name: "f.mkv" }] } });
        },
      },
      { test: (u) => u.includes("/torrents/requestdl"), response: ok({ data: "https://tb/direct" }) },
      { test: (u) => u === "https://tb/direct", response: fileResponse("bytes") },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "torbox", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.advanceTimersByTimeAsync(1); // let the first (in-progress) poll land
    expect((await adapter().getStatus(client, [downloadId]))[0].progress).toBeCloseTo(0.42);

    await vi.advanceTimersByTimeAsync(5000); // the sleep between polls
    await vi.waitFor(
      async () => {
        expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("completed");
      },
      { timeout: 2000 }
    );
  });

  it("reports failed when TorBox's own API rejects the upload with success:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ success: false, detail: "Invalid magnet" })));
    const client = await insertClient({ type: "torbox", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);

    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });

  it("uploads raw .torrent bytes as multipart form-data when the resolved source isn't a magnet", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u === "https://indexer/get", response: ok({}) }, // resolveDownloadSource: 200, not a redirect -> torrent bytes
        { test: (u) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb-bytes" } }) },
        { test: (u) => u.includes("/torrents/mylist"), response: ok({ data: { download_finished: true, files: [] } }) },
      ])
    );
    const client = await insertClient({ type: "torbox", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "https://indexer/get", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"); // "reported no files" -- proves createtorrent's id was accepted
    });
  });

  it("handles body.data coming back as an array (not just a bare object) when polling mylist", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb-arr" } }) },
        { test: (u) => u.includes("/torrents/mylist"), response: ok({ data: [{ download_present: true, files: [{ id: 1, name: "f.mkv" }] }] }) },
        { test: (u) => u.includes("/torrents/requestdl"), response: ok({ data: "https://tb/direct-arr" }) },
        { test: (u) => u === "https://tb/direct-arr", response: fileResponse("bytes") },
      ])
    );
    const client = await insertClient({ type: "torbox", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("completed");
    });
  });

  it("reports failed on a bad download_state, no files, a rejected createtorrent, and a missing torrent id", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb-state" } }) },
        { test: (u) => u.includes("/torrents/mylist"), response: ok({ data: { download_state: "error", download_finished: false } }) },
      ])
    );
    let client = await insertClient({ type: "torbox", api_key: "key" });
    let { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));

    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb-nofiles" } }) },
        { test: (u) => u.includes("/torrents/mylist"), response: ok({ data: { download_finished: true, files: [] } }) },
      ])
    );
    client = await insertClient({ type: "torbox", api_key: "key" });
    ({ downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null));
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ data: {} }))); // createtorrent: success, but no torrent_id/id anywhere
    client = await insertClient({ type: "torbox", api_key: "key" });
    ({ downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null));
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));
  });

  it("routes to the /usenet/... endpoints instead of /torrents/... when the release protocol is usenet", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/usenet/createusenetdownload"), response: ok({ data: { usenetdownload_id: "u1" } }) },
      { test: (u) => u.includes("/usenet/mylist"), response: ok({ data: { download_finished: true, files: [{ id: 1, name: "f.mkv" }] } }) },
      { test: (u) => u.includes("/usenet/requestdl"), response: ok({ data: "https://tb/direct-usenet" }) },
      { test: (u) => u === "https://tb/direct-usenet", response: fileResponse("bytes") },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "torbox", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "https://indexer/download.nzb", null, "Some.Release", "usenet");
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("completed");
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/torrents/"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AllDebridAdapter
// ---------------------------------------------------------------------------

describe("AllDebridAdapter", () => {
  const adapter = () => getDownloadClientAdapter("alldebrid");

  it("reads the accepted magnet's id from magnets[] (not files[]) for a magnet upload", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/magnet/upload"), response: ok({ status: "success", data: { magnets: [{ id: "ad1" }] } }) },
        { test: (u) => u.includes("magnet/status"), response: ok({ status: "success", data: { magnets: [{ statusCode: 5, status: "Error" }] } }) },
      ])
    );
    const client = await insertClient({ type: "alldebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"); // proves it reached the status poll at all, i.e. magnetId was found
    });
  });

  it("reads the accepted upload's id from files[] (not magnets[]) for a .torrent-bytes upload", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u === "https://indexer/get", response: ok({}) }, // resolveDownloadSource: not a magnet -> fetched as torrent bytes
        { test: (u) => u.includes("/magnet/upload/file"), response: ok({ status: "success", data: { files: [{ id: "ad2" }] } }) },
        { test: (u) => u.includes("magnet/status"), response: ok({ status: "success", data: { magnets: [{ statusCode: 5, status: "Error" }] } }) },
      ])
    );
    const client = await insertClient({ type: "alldebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "https://indexer/get", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });

  it("handles data.magnets coming back as a bare object instead of an array when polling status", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/magnet/upload"), response: ok({ status: "success", data: { magnets: [{ id: "ad3" }] } }) },
        // v4.1 status endpoint: magnets as a single object, not wrapped in an array.
        { test: (u) => u.includes("magnet/status"), response: ok({ status: "success", data: { magnets: { statusCode: 5, status: "Error" } } }) },
      ])
    );
    const client = await insertClient({ type: "alldebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });

  it("resolves ready (statusCode 4) magnets via the dedicated /magnet/files endpoint, recursing through folders", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/magnet/upload"), response: ok({ status: "success", data: { magnets: [{ id: "ad4" }] } }) },
        { test: (u) => u.includes("magnet/status"), response: ok({ status: "success", data: { magnets: [{ statusCode: 4 }] } }) },
        {
          test: (u) => u.includes("/magnet/files"),
          // A single real file nested one folder deep (proves the recursive walk descends into
          // folders), plus a malformed sibling entry with neither `l` nor `e` (proves walk() just
          // skips it rather than crashing) — deliberately only one downloadable link: a second one
          // sharing this same mocked Response would fail, since a ReadableStream body can only be
          // consumed once, and that's not what this test is about.
          response: ok({
            status: "success",
            data: { magnets: [{ files: [{ n: "folder", e: [{ n: "movie.mkv", l: "https://ad/dl/1" }] }, { n: "malformed-entry" }] }] },
          }),
        },
        { test: (u) => u.includes("/link/unlock"), response: ok({ status: "success", data: { link: "https://ad/direct", filename: "movie.mkv" } }) },
        { test: (u) => u === "https://ad/direct", response: () => fileResponse("bytes") },
      ])
    );
    const client = await insertClient({ type: "alldebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("completed");
    });

    expect(fs.existsSync(path.join(config.downloadsDir, "movie.mkv"))).toBe(true); // hardcoded write target, see the http adapter test's comment
  });

  it("surfaces AllDebrid's own status:error responses (the generic call() helper's error branch)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ status: "error", error: { message: "Invalid API key", code: "AUTH_BAD_APIKEY" } })));
    const client = await insertClient({ type: "alldebrid", api_key: "bad-key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });

  it("uses the rejected magnet's own error message when present, and a generic one when it isn't", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ status: "success", data: { magnets: [{ error: { message: "MAGNET_INVALID_URI" } }] } })));
    let client = await insertClient({ type: "alldebrid", api_key: "key" });
    let { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ status: "success", data: { magnets: [{}] } }))); // no id, no error
    client = await insertClient({ type: "alldebrid", api_key: "key" });
    ({ downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null));
    await vi.waitFor(async () => expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed"));
  });

  it("reports failed when link/unlock returns no direct link", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u.includes("/magnet/upload"), response: ok({ status: "success", data: { magnets: [{ id: "ad-unlock" }] } }) },
        { test: (u) => u.includes("magnet/status"), response: ok({ status: "success", data: { magnets: [{ statusCode: 4 }] } }) },
        { test: (u) => u.includes("/magnet/files"), response: ok({ status: "success", data: { magnets: [{ files: [{ n: "movie.mkv", l: "https://ad/dl/1" }] }] } }) },
        { test: (u) => u.includes("/link/unlock"), response: ok({ status: "success", data: {} }) }, // no `link` field
      ])
    );
    const client = await insertClient({ type: "alldebrid", api_key: "key" });

    const { downloadId } = await adapter().addDownload(client, "magnet:?xt=x", null);
    await vi.waitFor(async () => {
      expect((await adapter().getStatus(client, [downloadId]))[0].status).toBe("failed");
    });
  });
});

// ---------------------------------------------------------------------------
// BlackholeAdapter
// ---------------------------------------------------------------------------

describe("BlackholeAdapter", () => {
  const adapter = () => getDownloadClientAdapter("blackhole");

  it("throws when no watch folder is configured", async () => {
    await expect(adapter().addDownload({ host: null } as any, "magnet:?xt=x", null)).rejects.toThrow("no watch folder");
  });

  it("writes a .magnet file for a magnet URI", async () => {
    await adapter().addDownload({ host: downloadsDir } as any, "magnet:?xt=x", null, "My Release");

    const files = fs.readdirSync(downloadsDir);
    const magnetFile = files.find((f) => f.endsWith(".magnet"));
    expect(magnetFile).toBeTruthy();
    expect(fs.readFileSync(path.join(downloadsDir, magnetFile!), "utf-8")).toBe("magnet:?xt=x");
  });

  it("sniffs XML content and writes a .nzb file instead of .torrent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from("<?xml version=\"1.0\"?><nzb></nzb>") }));

    await adapter().addDownload({ host: downloadsDir } as any, "https://indexer/release.nzb", null, "NZB Release");

    expect(fs.readdirSync(downloadsDir).some((f) => f.endsWith(".nzb"))).toBe(true);
  });

  it("writes a .torrent file for non-XML content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from("d8:announce...") }));

    await adapter().addDownload({ host: downloadsDir } as any, "https://indexer/release.torrent", null, "Torrent Release");

    expect(fs.readdirSync(downloadsDir).some((f) => f.endsWith(".torrent"))).toBe(true);
  });

  it("getStatus always reports downloading (fire-and-forget, no real progress)", async () => {
    const result = await adapter().getStatus({} as any, ["a", "b"]);
    expect(result).toEqual([
      { downloadId: "a", progress: 0, status: "downloading" },
      { downloadId: "b", progress: 0, status: "downloading" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// SlskdAdapter
// ---------------------------------------------------------------------------

describe("SlskdAdapter", () => {
  const adapter = () => getDownloadClientAdapter("slskd");

  it("addDownload enqueues by username/filename and encodes both into the downloadId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({}));
    vi.stubGlobal("fetch", fetchMock);
    const client = await insertClient({ type: "slskd", api_key: "key" });

    const result = await adapter().addDownload(client, "slskd://someuser/some%2Ffile.mp3?size=100");

    expect(result.downloadId).toBe("someuser some/file.mp3");
    expect(fetchMock.mock.calls[0][0]).toContain("/transfers/downloads/someuser");
  });

  it("getStatus matches transfers by username+filename and maps slskd's state strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ok([
          {
            username: "someuser",
            directories: [
              {
                files: [
                  { filename: "song.mp3", state: "Completed, Succeeded", size: 100, bytesTransferred: 100 },
                  { filename: "other.mp3", state: "InProgress", size: 200, bytesTransferred: 50 },
                ],
              },
            ],
          },
        ])
      )
    );

    const updates = await adapter().getStatus({} as any, ["someuser song.mp3", "someuser other.mp3"]);

    expect(updates).toContainEqual({ downloadId: "someuser song.mp3", progress: 1, status: "completed" });
    expect(updates).toContainEqual({ downloadId: "someuser other.mp3", progress: 0.25, status: "downloading" });
  });

  it("getStatus maps every terminal state other than Succeeded to failed", async () => {
    const terminal = ["Completed, Rejected", "Completed, TimedOut", "Completed, Errored", "Completed, Cancelled", "Completed, Aborted"];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ok([
          {
            username: "peer",
            directories: [
              {
                files: [
                  ...terminal.map((state, i) => ({ filename: `t${i}.flac`, state, size: 100, bytesTransferred: 0 })),
                  { filename: "waiting.flac", state: "Queued, Remotely", size: 100, bytesTransferred: 0 },
                ],
              },
            ],
          },
        ])
      )
    );

    const updates = await adapter().getStatus({} as any, [...terminal.map((_, i) => `peer t${i}.flac`), "peer waiting.flac"]);

    for (let i = 0; i < terminal.length; i++) {
      expect(updates).toContainEqual({ downloadId: `peer t${i}.flac`, progress: 0, status: "failed" });
    }
    expect(updates).toContainEqual({ downloadId: "peer waiting.flac", progress: 0, status: "downloading" });
  });

  it("getStatus ignores transfers that weren't asked about", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok([{ username: "someuser", directories: [{ files: [{ filename: "unwanted.mp3", state: "InProgress", size: 1, bytesTransferred: 0 }] }] }]))
    );

    expect(await adapter().getStatus({} as any, ["someuser wanted.mp3"])).toEqual([]);
  });
});
