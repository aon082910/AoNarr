import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

// Once a debrid job has saved its files, the finished download is removed from the provider's account (DL21): TorBox
// and AllDebrid as Real-Debrid already did. It is best effort: a provider error is logged and never fails the job.
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let dc: typeof import("../src/services/downloadClient.js");
let config: (typeof import("../src/config.js"))["config"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let log: (typeof import("../src/services/logger.js"))["log"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  dc = await import("../src/services/downloadClient.js");
  ({ config } = await import("../src/config.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ log } = await import("../src/services/logger.js"));
});

const saved: string[] = [];

beforeEach(() => {
  setSetting("debridCleanup", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSetting("debridCleanup", "");
  for (const file of saved.splice(0)) fs.rmSync(file, { force: true });
});

let nextClientId = 940_000;
function client(type: "torbox" | "alldebrid"): DownloadClient {
  return {
    id: nextClientId++,
    name: `${type} account`,
    type,
    host: null,
    port: null,
    useSsl: 0,
    username: null,
    password: null,
    apiKey: "secret-key",
    category: null,
    enabled: 1,
    audioOnly: 0,
    downloadTypes: null,
    tagIds: [],
    priority: 1,
    urlBase: null,
    categoryByType: null,
  } as unknown as DownloadClient;
}

function routedFetch(routes: { test: (url: string, init?: any) => boolean; response: any }[]) {
  return vi.fn(async (url: string, init?: any) => {
    const route = routes.find((r) => r.test(String(url), init));
    if (!route) throw new Error(`unmocked fetch call: ${url}`);
    return typeof route.response === "function" ? route.response(String(url), init) : route.response;
  });
}
function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
}
function notOk(status: number) {
  return { ok: false, status, json: async () => ({}), text: async () => "" };
}
function fileResponse(content: string) {
  return { ok: true, status: 200, headers: new Headers({ "content-length": String(content.length) }), body: new Response(content).body };
}

/** The file a job leaves in the downloads root, which the test removes afterwards. */
function expectSaved(name: string) {
  const file = path.join(config.downloadsDir, name);
  saved.push(file);
  expect(fs.existsSync(file)).toBe(true);
}

const warnedAboutCleanup = (provider: string) =>
  vi
    .mocked(log.warn)
    .mock.calls.filter((call) => String(call[0]).startsWith(`[${provider}] could not remove the finished download from the account`))
    .map((call) => String(call[1]));

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TorBox removes the finished download from the account", () => {
  const adapter = () => dc.getDownloadClientAdapter("torbox");

  /** A TorBox account with one torrent that is already cached; `onDelete` answers the delete call. */
  function torbox(name: string, onDelete: (url: string, init: any) => any = () => ok({ success: true }), kind: "torrents" | "usenet" = "torrents") {
    const control = kind === "usenet" ? "controlusenetdownload" : "controltorrent";
    const create = kind === "usenet" ? { test: (u: string) => u.includes("/usenet/createusenetdownload"), response: ok({ data: { usenetdownload_id: "u-clean" } }) } : { test: (u: string) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb-clean" } }) };
    return routedFetch([
      create,
      { test: (u) => u.includes(`/${kind}/mylist`), response: ok({ data: { download_finished: true, files: [{ id: 1, name }] } }) },
      { test: (u) => u.includes(`/${kind}/requestdl`), response: ok({ data: "https://tb/direct-clean" }) },
      { test: (u) => u === "https://tb/direct-clean", response: () => fileResponse("bytes") },
      { test: (u) => u.includes(`/${kind}/${control}`), response: onDelete },
    ]);
  }
  const deletesOf = (fetchMock: ReturnType<typeof torbox>) => fetchMock.mock.calls.filter((c) => /\/(controltorrent|controlusenetdownload)$/.test(String(c[0])));
  async function finish(c: DownloadClient, downloadId: string) {
    await vi.waitFor(async () => expect((await adapter().getStatus(c, [downloadId]))[0].status).toBe("completed"));
  }

  it("deletes the torrent with the account's control call once its files are saved", async () => {
    const fetchMock = torbox("TorBox Clean One.mkv");
    vi.stubGlobal("fetch", fetchMock);
    const c = client("torbox");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:tbclean", null, "TorBox Clean One");
    await finish(c, downloadId);
    await vi.waitFor(() => expect(deletesOf(fetchMock)).toHaveLength(1));

    expectSaved("TorBox Clean One.mkv");
    const [url, init] = deletesOf(fetchMock)[0];
    expect(String(url)).toBe("https://api.torbox.app/v1/api/torrents/controltorrent");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-key", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ torrent_id: "tb-clean", operation: "delete" });
  });

  it("deletes a usenet download through the usenet control call", async () => {
    const fetchMock = torbox("TorBox Clean Usenet.mkv", () => ok({ success: true }), "usenet");
    vi.stubGlobal("fetch", fetchMock);
    const c = client("torbox");

    const { downloadId } = await adapter().addDownload(c, "https://indexer/download.nzb", null, "TorBox Clean Usenet", "usenet");
    await finish(c, downloadId);
    await vi.waitFor(() => expect(deletesOf(fetchMock)).toHaveLength(1));

    expectSaved("TorBox Clean Usenet.mkv");
    const [url, init] = deletesOf(fetchMock)[0];
    expect(String(url)).toBe("https://api.torbox.app/v1/api/usenet/controlusenetdownload");
    expect(JSON.parse(init.body)).toEqual({ usenet_id: "u-clean", operation: "delete" });
    expect(fetchMock.mock.calls.some((c2) => String(c2[0]).includes("/torrents/"))).toBe(false);
  });

  it("leaves the account alone when the debrid clean-up is switched off", async () => {
    setSetting("debridCleanup", "0");
    const fetchMock = torbox("TorBox Clean Off.mkv");
    vi.stubGlobal("fetch", fetchMock);
    const c = client("torbox");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:tboff", null, "TorBox Clean Off");
    await finish(c, downloadId);
    await tick();

    expectSaved("TorBox Clean Off.mkv");
    expect(deletesOf(fetchMock)).toHaveLength(0);
  });

  it("does not delete anything when the job failed before its files were saved", async () => {
    const fetchMock = routedFetch([
      { test: (u) => u.includes("/torrents/createtorrent"), response: ok({ data: { torrent_id: "tb-bad" } }) },
      { test: (u) => u.includes("/torrents/mylist"), response: ok({ data: { download_state: "error", download_finished: false } }) },
      { test: (u) => u.endsWith("/controltorrent"), response: ok({ success: true }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const c = client("torbox");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:tbbad", null, "TorBox Bad");
    await vi.waitFor(async () => expect((await adapter().getStatus(c, [downloadId]))[0].status).toBe("failed"));
    await tick();

    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/controltorrent"))).toBe(false);
  });

  it("treats a delete the account answers 404 to as done, without a warning", async () => {
    vi.spyOn(log, "warn");
    const fetchMock = torbox("TorBox Clean 404.mkv", () => notOk(404));
    vi.stubGlobal("fetch", fetchMock);
    const c = client("torbox");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:tb404", null, "TorBox Clean 404");
    await finish(c, downloadId);
    await vi.waitFor(() => expect(deletesOf(fetchMock)).toHaveLength(1));
    await tick();

    expectSaved("TorBox Clean 404.mkv");
    expect(warnedAboutCleanup("torbox")).toEqual([]);
  });

  it.each([
    ["HTTP 500", () => notOk(500), /HTTP 500/],
    ["a network error", () => Promise.reject(new Error("socket hang up")), /socket hang up/],
  ])("logs a warning and still completes the job when the delete fails with %s", async (_label, onDelete, message) => {
    vi.spyOn(log, "warn");
    const fetchMock = torbox(`TorBox Clean Fails ${_label.replace(/\W+/g, "")}.mkv`, onDelete as any);
    vi.stubGlobal("fetch", fetchMock);
    const c = client("torbox");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:tbfail", null, `TorBox Clean Fails ${_label.replace(/\W+/g, "")}`);
    await finish(c, downloadId);
    await vi.waitFor(() => expect(warnedAboutCleanup("torbox")).toHaveLength(1));

    expectSaved(`TorBox Clean Fails ${_label.replace(/\W+/g, "")}.mkv`);
    expect(warnedAboutCleanup("torbox")[0]).toMatch(message);
    // The job is still the completed one the importer reads.
    const [status] = await adapter().getStatus(c, [downloadId]);
    expect(status).toMatchObject({ status: "completed", progress: 1 });
  });
});

describe("AllDebrid removes the finished magnet from the account", () => {
  const adapter = () => dc.getDownloadClientAdapter("alldebrid");

  function alldebrid(name: string, onDelete: (url: string, init: any) => any = () => ok({ status: "success", data: { message: "Magnet was successfully deleted" } }), statusCode = 4) {
    return routedFetch([
      { test: (u) => u.includes("/magnet/upload"), response: ok({ status: "success", data: { magnets: [{ id: "ad-clean" }] } }) },
      { test: (u) => u.includes("magnet/status"), response: ok({ status: "success", data: { magnets: [{ statusCode, status: statusCode >= 5 ? "Error" : "Ready" }] } }) },
      { test: (u) => u.includes("/magnet/files"), response: ok({ status: "success", data: { magnets: [{ files: [{ n: name, l: "https://ad/dl/clean" }] }] } }) },
      { test: (u) => u.includes("/link/unlock"), response: ok({ status: "success", data: { link: "https://ad/direct-clean", filename: name } }) },
      { test: (u) => u === "https://ad/direct-clean", response: () => fileResponse("bytes") },
      { test: (u) => u.includes("/magnet/delete"), response: onDelete },
    ]);
  }
  const deletesOf = (fetchMock: ReturnType<typeof alldebrid>) => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/magnet/delete"));
  async function finish(c: DownloadClient, downloadId: string) {
    await vi.waitFor(async () => expect((await adapter().getStatus(c, [downloadId]))[0].status).toBe("completed"));
  }

  it("deletes the magnet by its id once its files are saved", async () => {
    const fetchMock = alldebrid("AllDebrid Clean One.mkv");
    vi.stubGlobal("fetch", fetchMock);
    const c = client("alldebrid");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:adclean", null, "AllDebrid Clean One");
    await finish(c, downloadId);
    await vi.waitFor(() => expect(deletesOf(fetchMock)).toHaveLength(1));

    expectSaved("AllDebrid Clean One.mkv");
    const url = new URL(String(deletesOf(fetchMock)[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.alldebrid.com/v4/magnet/delete");
    expect(url.searchParams.get("id")).toBe("ad-clean");
    expect(url.searchParams.get("apikey")).toBe("secret-key");
    expect(url.searchParams.get("agent")).toBe("aonarr");
  });

  it("leaves the account alone when the debrid clean-up is switched off", async () => {
    setSetting("debridCleanup", "0");
    const fetchMock = alldebrid("AllDebrid Clean Off.mkv");
    vi.stubGlobal("fetch", fetchMock);
    const c = client("alldebrid");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:adoff", null, "AllDebrid Clean Off");
    await finish(c, downloadId);
    await tick();

    expectSaved("AllDebrid Clean Off.mkv");
    expect(deletesOf(fetchMock)).toHaveLength(0);
  });

  it("does not delete anything when AllDebrid reported an error for the magnet", async () => {
    const fetchMock = alldebrid("AllDebrid Bad.mkv", undefined, 5);
    vi.stubGlobal("fetch", fetchMock);
    const c = client("alldebrid");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:adbad", null, "AllDebrid Bad");
    await vi.waitFor(async () => expect((await adapter().getStatus(c, [downloadId]))[0].status).toBe("failed"));
    await tick();

    expect(deletesOf(fetchMock)).toHaveLength(0);
  });

  it.each([
    ["HTTP 500", () => notOk(500), /HTTP 500/],
    ["an AllDebrid error", () => ok({ status: "error", error: { code: "MAGNET_INVALID_ID", message: "Magnet not found" } }), /AllDebrid: Magnet not found/],
    ["a network error", () => Promise.reject(new Error("socket hang up")), /socket hang up/],
  ])("logs a warning and still completes the job when the delete fails with %s", async (_label, onDelete, message) => {
    vi.spyOn(log, "warn");
    const name = `AllDebrid Clean Fails ${_label.replace(/\W+/g, "")}`;
    const fetchMock = alldebrid(`${name}.mkv`, onDelete as any);
    vi.stubGlobal("fetch", fetchMock);
    const c = client("alldebrid");

    const { downloadId } = await adapter().addDownload(c, "magnet:?xt=urn:btih:adfail", null, name);
    await finish(c, downloadId);
    await vi.waitFor(() => expect(warnedAboutCleanup("alldebrid")).toHaveLength(1));

    expectSaved(`${name}.mkv`);
    expect(warnedAboutCleanup("alldebrid")[0]).toMatch(message);
    expect((await adapter().getStatus(c, [downloadId]))[0]).toMatchObject({ status: "completed", progress: 1 });
  });
});

describe("removeQueueItemDownload / markDownloadImported for the debrid clients", () => {
  // The provider's copy is removed by the job itself, as soon as the files are saved: there is nothing left to ask the
  // account for when the import finishes or the admin removes the row, and no client-side mark to put on anything.
  it.each(["torbox", "alldebrid", "realdebrid"] as const)("%s: neither call reaches the provider, and neither throws", async (type) => {
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, api_key, enabled) VALUES (?, ?, 'secret-key', 1)").run(`${type} account`, type)).lastInsertRowid);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const row = { downloadClientId: clientId, downloadId: "job-uuid", title: "Some.Release.2020" };

    await expect(dc.removeQueueItemDownload(row, true)).resolves.toBeUndefined();
    await expect(dc.markDownloadImported(row)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(typeof dc.getDownloadClientAdapter(type).removeDownload).toBe("undefined");
    expect(typeof dc.getDownloadClientAdapter(type).markImported).toBe("undefined");
  });
});
