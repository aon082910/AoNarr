import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { __setHealthTimeoutsForTests as SetTimeouts } from "../src/services/healthReport.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let getHealthReport: (typeof import("../src/services/healthReport.js"))["getHealthReport"];
let setHealthTimeouts: typeof SetTimeouts;
let clearHealthReportCache: (typeof import("../src/services/healthReport.js"))["clearHealthReportCache"];
let registerJob: (typeof import("../src/services/jobRegistry.js"))["registerJob"];
let createNotificationConnection: (typeof import("../src/services/notificationConnections.js"))["createNotificationConnection"];
let updateNotificationConnection: (typeof import("../src/services/notificationConnections.js"))["updateNotificationConnection"];
let setSetting: (key: string, value: string) => void;
let notifyGrabbed: (typeof import("../src/services/notifications.js"))["notifyGrabbed"];
let resetNotificationFailures: (typeof import("../src/services/notifications.js"))["__resetNotificationFailuresForTests"];
let config: (typeof import("../src/config.js"))["config"];
let baseDir: string;
let uniqueCounter = 0;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ getHealthReport, clearHealthReportCache, __setHealthTimeoutsForTests: setHealthTimeouts } = await import("../src/services/healthReport.js"));
  ({ registerJob } = await import("../src/services/jobRegistry.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ notifyGrabbed, __resetNotificationFailuresForTests: resetNotificationFailures } = await import("../src/services/notifications.js"));
  ({ createNotificationConnection, updateNotificationConnection } = await import("../src/services/notificationConnections.js"));
  ({ config } = await import("../src/config.js"));
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-health-"));
});

beforeEach(async () => {
  clearHealthReportCache();
  for (const table of ["queue", "import_lists", "indexer_status", "indexers", "download_clients", "root_folders", "job_runs"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  setSetting("backupEnabled", "0");
  setSetting("backupProblem", "");
  setSetting("recycleBinDir", "");
  // Every indexer and client probe fails fast and offline.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function issuesOf(sourcePrefix?: string) {
  clearHealthReportCache();
  const report = await getHealthReport({ refresh: true });
  return sourcePrefix ? report.issues.filter((i) => i.source.startsWith(sourcePrefix)) : report.issues;
}

describe("getHealthReport — the checks Sonarr has and AoNarr lacked (RB8)", () => {
  it("reports a root folder that is gone, as an issue that may clear by itself after a reboot", async () => {
    const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(path.join(baseDir, "unmounted"))).lastInsertRowid);

    const issues = await issuesOf("root-folder:");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: `root-folder:${id}`, severity: "warning", transient: true });
    expect(issues[0].message).toContain("Is the share mounted?");
  });

  it("reports an import list whose last sync failed, and ignores one that is disabled", async () => {
    await db.prepare("INSERT INTO import_lists (name, type, url, enabled, last_error) VALUES ('Trakt Watchlist', 'trakt', 'u', 1, 'HTTP 401')").run();
    await db.prepare("INSERT INTO import_lists (name, type, url, enabled, last_error) VALUES ('Old List', 'trakt', 'u', 0, 'HTTP 500')").run();
    await db.prepare("INSERT INTO import_lists (name, type, url, enabled, last_error) VALUES ('Fine List', 'trakt', 'u', 1, '')").run();

    const issues = await issuesOf("import-list:");

    expect(issues.map((i) => i.message)).toEqual(['Import list "Trakt Watchlist" failed its last sync: HTTP 401']);
  });

  it("reports a job whose last three runs failed", async () => {
    const key = `health-job-${++uniqueCounter}`;
    registerJob({ key, name: "Flaky Sync", scheduleType: "cron", defaultSchedule: "0 3 * * *", run: async () => {} });
    for (const hour of [1, 2, 3]) {
      await db
        .prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error) VALUES (?, ?, ?, 'error', 'HTTP 503')")
        .run(key, `2026-03-01T0${hour}:00:00.000Z`, `2026-03-01T0${hour}:00:01.000Z`);
    }

    const issues = await issuesOf(`job:${key}`);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Job "Flaky Sync" failed its last 3 runs: HTTP 503');
  });

  it("reports a failed backup both as a config warning and as an issue", async () => {
    setSetting("backupEnabled", "1");
    setSetting("backupProblem", "Scheduled backup failed: disk full");

    const report = await getHealthReport({ refresh: true });

    expect(report.configWarnings).toContainEqual({ key: "backup_failed", message: "Scheduled backup failed: disk full" });
    expect(report.issues.find((i) => i.source === "backup")?.message).toBe("Scheduled backup failed: disk full");
  });

  it("reports an unwritable recycle bin as an error", async () => {
    const blocker = path.join(baseDir, `bin-blocker-${++uniqueCounter}`);
    fs.writeFileSync(blocker, "x");
    setSetting("recycleBinDir", path.join(blocker, "bin"));

    const issues = await issuesOf("recycle-bin");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toContain("not writable");
  });

  it("reports a library type that no enabled indexer searches", async () => {
    const folder = path.join(baseDir, `tv-${++uniqueCounter}`);
    fs.mkdirSync(folder);
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'series')").run(folder);
    await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES ('Movies Only', 'torznab', 'http://x', 'movie', 1)").run();

    const issues = await issuesOf("no-indexer-for:");

    expect(issues.map((i) => i.message)).toEqual(['No enabled indexer searches the "series" library, so nothing for it will ever be found']);
  });

  it("reports an indexer that is being left alone after failures, from the stored state, until it is over", async () => {
    const id = Number((await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES ('Flaky', 'torznab', 'http://x', 'movie', 1)").run()).lastInsertRowid);
    await db
      .prepare("INSERT INTO indexer_status (indexer_id, consecutive_failures, backoff_until, backoff_reason, backoff_set_at) VALUES (?, 3, ?, 'failures', ?)")
      .run(id, new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());

    let issues = await issuesOf("indexer-backoff:");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Indexer "Flaky" is not being searched until');
    expect(issues[0].message).toContain("3 failed search(es) in a row");

    await db.prepare("UPDATE indexer_status SET backoff_until = ?").run(new Date(Date.now() - 1000).toISOString());
    issues = await issuesOf("indexer-backoff:");
    expect(issues).toEqual([]);
  });
});

describe("getHealthReport — download clients (DL13)", () => {
  async function addClient(type = "qbittorrent"): Promise<number> {
    return Number(
      (await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('Seedbox', ?, 'client.local', 8080, 1)").run(type)).lastInsertRowid
    );
  }

  async function addCompletedDownload(clientId: number, downloadPath: string): Promise<void> {
    const mediaId = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'M', 'm', 1, 0, 'missing')").run()).lastInsertRowid
    );
    await db
      .prepare("INSERT INTO queue (media_item_id, title, download_client_id, status, download_path) VALUES (?, 'Release', ?, 'completed', ?)")
      .run(mediaId, clientId, downloadPath);
  }

  it("reports a finished download whose reported folder AoNarr cannot see, once per client", async () => {
    const clientId = await addClient();
    await addCompletedDownload(clientId, "/data/downloads/Missing.Movie.2020");
    await addCompletedDownload(clientId, "/data/downloads/Missing.Movie.2021");

    const issues = await issuesOf("download-path:");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Download client "Seedbox" reports a finished download at');
    expect(issues[0].message).toContain("Remote Path Mappings");
  });

  it("says nothing when the reported folder exists", async () => {
    const clientId = await addClient();
    const dir = path.join(baseDir, `done-${++uniqueCounter}`);
    fs.mkdirSync(dir);
    await addCompletedDownload(clientId, dir);

    expect(await issuesOf("download-path:")).toEqual([]);
  });

  it("includes what a client's own settings would do to a download", async () => {
    await addClient("qbittorrent");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/auth/login")) return { ok: true, status: 200, text: async () => "Ok.", headers: new Headers({ "set-cookie": "SID=1" }) };
        if (String(url).includes("/app/preferences")) {
          return { ok: true, status: 200, json: async () => ({ max_ratio_enabled: true, max_ratio: 1, max_ratio_act: 1 }) };
        }
        return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
      })
    );

    const issues = await issuesOf("download-client-config:");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/^Download client "Seedbox": is set to remove torrents/);
  });
});

describe("getHealthReport — keeping the result (RB8)", () => {
  it("serves the same report to a second page load without running the checks again, until refreshed", async () => {
    const first = await getHealthReport({ refresh: true });
    const second = await getHealthReport();
    expect(second).toBe(first);

    const refreshed = await getHealthReport({ refresh: true });
    expect(refreshed).not.toBe(first);
    expect(refreshed.checkedAt >= first.checkedAt).toBe(true);
  });

  it("does not ping an indexer on a page load once the report is cached", async () => {
    await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES ('Pinged', 'torznab', 'http://idx.local', 'movie', 1)").run();
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await getHealthReport({ refresh: true });
    const callsAfterBuild = fetchMock.mock.calls.length;
    expect(callsAfterBuild).toBeGreaterThan(0);

    await getHealthReport();
    await getHealthReport();
    expect(fetchMock.mock.calls.length).toBe(callsAfterBuild);
  });

  it("shares one run between callers that arrive together", async () => {
    clearHealthReportCache();
    const [a, b] = await Promise.all([getHealthReport({ refresh: true }), getHealthReport({ refresh: true })]);
    expect(a).toBe(b);
  });
});

describe("getHealthReport — review fixes", () => {
  it("does not call an import list's 'items not added' warning a failure (F5)", async () => {
    await db
      .prepare("INSERT INTO import_lists (name, type, url, enabled, last_error) VALUES ('Mixed List', 'trakt', 'u', 1, ?)")
      .run("Added 5; 3 item(s) not added: no root folder is configured for series, book");
    expect(await issuesOf("import-list:")).toEqual([]);
  });

  it("does not ask for an indexer for a podcast or video library, nor when an IRC feed or Soulseek serves the type (F6)", async () => {
    const make = (name: string) => {
      const dir = path.join(baseDir, `${name}-${++uniqueCounter}`);
      fs.mkdirSync(dir);
      return dir;
    };
    await db.prepare("INSERT INTO indexers (name, protocol, url, media_types, enabled) VALUES ('Movies Only', 'torznab', 'http://x', 'movie', 1)").run();
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'podcast')").run(make("pod"));
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'video')").run(make("vid"));
    expect(await issuesOf("no-indexer-for:")).toEqual([]);

    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'artist')").run(make("music"));
    expect((await issuesOf("no-indexer-for:")).map((i) => i.source)).toEqual(["no-indexer-for:artist"]);
    await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('slskd', 'slskd', 'h', 5030, 1)").run();
    expect(await issuesOf("no-indexer-for:")).toEqual([]);

    await db.prepare("DELETE FROM download_clients").run();
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'series')").run(make("tv"));
    expect((await issuesOf("no-indexer-for:")).length).toBe(2);
    await db
      .prepare("INSERT INTO irc_feeds (name, host, nickname, channel, announce_regex, enabled) VALUES ('Feed', 'irc.x', 'me', '#c', '.*', 1)")
      .run();
    expect(await issuesOf("no-indexer-for:")).toEqual([]);
    await db.prepare("DELETE FROM irc_feeds").run();
  });

  it("does not create a missing recycle bin folder, and says nothing about one that is not there yet (F4)", async () => {
    const bin = path.join(baseDir, `never-created-${++uniqueCounter}`);
    setSetting("recycleBinDir", bin);
    expect(await issuesOf("recycle-bin")).toEqual([]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("gives up on a check that never finishes and still returns the rest of the report (F4)", async () => {
    const dir = path.join(baseDir, `hung-root-${++uniqueCounter}`);
    fs.mkdirSync(dir);
    await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(dir);
    const realStat = fs.promises.stat;
    const spy = vi.spyOn(fs.promises, "stat").mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === dir ? new Promise(() => {}) : (realStat as any)(p, ...rest)) as any);
    setHealthTimeouts({ check: 80 });
    try {
      clearHealthReportCache();
      const started = Date.now();
      const report = await getHealthReport({ refresh: true });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(Array.isArray(report.issues)).toBe(true);
      expect(report.issues.some((i) => i.source.startsWith("root-folder:"))).toBe(false); // that check was given up on
    } finally {
      setHealthTimeouts({ check: 60_000 });
      spy.mockRestore();
    }
  });

  it("does not hold every later caller when a whole build never finishes (F4)", async () => {
    setHealthTimeouts({ build: 50 });
    // A client probe that never answers makes the build itself stall.
    await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('Mute', 'qbittorrent', 'mute.local', 8080, 1)").run();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    try {
      clearHealthReportCache();
      await expect(getHealthReport({ refresh: true })).rejects.toThrow(/did not finish/);
      // the next caller starts a fresh build instead of inheriting the stuck one
      setHealthTimeouts({ build: 3 * 60 * 1000 });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      const report = await getHealthReport({ refresh: true });
      expect(report.downloadClients[0]).toMatchObject({ name: "Mute", ok: false });
    } finally {
      setHealthTimeouts({ build: 3 * 60 * 1000 });
    }
  });
});

describe("getHealthReport — notification connections that keep failing", () => {
  const DISCORD = "https://discord.example/api/webhooks/123/super-secret-token";
  let connectionId: number;

  beforeEach(async () => {
    resetNotificationFailures();
    await db.prepare("DELETE FROM notification_connections").run();
    connectionId = (await createNotificationConnection({ name: "Discord", kind: "discord", config: { webhookUrl: DISCORD } })).id;
  });

  afterEach(async () => {
    await db.prepare("DELETE FROM notification_connections").run();
    resetNotificationFailures();
  });

  function webhooksAnswer(status: number): void {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status })));
  }

  it("reports a provider whose sends failed twice in a row, naming the provider, the count, the start and the last error", async () => {
    webhooksAnswer(500);
    await notifyGrabbed("Movie", "Release");
    await notifyGrabbed("Movie", "Release");

    const issues = await issuesOf("notification:");

    expect(issues).toHaveLength(1);
    // Each connection is its own issue (its id is the source), and the message names it.
    expect(issues[0]).toMatchObject({ source: `notification:${connectionId}`, severity: "warning", transient: true });
    expect(issues[0].message).toMatch(
      /^Notifications to Discord have failed 2 times in a row since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(last error: Webhook POST to discord\.example failed: HTTP 500\)\.$/
    );
  });

  it("does not put the webhook's secret path in the message", async () => {
    webhooksAnswer(403);
    await notifyGrabbed("Movie", "Release");
    await notifyGrabbed("Movie", "Release");

    const issues = await issuesOf("notification:");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).not.toContain("super-secret-token");
  });

  it("says nothing after a single failure, which may be a blip", async () => {
    webhooksAnswer(500);
    await notifyGrabbed("Movie", "Release");

    expect(await issuesOf("notification:")).toEqual([]);
  });

  it("stops reporting the provider after its next successful send", async () => {
    webhooksAnswer(500);
    await notifyGrabbed("Movie", "Release");
    await notifyGrabbed("Movie", "Release");
    expect(await issuesOf("notification:")).toHaveLength(1);

    webhooksAnswer(200);
    await notifyGrabbed("Movie", "Release");

    expect(await issuesOf("notification:")).toEqual([]);
  });

  it("says nothing when no provider has ever failed", async () => {
    webhooksAnswer(200);
    await notifyGrabbed("Movie", "Release");

    expect(await issuesOf("notification:")).toEqual([]);
  });

  it("stops reporting a connection nothing has been sent to for a day, and one the admin switches off at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.parse("2026-03-01T10:00:00.000Z");
      vi.setSystemTime(start);
      webhooksAnswer(500);
      await notifyGrabbed("Movie", "Release");
      await notifyGrabbed("Movie", "Release");

      vi.setSystemTime(start + 23 * 60 * 60 * 1000);
      expect(await issuesOf("notification:")).toHaveLength(1);

      vi.setSystemTime(start + 25 * 60 * 60 * 1000);
      expect(await issuesOf("notification:")).toEqual([]);

      // A new failure brings it back, and switching the connection off ends the report without waiting a day.
      await notifyGrabbed("Movie", "Release");
      expect(await issuesOf("notification:")).toHaveLength(1);
      await updateNotificationConnection(connectionId, { enabled: false });
      expect(await issuesOf("notification:")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getHealthReport — the outbound proxy", () => {
  beforeEach(() => {
    setSetting("socks5ProxyUrl", "");
  });

  afterEach(() => {
    setSetting("socks5ProxyUrl", "");
    vi.restoreAllMocks();
  });

  /** A port nothing listens on: it was just free, and is closed again. */
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  /** A TCP server that accepts a connection and drops it, as a proxy that is up would. */
  async function proxyThatIsUp(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  /** Stands in for net.connect: records where the check dialled and then fails the way `how` says. */
  function dialling(how: "refused" | "times-out") {
    const socket = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    socket.destroy = vi.fn();
    socket.setTimeout = vi.fn((_ms: number, onTimeout: () => void) => {
      if (how === "times-out") setImmediate(onTimeout);
    });
    const connect = vi.spyOn(net, "connect").mockImplementation((() => {
      if (how === "refused") setImmediate(() => socket.emit("error", new Error("connect ECONNREFUSED")));
      return socket;
    }) as never);
    return { socket, connect };
  }

  it("says nothing when no proxy is configured, and does not dial anything", async () => {
    const { connect } = dialling("refused");

    expect(await issuesOf("proxy")).toEqual([]);
    setSetting("socks5ProxyUrl", "   ");
    expect(await issuesOf("proxy")).toEqual([]);

    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["socks5", "socks4", "http"])("says nothing when a %s proxy accepts a connection", async (scheme) => {
    const proxy = await proxyThatIsUp();
    try {
      setSetting("socks5ProxyUrl", `${scheme}://user:secret@127.0.0.1:${proxy.port}`);

      expect(await issuesOf("proxy")).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("warns, as something that may clear itself, when the proxy does not accept connections, without its credentials", async () => {
    const port = await closedPort();
    setSetting("socks5ProxyUrl", `socks5://proxyuser:proxypass@127.0.0.1:${port}`);

    const issues = await issuesOf("proxy");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "proxy", severity: "warning", transient: true });
    expect(issues[0].message).toBe(
      `The outbound proxy socks5://127.0.0.1:${port} does not accept connections. Everything that is sent through it fails until it is back.`
    );
    expect(issues[0].message).not.toContain("proxypass");
    expect(issues[0].message).not.toContain("proxyuser");
  });

  it.each([
    ["socks5://proxy.local", 1080],
    ["socks4://proxy.local", 1080],
    ["http://proxy.local", 80],
    ["https://proxy.local", 443],
    ["http://proxy.local:3128", 3128],
  ])("dials %s on port %i", async (url, port) => {
    const { connect } = dialling("refused");
    setSetting("socks5ProxyUrl", url);

    const issues = await issuesOf("proxy");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ host: "proxy.local", port });
    expect(issues[0].message).toContain(`proxy.local:${port} does not accept connections`);
  });

  it("gives up on a proxy that never answers after five seconds, and closes the connection it left open", async () => {
    const { socket } = dialling("times-out");
    setSetting("socks5ProxyUrl", "socks5://proxy.local:1080");

    const issues = await issuesOf("proxy");

    expect(socket.setTimeout).toHaveBeenCalledWith(5000, expect.any(Function));
    expect(socket.destroy).toHaveBeenCalled();
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("does not accept connections");
  });

  it("reports a proxy setting that cannot be used as an error, without the credentials, and does not dial it", async () => {
    const { connect } = dialling("refused");
    setSetting("socks5ProxyUrl", "ftp://proxyuser:proxypass@proxy.local:21");

    const issues = await issuesOf("proxy");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "proxy", severity: "error", transient: false });
    expect(issues[0].message).toBe(
      'The outbound proxy "ftp://***@proxy.local:21" must start with socks5://, socks4://, http:// or https://, so requests that need it are refused instead of going out directly.'
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports a proxy setting that is not a URL at all", async () => {
    setSetting("socks5ProxyUrl", "proxy.local 1080");

    const issues = await issuesOf("proxy");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", transient: false });
    expect(issues[0].message).toContain("must be a URL such as socks5://host:1080 or http://host:3128");
  });

  // An IPv6 literal comes out of URL.hostname with its brackets ("[::1]"), which net.connect cannot resolve.
  it("dials an IPv6 proxy without the brackets around its address, and names it with them", async () => {
    const { connect } = dialling("refused");
    setSetting("socks5ProxyUrl", "socks5://[::1]:1080");

    const issues = await issuesOf("proxy");

    expect(connect).toHaveBeenCalledWith({ host: "::1", port: 1080 });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("socks5://[::1]:1080 does not accept connections");
  });

  it("dials an IPv6 proxy on the default port when the URL names none", async () => {
    const { connect } = dialling("refused");
    setSetting("socks5ProxyUrl", "http://[2001:db8::1]");

    await issuesOf("proxy");

    expect(connect).toHaveBeenCalledWith({ host: "2001:db8::1", port: 80 });
  });

  /** A TCP server on the IPv6 loopback, or null where the container has no ::1. */
  async function ipv6ProxyThatIsUp(): Promise<{ port: number; close: () => Promise<void> } | null> {
    const server = net.createServer((socket) => socket.destroy());
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, "::1", () => resolve(true));
    });
    if (!listening) return null;
    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("says nothing when an IPv6 proxy that is really listening accepts a connection", async (context) => {
    const proxy = await ipv6ProxyThatIsUp();
    if (!proxy) return context.skip();
    try {
      setSetting("socks5ProxyUrl", `socks5://[::1]:${proxy.port}`);

      expect(await issuesOf("proxy")).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("warns about an IPv6 proxy that is not listening", async (context) => {
    const proxy = await ipv6ProxyThatIsUp();
    if (!proxy) return context.skip();
    const port = proxy.port;
    await proxy.close(); // the port is now closed
    setSetting("socks5ProxyUrl", `socks5://[::1]:${port}`);

    const issues = await issuesOf("proxy");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`socks5://[::1]:${port} does not accept connections`);
  });
});

describe.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")("getHealthReport — a restore that was rolled back at start-up", () => {
  const noticeFile = () => path.join(path.dirname(config.dbPath), "restore-rolled-back.json");
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  afterEach(() => {
    fs.rmSync(noticeFile(), { force: true });
  });

  it("reports the notice the start-up guard left as an error naming the file that failed", async () => {
    const failedDatabase = `${config.dbPath}.failed-restore`;
    fs.writeFileSync(noticeFile(), JSON.stringify({ at: daysAgo(1), failedDatabase, startsTried: 2 }));

    const issues = await issuesOf("restore-rolled-back");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "restore-rolled-back", severity: "error", transient: false });
    expect(issues[0].message).toBe(
      `The database you restored did not start (2 tries), so the previous database was put back. The restored file is kept as ${failedDatabase}; the backup it came from may be damaged or from an incompatible version.`
    );
  });

  it("says nothing when there is no notice", async () => {
    expect(await issuesOf("restore-rolled-back")).toEqual([]);
  });

  it("stops reporting the notice once it is a week old", async () => {
    fs.writeFileSync(noticeFile(), JSON.stringify({ at: daysAgo(6), failedDatabase: "a.failed-restore", startsTried: 2 }));
    expect(await issuesOf("restore-rolled-back")).toHaveLength(1);

    fs.writeFileSync(noticeFile(), JSON.stringify({ at: daysAgo(8), failedDatabase: "a.failed-restore", startsTried: 2 }));
    expect(await issuesOf("restore-rolled-back")).toEqual([]);
  });

  it("says nothing, and does not fail the report, when the notice file is unreadable", async () => {
    fs.writeFileSync(noticeFile(), "{ not json");

    const report = await getHealthReport({ refresh: true });

    expect(report.issues.filter((i) => i.source === "restore-rolled-back")).toEqual([]);
    expect(Array.isArray(report.issues)).toBe(true);
  });
});

describe("getHealthReport — errors nothing handled (uncaught-errors)", () => {
  let uncaught: typeof import("../src/services/uncaughtErrors.js");

  beforeAll(async () => {
    uncaught = await import("../src/services/uncaughtErrors.js");
  });

  beforeEach(() => {
    uncaught.__resetUncaughtErrorsForTests();
  });

  afterEach(() => {
    uncaught.__resetUncaughtErrorsForTests();
  });

  const record = (count: number, ageMs = 0) => {
    for (let i = 1; i <= count; i++) uncaught.recordUncaughtError("exception", new Error(`boom ${i}`), Date.now() - ageMs);
  };

  it("says nothing when no uncaught error was recorded", async () => {
    expect(await issuesOf("uncaught-errors")).toEqual([]);
  });

  it("says nothing up to the warning limit, since a few are a one-off", async () => {
    record(uncaught.UNCAUGHT_WARN_PER_HOUR);

    expect(await issuesOf("uncaught-errors")).toEqual([]);
  });

  it("warns as soon as there are more than the limit in an hour, with the count and the last message", async () => {
    record(uncaught.UNCAUGHT_WARN_PER_HOUR + 1);

    const issues = await issuesOf("uncaught-errors");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "uncaught-errors", severity: "warning", transient: true });
    expect(issues[0].message).toContain(`${uncaught.UNCAUGHT_WARN_PER_HOUR + 1} unexpected errors in the last hour`);
    expect(issues[0].message).toContain(`(the last: boom ${uncaught.UNCAUGHT_WARN_PER_HOUR + 1})`);
  });

  it("does not count errors that are more than an hour old", async () => {
    record(uncaught.UNCAUGHT_WARN_PER_HOUR + 5, 2 * 60 * 60 * 1000);

    expect(await issuesOf("uncaught-errors")).toEqual([]);
  });

  it("counts only the recent ones when old and new errors are mixed", async () => {
    record(10, 2 * 60 * 60 * 1000);
    record(uncaught.UNCAUGHT_WARN_PER_HOUR);

    expect(await issuesOf("uncaught-errors")).toEqual([]);
    record(1);
    expect(await issuesOf("uncaught-errors")).toHaveLength(1);
  });
});

describe("getHealthReport — downloads left paused at the client (paused-downloads)", () => {
  let mediaItemId: number;
  /** The enabled download client the queue rows belong to (the check only counts rows of an enabled client). */
  let enabledClientId: number;

  async function insertClient(enabled: number, name = "Seedbox"): Promise<number> {
    return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES (?, 'qbittorrent', ?)").run(name, enabled)).lastInsertRowid);
  }

  beforeEach(async () => {
    await db.prepare("DELETE FROM media_items").run();
    mediaItemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'Paused Movie', 'paused movie', 1, 0, 'missing')").run()).lastInsertRowid);
    enabledClientId = await insertClient(1);
  });

  /** A timestamp in the form the queue stores: UTC, "YYYY-MM-DD HH:MM:SS". */
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

  async function insertQueueRow(
    over: { title?: string; status?: string; clientState?: string | null; addedHoursAgo?: number; progressHoursAgo?: number | null; clientId?: number | null } = {}
  ): Promise<number> {
    const row = { title: "Some.Release.2020.1080p", status: "downloading", clientState: "paused", addedHoursAgo: 100, progressHoursAgo: null as number | null, clientId: enabledClientId as number | null, ...over };
    const result = await db
      .prepare("INSERT INTO queue (media_item_id, title, download_client_id, status, client_state, added_at, last_progress_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(mediaItemId, row.title, row.clientId, row.status, row.clientState, hoursAgo(row.addedHoursAgo), row.progressHoursAgo == null ? null : hoursAgo(row.progressHoursAgo));
    return Number(result.lastInsertRowid);
  }

  it("warns about one download paused for more than three days, naming it, as something that does not clear by itself", async () => {
    await insertQueueRow({ title: "Old.Paused.Release.2019", addedHoursAgo: 80 });

    const issues = await issuesOf("paused-downloads");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "paused-downloads", severity: "warning", transient: false });
    expect(issues[0].message).toBe(
      '1 download has sat paused or waiting at the download client for more than 3 days without moving ("Old.Paused.Release.2019"). It holds the title from every search; resume it in the client or remove it from Activity.'
    );
  });

  it("says nothing about a paused row of a client that is switched off, or one that was deleted", async () => {
    const off = await insertClient(0, "Switched off");
    await insertQueueRow({ title: "Of.A.Disabled.Client", clientId: off });
    // Deleting the client leaves its rows with no client (ON DELETE SET NULL).
    const gone = await insertClient(1, "To be deleted");
    const orphan = await insertQueueRow({ title: "Of.A.Deleted.Client", clientId: gone });
    await db.prepare("DELETE FROM download_clients WHERE id = ?").run(gone);
    expect(((await db.prepare("SELECT download_client_id AS id FROM queue WHERE id = ?").get(orphan)) as { id: number | null }).id).toBeNull();
    await insertQueueRow({ title: "Never.Had.A.Client", clientId: null });

    expect(await issuesOf("paused-downloads")).toEqual([]);
  });

  it("counts and names only the rows of enabled clients when the others have paused rows too", async () => {
    const off = await insertClient(0, "Switched off");
    await insertQueueRow({ title: "Of.A.Disabled.Client", addedHoursAgo: 200, clientId: off });
    await insertQueueRow({ title: "Of.The.Enabled.Client", addedHoursAgo: 100 });

    const [issue] = await issuesOf("paused-downloads");

    expect(issue.message).toContain('1 download has sat paused');
    expect(issue.message).toContain('("Of.The.Enabled.Client")');
    expect(issue.message).not.toContain("Of.A.Disabled.Client");
  });

  it("counts more than fifty rows correctly and still names only the three oldest", async () => {
    for (let i = 0; i < 60; i++) await insertQueueRow({ title: `Bulk.${String(i).padStart(2, "0")}`, addedHoursAgo: 400 - i });

    const issues = await issuesOf("paused-downloads");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("60 downloads have sat paused or waiting at the download client");
    expect(issues[0].message).toContain('("Bulk.00", "Bulk.01", "Bulk.02", …)');
    expect(issues[0].message).not.toContain("Bulk.03");
    expect(issues[0].message).toContain("They hold the title from every search; resume them in the client or remove them from Activity.");
  });

  it("counts a queued row that is paused too, not only a downloading one", async () => {
    await insertQueueRow({ status: "queued", addedHoursAgo: 90 });

    expect(await issuesOf("paused-downloads")).toHaveLength(1);
  });

  it("says nothing about a download paused for less than three days", async () => {
    await insertQueueRow({ addedHoursAgo: 70 });

    expect(await issuesOf("paused-downloads")).toEqual([]);
  });

  it("goes by the last progress when there is one: grabbed long ago but moving a day ago is not forgotten", async () => {
    await insertQueueRow({ addedHoursAgo: 200, progressHoursAgo: 20 });

    expect(await issuesOf("paused-downloads")).toEqual([]);
  });

  it("goes by the last progress when it is the old one, even if the grab is older still", async () => {
    await insertQueueRow({ addedHoursAgo: 300, progressHoursAgo: 100 });

    expect(await issuesOf("paused-downloads")).toHaveLength(1);
  });

  it("says nothing about an old download that is not paused", async () => {
    await insertQueueRow({ title: "Running", clientState: "downloading" });
    await insertQueueRow({ title: "Never reported", clientState: null });

    expect(await issuesOf("paused-downloads")).toEqual([]);
  });

  it.each(["failed", "completed", "imported"])("says nothing about a paused row whose status is %s", async (status) => {
    await insertQueueRow({ status });

    expect(await issuesOf("paused-downloads")).toEqual([]);
  });

  it("names two downloads and uses the plural wording", async () => {
    await insertQueueRow({ title: "First.Release", addedHoursAgo: 120 });
    await insertQueueRow({ title: "Second.Release", addedHoursAgo: 110 });

    const issues = await issuesOf("paused-downloads");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      '2 downloads have sat paused or waiting at the download client for more than 3 days without moving ("First.Release", "Second.Release"). They hold the title from every search; resume them in the client or remove them from Activity.'
    );
  });

  it("names the three that were grabbed first and counts the rest, however many there are", async () => {
    for (const [title, age] of [
      ["Release.E", 100],
      ["Release.A", 140],
      ["Release.D", 110],
      ["Release.B", 130],
      ["Release.C", 120],
    ] as const) {
      await insertQueueRow({ title, addedHoursAgo: age });
    }

    const issues = await issuesOf("paused-downloads");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('5 downloads have sat paused');
    expect(issues[0].message).toContain('("Release.A", "Release.B", "Release.C", …)');
    expect(issues[0].message).not.toContain("Release.D");
    expect(issues[0].message).not.toContain("Release.E");
  });

  it("does not add an ellipsis for exactly three", async () => {
    for (const title of ["One", "Two", "Three"]) await insertQueueRow({ title });

    const [issue] = await issuesOf("paused-downloads");

    expect(issue.message).toContain("3 downloads have sat paused");
    expect(issue.message).not.toContain("…");
  });

  it("is part of the report a page load gets", async () => {
    await insertQueueRow({ title: "Forgotten.Release", addedHoursAgo: 96 });
    clearHealthReportCache();

    const report = await getHealthReport({ refresh: true });

    expect(report.issues.map((i) => i.source)).toContain("paused-downloads");
  });
});
