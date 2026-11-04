import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

let dc: typeof import("../src/services/downloadClient.js");
let config: (typeof import("../src/config.js"))["config"];

beforeAll(async () => {
  await setupTestDb();
  dc = await import("../src/services/downloadClient.js");
  ({ config } = await import("../src/config.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let nextClientId = 700_000;
function client(over: Partial<DownloadClient> = {}): DownloadClient {
  return {
    id: nextClientId++,
    name: "Test Client",
    type: "qbittorrent",
    host: "dl.local",
    port: 8080,
    useSsl: 0,
    username: "user",
    password: "pass",
    apiKey: null,
    category: "aonarr",
    enabled: 1,
    audioOnly: 0,
    downloadTypes: null,
    tagIds: [],
    priority: 1,
    urlBase: null,
    categoryByType: null,
    ...over,
  } as DownloadClient;
}

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => {
  const headers = new Headers(init.headers ?? {});
  const status = init.status ?? 200;
  return { ok: status >= 200 && status < 300, status, headers, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer };
};

const NZB = '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="a" date="1" subject="x"><groups><group>g</group></groups><segments><segment bytes="1" number="1">id</segment></segments></file></nzb>';
const nzbResponse = () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from(NZB), json: async () => ({}), text: async () => NZB });

/** A fetch that answers by the RPC `method` in a JSON body, or by URL for everything else; records each call. */
function rpcFetch(answers: Record<string, unknown | ((args: any, init: RequestInit) => unknown)>, other: (url: string) => any = () => nzbResponse()) {
  const calls: { url: string; method: string | null; args: any; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    let method: string | null = null;
    let args: any = null;
    try {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      method = body?.method ?? null;
      args = body?.params ?? body?.arguments ?? null;
    } catch {
      // not an RPC body
    }
    calls.push({ url: String(url), method, args, init });
    if (method && method in answers) {
      const answer = answers[method];
      const value = typeof answer === "function" ? (answer as (a: any, i: RequestInit) => unknown)(args, init) : answer;
      // NZBGet's JSON-RPC wraps the answer in { result }.
      return json({ result: value });
    }
    return other(String(url));
  });
  return { fn, calls };
}

describe("a URL base for the HTTP clients (DL22)", () => {
  it("normalizes what the admin typed", () => {
    expect(dc.normalizeUrlBase("qbittorrent")).toBe("/qbittorrent");
    expect(dc.normalizeUrlBase("/qbittorrent/")).toBe("/qbittorrent");
    expect(dc.normalizeUrlBase("/a//b/")).toBe("/a/b");
    expect(dc.normalizeUrlBase("")).toBe("");
    expect(dc.normalizeUrlBase(null)).toBe("");
    expect(dc.normalizeUrlBase("/")).toBe("");
  });

  it("is put in front of every qBittorrent call", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "set-cookie": "SID=abc; Path=/" }),
          text: async () => "Ok.",
          json: async () => [],
        };
      })
    );
    await dc.getDownloadClientAdapter("qbittorrent").getStatus(client({ urlBase: "qbittorrent/" }), []);
    expect(urls[0]).toBe("http://dl.local:8080/qbittorrent/api/v2/auth/login");
    expect(urls[1]).toBe("http://dl.local:8080/qbittorrent/api/v2/torrents/info");
  });
});

describe("categories per library type (DL10)", () => {
  it("uses the type's own category and falls back to the default", () => {
    const c = client({ category: "aonarr", categoryByType: { movie: "movies", artist: "music" } });
    expect(dc.categoryForType(c, "movie")).toBe("movies");
    expect(dc.categoryForType(c, "artist")).toBe("music");
    expect(dc.categoryForType(c, "series")).toBe("aonarr");
    expect(dc.categoryForType(client({ category: null }), "movie")).toBeNull();
  });

  it("lists every category a client may hold downloads of AoNarr's under", () => {
    expect(dc.clientCategories(client({ category: "aonarr", categoryByType: { movie: "movies", series: "aonarr" } })).sort()).toEqual(["aonarr", "movies"]);
  });
});

describe("the seed goal goes to qBittorrent with the torrent (DL5)", () => {
  it("sends the ratio and the seeding time as limits", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any = {}) => {
        calls.push({ url: String(url), body: init.body instanceof URLSearchParams ? init.body : undefined });
        return { ok: true, status: 200, headers: new Headers({ "set-cookie": "SID=abc; Path=/" }), text: async () => "Ok.", json: async () => [] };
      })
    );
    const hash = "a".repeat(40);
    await dc.getDownloadClientAdapter("qbittorrent").addDownload(client(), `magnet:?xt=urn:btih:${hash}`, "movies", "Release", "torrent", { seedGoal: { ratio: 1.5, minutes: 4320 } });
    const add = calls.find((c) => c.url.endsWith("/torrents/add"))!;
    expect(add.body!.get("ratioLimit")).toBe("1.5");
    expect(add.body!.get("seedingTimeLimit")).toBe("4320");
    expect(add.body!.get("category")).toBe("movies");
  });

  it("sends no limit when there is no goal", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any = {}) => {
        calls.push({ url: String(url), body: init.body instanceof URLSearchParams ? init.body : undefined });
        return { ok: true, status: 200, headers: new Headers({ "set-cookie": "SID=abc; Path=/" }), text: async () => "Ok.", json: async () => [] };
      })
    );
    await dc.getDownloadClientAdapter("qbittorrent").addDownload(client(), `magnet:?xt=urn:btih:${"b".repeat(40)}`, null);
    const add = calls.find((c) => c.url.endsWith("/torrents/add"))!;
    expect(add.body!.has("ratioLimit")).toBe(false);
    expect(add.body!.has("seedingTimeLimit")).toBe(false);
  });
});

describe("adding a torrent starts it, even when the client is set to add torrents stopped (Round 30b)", () => {
  it("qBittorrent: the add form says paused=false and stopped=false, beside the category and the seed goal", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any = {}) => {
        calls.push({ url: String(url), body: init.body instanceof URLSearchParams ? init.body : undefined });
        return { ok: true, status: 200, headers: new Headers({ "set-cookie": "SID=abc; Path=/" }), text: async () => "Ok.", json: async () => [] };
      })
    );
    const hash = "e".repeat(40);

    const result = await dc.getDownloadClientAdapter("qbittorrent").addDownload(client(), `magnet:?xt=urn:btih:${hash}`, "movies", "Release", "torrent", { seedGoal: { ratio: 2, minutes: null } });

    expect(result.downloadId).toBe(hash);
    const add = calls.find((c) => c.url.endsWith("/torrents/add"))!;
    // paused is qBittorrent 4's field and stopped is 5's: each build reads the one it knows and ignores the other.
    expect(add.body!.get("paused")).toBe("false");
    expect(add.body!.get("stopped")).toBe("false");
    expect(add.body!.get("category")).toBe("movies");
    expect(add.body!.get("ratioLimit")).toBe("2");
    expect(add.body!.get("urls")).toBe(`magnet:?xt=urn:btih:${hash}`);
  });

  it("qBittorrent: also when there is no category and no seed goal", async () => {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any = {}) => {
        calls.push({ url: String(url), body: init.body instanceof URLSearchParams ? init.body : undefined });
        return { ok: true, status: 200, headers: new Headers({ "set-cookie": "SID=abc; Path=/" }), text: async () => "Ok.", json: async () => [] };
      })
    );

    await dc.getDownloadClientAdapter("qbittorrent").addDownload(client(), `magnet:?xt=urn:btih:${"f".repeat(40)}`, null);

    const add = calls.find((c) => c.url.endsWith("/torrents/add"))!;
    expect(add.body!.get("paused")).toBe("false");
    expect(add.body!.get("stopped")).toBe("false");
    expect(add.body!.has("category")).toBe(false);
  });
});

describe("NZBGet (DL14)", () => {
  const nz = () => client({ type: "nzbget", host: "nz.local", port: 6789, username: "nzbget", password: "tegbzn6789", category: "tv" });

  it("sends the NZB as base64 with the category and answers its id", async () => {
    const { fn, calls } = rpcFetch({ append: 42 });
    vi.stubGlobal("fetch", fn);
    const result = await dc.getDownloadClientAdapter("nzbget").addDownload(nz(), "https://idx.example.com/getnzb?id=1", "tv", "Show.S01E01.1080p");
    expect(result.downloadId).toBe("42");
    const append = calls.find((c) => c.method === "append")!;
    expect(append.url).toBe("http://nz.local:6789/jsonrpc");
    expect(append.args[0]).toBe("Show.S01E01.1080p.nzb");
    expect(Buffer.from(append.args[1], "base64").toString()).toBe(NZB);
    expect(append.args[2]).toBe("tv");
    // Duplicate handling is off (FORCE; "ALL" made NZBGet drop a repeat as DELETED/COPY), so a release found again downloads again.
    expect(append.args[8]).toBe("FORCE");
    expect((append.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("nzbget:tegbzn6789").toString("base64")}`);
  });

  it("refuses an answer with no id and a magnet link", async () => {
    vi.stubGlobal("fetch", rpcFetch({ append: 0 }).fn);
    await expect(dc.getDownloadClientAdapter("nzbget").addDownload(nz(), "https://idx.example.com/x", "tv", "R")).rejects.toThrow(/did not add/);
    await expect(dc.getDownloadClientAdapter("nzbget").addDownload(nz(), "magnet:?xt=urn:btih:abc", "tv", "R")).rejects.toThrow(/magnet/);
  });

  it("reads the queue and the history", async () => {
    const { fn } = rpcFetch({
      listgroups: [
        { NZBID: 1, Status: "DOWNLOADING", FileSizeMB: 1000, RemainingSizeMB: 250 },
        { NZBID: 2, Status: "PAUSED", FileSizeMB: 100, RemainingSizeMB: 100 },
        { NZBID: 3, Status: "UNPACKING", FileSizeMB: 100, RemainingSizeMB: 0 },
      ],
      history: [
        { NZBID: 4, Status: "SUCCESS/ALL", FinalDir: "/downloads/dst/Show", DestDir: "/downloads/inter/Show" },
        { NZBID: 5, Status: "FAILURE/PAR" },
        { NZBID: 6, Status: "WARNING/SPACE" },
        { NZBID: 7, Status: "DELETED/MANUAL" },
        { NZBID: 9, Status: "WARNING/PASSWORD" },
        { NZBID: 10, Status: "WARNING/SCRIPT", FinalDir: "/downloads/dst/Other" },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const updates = await dc.getDownloadClientAdapter("nzbget").getStatus(nz(), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    const by = (id: string) => updates.find((u) => u.downloadId === id)!;
    expect(by("1")).toMatchObject({ status: "downloading", progress: 0.75, sizeLeft: 250 * 1024 * 1024 });
    expect(by("2")).toMatchObject({ status: "downloading", paused: true });
    expect(by("3")).toMatchObject({ status: "downloading", progress: 0.99 });
    expect(by("4")).toMatchObject({ status: "completed", progress: 1, remotePath: "/downloads/dst/Show" });
    expect(by("5")).toMatchObject({ status: "failed", failureReason: "NZBGet: par repair failed (FAILURE/PAR)" });
    expect(by("6")).toMatchObject({ status: "downloading", warning: "NZBGet: not enough disk space" });
    expect(by("7")).toMatchObject({ status: "failed" });
    expect(by("9")).toMatchObject({ status: "failed", failureReason: "NZBGet: WARNING/PASSWORD" });
    expect(by("10")).toMatchObject({ status: "completed", remotePath: "/downloads/dst/Other" });
    expect(updates.some((u) => u.downloadId === "8")).toBe(false);
  });

  it("removes a group from the queue and from the history, with its files when asked", async () => {
    const { fn, calls } = rpcFetch({ editqueue: true });
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("nzbget").removeDownload!(nz(), "9", true);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["GroupFinalDelete", ""],
      ["HistoryFinalDelete", ""],
    ]);
    calls.length = 0;
    await dc.getDownloadClientAdapter("nzbget").removeDownload!(nz(), "9", false);
    expect(calls.map((c) => c.args[0])).toEqual(["GroupDelete", "HistoryDelete"]);
  });

  it("the connection test names a wrong login and an answer that is not NZBGet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, { status: 401 })));
    await expect(dc.testDownloadClientConnection(nz())).rejects.toThrow(/rejected the login/);
    vi.stubGlobal("fetch", rpcFetch({ version: "21.1", status: { ServerPaused: false } }).fn);
    await expect(dc.testDownloadClientConnection(nz())).resolves.toBeUndefined();
  });
});

describe("Transmission (DL14)", () => {
  const tr = (over: Partial<DownloadClient> = {}) => client({ type: "transmission", host: "tr.local", port: 9091, username: "u", password: "p", category: "aonarr", ...over });
  const HASH = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";

  /** Transmission answers 409 with a session id until the id is sent back. */
  function transmissionFetch(answers: Record<string, unknown | ((args: any) => unknown)>) {
    const calls: { url: string; method: string; args: any; session: string | null }[] = [];
    const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      const session = headers["X-Transmission-Session-Id"] ?? null;
      if (!session) return json({}, { status: 409, headers: { "x-transmission-session-id": "SESSION-1" } });
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), method: body.method, args: body.arguments, session });
      const answer = answers[body.method];
      const value = typeof answer === "function" ? (answer as (a: any) => unknown)(body.arguments) : answer;
      return json({ result: "success", arguments: value ?? {} });
    });
    return { fn, calls };
  }

  it("repeats a request with the session id it was given, at the default /transmission/rpc", async () => {
    const { fn, calls } = transmissionFetch({ "torrent-add": { "torrent-added": { hashString: HASH.toUpperCase() } } });
    vi.stubGlobal("fetch", fn);
    const result = await dc.getDownloadClientAdapter("transmission").addDownload(tr(), `magnet:?xt=urn:btih:${HASH}`, "movies");
    expect(result.downloadId).toBe(HASH);
    expect(fn.mock.calls[0][0]).toBe("http://tr.local:9091/transmission/rpc");
    expect(calls[0].session).toBe("SESSION-1");
    expect(calls[0].args).toMatchObject({ filename: `magnet:?xt=urn:btih:${HASH}`, labels: ["aonarr", "movies"] });
    // Transmission 3.x ignores the labels of torrent-add: they are set again on the torrent.
    expect(calls[1]).toMatchObject({ method: "torrent-set", args: { ids: [HASH], labels: ["aonarr", "movies"] } });
  });

  it("honors a URL base", async () => {
    const { fn } = transmissionFetch({ "session-get": { version: "4.0" } });
    vi.stubGlobal("fetch", fn);
    await dc.testDownloadClientConnection(tr({ urlBase: "tr" }));
    expect(fn.mock.calls[0][0]).toBe("http://tr.local:9091/tr/rpc");
  });

  it("sends a .torrent file as metainfo and tracks a duplicate add", async () => {
    const { fn, calls } = transmissionFetch({ "torrent-add": { "torrent-duplicate": { hashString: HASH } } });
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (String(url).includes("tr.local") ? fn(url, init) : Promise.resolve({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from("d4:infod4:name1:xee") })));
    const result = await dc.getDownloadClientAdapter("transmission").addDownload(tr(), "https://idx.example.com/dl.torrent", null);
    expect(result.downloadId).toBe(HASH);
    expect(Buffer.from(calls[0].args.metainfo, "base64").toString()).toBe("d4:infod4:name1:xee");
  });

  it("maps the torrent states", async () => {
    const torrent = (hashString: string, over: Record<string, unknown>) => ({
      hashString,
      name: "Release",
      downloadDir: "/downloads/",
      status: 4,
      percentDone: 0.5,
      leftUntilDone: 500,
      eta: 60,
      error: 0,
      errorString: "",
      isStalled: false,
      ...over,
    });
    const { fn } = transmissionFetch({
      "torrent-get": {
        torrents: [
          torrent("aa", {}),
          torrent("bb", { status: 6, percentDone: 1, leftUntilDone: 0, eta: -1 }),
          torrent("cc", { status: 0, percentDone: 0.2 }),
          torrent("dd", { status: 4, error: 3, errorString: "No space left on device" }),
          torrent("ee", { status: 4, isStalled: true, eta: -1 }),
          torrent("ff", { status: 2, percentDone: 1, leftUntilDone: 0 }),
        ],
      },
    });
    vi.stubGlobal("fetch", fn);
    const updates = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), ["aa", "bb", "cc", "dd", "ee", "ff", "zz"]);
    const by = (id: string) => updates.find((u) => u.downloadId === id)!;
    expect(by("aa")).toMatchObject({ status: "downloading", progress: 0.5, etaSeconds: 60, sizeLeft: 500 });
    expect(by("bb")).toMatchObject({ status: "completed", progress: 1, remotePath: "/downloads/Release" });
    expect(by("cc")).toMatchObject({ status: "downloading", paused: true });
    expect(by("dd")).toMatchObject({ status: "downloading", warning: "Transmission: No space left on device" });
    expect(by("ee")).toMatchObject({ status: "downloading", stalled: true });
    expect(by("ff").status).toBe("downloading");
    expect(updates.some((u) => u.downloadId === "zz")).toBe(false);
  });

  it("adds a torrent started (paused: false), whether it is a magnet or a .torrent file (Round 30b)", async () => {
    const { fn, calls } = transmissionFetch({ "torrent-add": { "torrent-added": { hashString: HASH } } });
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).includes("tr.local") ? fn(url, init) : Promise.resolve({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from("d4:infod4:name1:xee") })
    );

    await dc.getDownloadClientAdapter("transmission").addDownload(tr(), `magnet:?xt=urn:btih:${HASH}`, null);
    await dc.getDownloadClientAdapter("transmission").addDownload(tr(), "https://idx.example.com/dl.torrent", "movies");

    const adds = calls.filter((c) => c.method === "torrent-add");
    expect(adds).toHaveLength(2);
    expect(adds[0].args).toMatchObject({ filename: `magnet:?xt=urn:btih:${HASH}`, paused: false });
    expect(adds[1].args).toMatchObject({ labels: ["aonarr", "movies"], paused: false });
    expect(adds[1].args.metainfo).toBe(Buffer.from("d4:infod4:name1:xee").toString("base64"));
    expect(adds.every((c) => c.args.paused === false)).toBe(true);
  });

  describe("asks only for the torrents it is polled about (Round 30b)", () => {
    const row = (hashString: string, over: Record<string, unknown> = {}) => ({
      hashString,
      name: `Release ${hashString}`,
      downloadDir: "/downloads/",
      status: 4,
      percentDone: 0.5,
      leftUntilDone: 500,
      eta: 60,
      error: 0,
      errorString: "",
      isStalled: false,
      ...over,
    });
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const OTHER = "c".repeat(40);

    it("sends torrent-get with ids set to the lower-cased hashes, once each, and answers only those", async () => {
      const library = [row(A), row(B, { status: 6, percentDone: 1, leftUntilDone: 0 }), row(OTHER)];
      // Like Transmission: only the torrents named in ids are answered.
      const { fn, calls } = transmissionFetch({ "torrent-get": (args: any) => ({ torrents: library.filter((t) => !args.ids || args.ids.includes(t.hashString)) }) });
      vi.stubGlobal("fetch", fn);

      const updates = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), [A.toUpperCase(), B, A]);

      const gets = calls.filter((c) => c.method === "torrent-get");
      expect(gets).toHaveLength(1);
      expect(gets[0].args.ids).toEqual([A, B]);
      expect(gets[0].args.fields).toContain("hashString");
      // Each is reported under the id it was asked about (the queue row's own spelling).
      expect(updates.map((u) => u.downloadId).sort()).toEqual([A.toUpperCase(), B].sort());
      expect(updates.find((u) => u.downloadId === B)).toMatchObject({ status: "completed" });
      expect(updates.some((u) => u.downloadId === OTHER)).toBe(false);
    });

    it("ignores a torrent in the answer that it did not ask about", async () => {
      // A client that answers everything whatever ids says.
      const { fn } = transmissionFetch({ "torrent-get": { torrents: [row(A), row(OTHER)] } });
      vi.stubGlobal("fetch", fn);

      const updates = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), [A]);

      expect(updates.map((u) => u.downloadId)).toEqual([A]);
    });

    it("lists no torrent at all when asked about none: it only checks that the client answers", async () => {
      const { fn, calls } = transmissionFetch({ "session-get": { version: "4.0.5" }, "torrent-get": { torrents: [row(A), row(B)] } });
      vi.stubGlobal("fetch", fn);

      const updates = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), []);

      expect(updates).toEqual([]);
      expect(calls.map((c) => c.method)).toEqual(["session-get"]);
    });

    it("still fails when asked about none and the client cannot be reached", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json({}, { status: 401 })));

      await expect(dc.getDownloadClientAdapter("transmission").getStatus(tr(), [])).rejects.toThrow();
    });

    it("lists every torrent, with no ids, when it removes the ones that met their seed goal", async () => {
      const seeded = { hashString: "seeded", status: 6, uploadRatio: 3, secondsSeeding: 0, labels: ["aonarr", "aonarr-imported"] };
      const { fn, calls } = transmissionFetch({ "torrent-get": { torrents: [seeded] }, "torrent-remove": {} });
      vi.stubGlobal("fetch", fn);

      expect(await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null)).toBe(1);

      const gets = calls.filter((c) => c.method === "torrent-get");
      expect(gets).toHaveLength(1);
      expect("ids" in gets[0].args).toBe(false);
    });
  });

  it("removes a torrent, with its data when asked", async () => {
    const { fn, calls } = transmissionFetch({ "torrent-remove": {} });
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("transmission").removeDownload!(tr(), HASH, true);
    await dc.getDownloadClientAdapter("transmission").removeDownload!(tr(), HASH, false);
    expect(calls.map((c) => c.args["delete-local-data"])).toEqual([true, false]);
  });

  it("marks an import with labels, keeping the labels it has", async () => {
    let labels = ["aonarr", "movies"];
    const { fn, calls } = transmissionFetch({
      "torrent-get": () => ({ torrents: [{ labels }] }),
      "torrent-set": (args: any) => {
        labels = args.labels;
        return {};
      },
    });
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("transmission").markImported!(tr(), HASH, { ratio: 1, minutes: 4320 });
    expect(labels).toEqual(["aonarr", "movies", "aonarr-imported", "aonarr-seed:1:4320"]);
    expect(calls.filter((c) => c.method === "torrent-set")).toHaveLength(1);
  });

  it("puts AoNarr's own label on a torrent that came without it when it marks the import", async () => {
    let labels: string[] = [];
    const { fn } = transmissionFetch({
      "torrent-get": () => ({ torrents: [{ labels }] }),
      "torrent-set": (args: any) => {
        labels = args.labels;
        return {};
      },
    });
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("transmission").markImported!(tr(), HASH, { ratio: 1, minutes: 60 });
    expect(labels).toEqual(["aonarr", "aonarr-imported", "aonarr-seed:1:60"]);
  });

  it("removes a finished torrent that Transmission stopped at its own limit, and not one that was merely paused", async () => {
    const t = (hashString: string, over: Record<string, unknown>) => ({ hashString, status: 0, percentDone: 1, uploadRatio: 2, secondsSeeding: 0, labels: ["aonarr"], ...over });
    const { fn, calls } = transmissionFetch({
      "torrent-get": { torrents: [t("limit-reached", {}), t("paused-half-way", { percentDone: 0.5 })] },
      "torrent-remove": {},
    });
    vi.stubGlobal("fetch", fn);
    expect(await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null)).toBe(1);
    expect(calls.filter((c) => c.method === "torrent-remove").map((c) => c.args.ids[0])).toEqual(["limit-reached"]);
  });

  it("removes only AoNarr's own torrents that met their goal, and the data only of a hardlink-imported one", async () => {
    const t = (hashString: string, over: Record<string, unknown>) => ({ hashString, status: 6, uploadRatio: 0.2, secondsSeeding: 0, labels: ["aonarr"], ...over });
    const { fn, calls } = transmissionFetch({
      "torrent-get": {
        torrents: [
          t("own-met", { uploadRatio: 2, labels: ["aonarr", "aonarr-imported"] }),
          t("own-met-kept", { uploadRatio: 2 }),
          t("own-not-met", { uploadRatio: 0.5 }),
          t("indexer-goal-held", { uploadRatio: 1.2, labels: ["aonarr", "aonarr-seed:2:"] }),
          t("someone-elses", { uploadRatio: 9, labels: ["movies"] }),
          t("still-downloading", { status: 4, uploadRatio: 9 }),
        ],
      },
      "torrent-remove": {},
    });
    vi.stubGlobal("fetch", fn);
    const removed = await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null);
    expect(removed).toBe(2);
    const removals = calls.filter((c) => c.method === "torrent-remove").map((c) => [c.args.ids[0], c.args["delete-local-data"]]);
    expect(removals).toEqual([
      ["own-met", true],
      ["own-met-kept", false],
    ]);
  });
});

describe("Deluge (DL14)", () => {
  const dl = (over: Partial<DownloadClient> = {}) => client({ type: "deluge", host: "de.local", port: 8112, username: null, password: "deluge", category: "movies", ...over });
  const HASH = "d".repeat(40);

  function delugeFetch(answers: Record<string, unknown | ((args: any) => unknown)>, state: { connected: boolean; expireOnce?: boolean; dropOnce?: boolean } = { connected: false }) {
    const calls: { method: string; args: any }[] = [];
    let expired = !!state.expireOnce;
    let dropped = !!state.dropOnce;
    const fn = vi.fn(async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: body.method, args: body.params });
      if (body.method === "auth.login") return json({ result: true, error: null }, { headers: { "set-cookie": "_session_id=abc123; Path=/" } });
      if (body.method === "web.connected") return json({ result: state.connected, error: null });
      if (body.method === "web.get_hosts") return json({ result: [["hostid", "127.0.0.1", 58846, "localhost"]], error: null });
      if (body.method === "web.connect") {
        state.connected = true;
        return json({ result: null, error: null });
      }
      if (expired && body.method !== "auth.login") {
        expired = false;
        return json({ result: null, error: { code: 1, message: "Not authenticated" } });
      }
      // deluged restarted behind a web UI whose session is still good.
      if (dropped && body.method.startsWith("core.")) {
        dropped = false;
        state.connected = false;
        return json({ result: null, error: { code: 3, message: "Daemon not connected" } });
      }
      const answer = answers[body.method];
      if (answer instanceof Error) return json({ result: null, error: { code: 4, message: answer.message } });
      return json({ result: typeof answer === "function" ? (answer as (a: any) => unknown)(body.params) : answer, error: null });
    });
    return { fn, calls };
  }

  it("logs in, connects the web UI to its daemon, adds a magnet and sets the label", async () => {
    const { fn, calls } = delugeFetch({
      "core.add_torrent_magnet": HASH.toUpperCase(),
      "core.get_enabled_plugins": ["Label"],
      "label.get_labels": [],
      "label.add": null,
      "label.set_torrent": null,
    });
    vi.stubGlobal("fetch", fn);
    const result = await dc.getDownloadClientAdapter("deluge").addDownload(dl(), `magnet:?xt=urn:btih:${HASH}`, "movies");
    expect(result.downloadId).toBe(HASH);
    expect(calls.map((c) => c.method)).toEqual([
      "auth.login",
      "web.connected",
      "web.get_hosts",
      "web.connect",
      "core.add_torrent_magnet",
      "core.get_enabled_plugins",
      "label.get_labels",
      "label.add",
      "label.set_torrent",
    ]);
    expect(calls[0].args).toEqual(["deluge"]);
    expect(calls.find((c) => c.method === "label.set_torrent")!.args).toEqual([HASH, "movies"]);
  });

  it("gives the Label plugin a label it accepts", async () => {
    const { fn, calls } = delugeFetch(
      { "core.add_torrent_magnet": HASH, "core.get_enabled_plugins": ["Label"], "label.get_labels": [], "label.add": null, "label.set_torrent": null },
      { connected: true }
    );
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("deluge").addDownload(dl(), `magnet:?xt=urn:btih:${HASH}`, "TV Shows");
    expect(calls.find((c) => c.method === "label.add")!.args).toEqual(["tv-shows"]);
    expect(calls.find((c) => c.method === "label.set_torrent")!.args).toEqual([HASH, "tv-shows"]);
  });

  it("tracks a torrent that Deluge already holds", async () => {
    const { fn } = delugeFetch({ "core.add_torrent_magnet": new Error(`Torrent already in session (${HASH}).`) }, { connected: true });
    vi.stubGlobal("fetch", fn);
    expect((await dc.getDownloadClientAdapter("deluge").addDownload(dl(), `magnet:?xt=urn:btih:${HASH.toUpperCase()}`, null)).downloadId).toBe(HASH);
  });

  it("connects the web UI to its daemon again when the daemon went away behind a good session", async () => {
    const { fn, calls } = delugeFetch({ "core.remove_torrent": true }, { connected: true, dropOnce: true });
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("deluge").removeDownload!(dl(), HASH, true);
    expect(calls.filter((c) => c.method === "web.connect").length).toBe(1);
    expect(calls.filter((c) => c.method === "core.remove_torrent").length).toBe(2);
  });

  it("raises a core error as it is when the web UI is still connected", async () => {
    const { fn } = delugeFetch({ "core.remove_torrent": new Error("Torrent does not exist") }, { connected: true });
    vi.stubGlobal("fetch", fn);
    await expect(dc.getDownloadClientAdapter("deluge").removeDownload!(dl(), HASH, true)).rejects.toThrow(/Torrent does not exist/);
  });

  it("still tracks the torrent when the Label plugin is not there", async () => {
    const { fn } = delugeFetch({ "core.add_torrent_magnet": HASH, "core.get_enabled_plugins": [] }, { connected: true });
    vi.stubGlobal("fetch", fn);
    expect((await dc.getDownloadClientAdapter("deluge").addDownload(dl(), `magnet:?xt=urn:btih:${HASH}`, "movies")).downloadId).toBe(HASH);
  });

  it("maps the torrent states", async () => {
    const t = (over: Record<string, unknown>) => ({ name: "Release", state: "Downloading", progress: 50, total_size: 1000, total_done: 500, eta: 30, save_path: "/downloads", message: "OK", download_payload_rate: 100, ...over });
    const hashes = ["1".repeat(40), "2".repeat(40), "3".repeat(40), "4".repeat(40)];
    const { fn } = delugeFetch(
      {
        "core.get_torrents_status": {
          [hashes[0]]: t({}),
          [hashes[1]]: t({ state: "Seeding", progress: 100, total_done: 1000, eta: 0 }),
          [hashes[2]]: t({ state: "Paused", progress: 10 }),
          [hashes[3]]: t({ state: "Error", message: "Disk full" }),
        },
      },
      { connected: true }
    );
    vi.stubGlobal("fetch", fn);
    const updates = await dc.getDownloadClientAdapter("deluge").getStatus(dl(), hashes);
    const by = (h: string) => updates.find((u) => u.downloadId === h)!;
    expect(by(hashes[0])).toMatchObject({ status: "downloading", progress: 0.5, etaSeconds: 30, sizeLeft: 500 });
    expect(by(hashes[1])).toMatchObject({ status: "completed", remotePath: "/downloads/Release" });
    expect(by(hashes[2])).toMatchObject({ status: "downloading", paused: true });
    expect(by(hashes[3])).toMatchObject({ status: "downloading", warning: "Deluge: Disk full" });
  });

  it("adds a torrent started (add_paused: false), whether it is a magnet or a .torrent file (Round 30b)", async () => {
    const { fn, calls } = delugeFetch({ "core.add_torrent_magnet": HASH, "core.add_torrent_file": HASH }, { connected: true });
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).includes("de.local") ? fn(url, init) : Promise.resolve({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from("d4:infod4:name1:xee") })
    );

    await dc.getDownloadClientAdapter("deluge").addDownload(dl(), `magnet:?xt=urn:btih:${HASH}`, null);
    await dc.getDownloadClientAdapter("deluge").addDownload(dl(), "https://idx.example.com/dl.torrent", null);

    expect(calls.find((c) => c.method === "core.add_torrent_magnet")!.args).toEqual([`magnet:?xt=urn:btih:${HASH}`, { add_paused: false }]);
    expect(calls.find((c) => c.method === "core.add_torrent_file")!.args).toEqual(["release.torrent", Buffer.from("d4:infod4:name1:xee").toString("base64"), { add_paused: false }]);
  });

  describe("asks only for the torrents it is polled about (Round 30b)", () => {
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const OTHER = "c".repeat(40);
    const t = (over: Record<string, unknown> = {}) => ({ name: "Release", state: "Downloading", progress: 50, total_size: 1000, total_done: 500, eta: 30, save_path: "/downloads", message: "OK", download_payload_rate: 100, ...over });

    it("filters core.get_torrents_status by id with the lower-cased hashes, once each, and answers only those", async () => {
      const library: Record<string, unknown> = { [A]: t(), [B]: t({ state: "Seeding", progress: 100, total_done: 1000, eta: 0 }), [OTHER]: t() };
      // Like Deluge: the filter's id list narrows the answer.
      const { fn, calls } = delugeFetch(
        { "core.get_torrents_status": (args: any) => Object.fromEntries(Object.entries(library).filter(([hash]) => !args[0]?.id || args[0].id.includes(hash))) },
        { connected: true }
      );
      vi.stubGlobal("fetch", fn);

      const updates = await dc.getDownloadClientAdapter("deluge").getStatus(dl(), [A.toUpperCase(), B, A]);

      const asked = calls.filter((c) => c.method === "core.get_torrents_status");
      expect(asked).toHaveLength(1);
      expect(asked[0].args[0]).toEqual({ id: [A, B] });
      expect(asked[0].args[1]).toContain("state");
      // Each is reported under the id it was asked about (the queue row's own spelling).
      expect(updates.map((u) => u.downloadId).sort()).toEqual([A.toUpperCase(), B].sort());
      expect(updates.find((u) => u.downloadId === B)).toMatchObject({ status: "completed" });
      expect(updates.some((u) => u.downloadId === OTHER)).toBe(false);
    });

    it("ignores a torrent in the answer that it did not ask about", async () => {
      const { fn } = delugeFetch({ "core.get_torrents_status": { [A]: t(), [OTHER]: t() } }, { connected: true });
      vi.stubGlobal("fetch", fn);

      const updates = await dc.getDownloadClientAdapter("deluge").getStatus(dl(), [A]);

      expect(updates.map((u) => u.downloadId)).toEqual([A]);
    });

    it("lists no torrent at all when asked about none: it only checks that the web UI answers", async () => {
      const { fn, calls } = delugeFetch({ "core.get_torrents_status": { [A]: t(), [B]: t() } }, { connected: true });
      vi.stubGlobal("fetch", fn);

      const updates = await dc.getDownloadClientAdapter("deluge").getStatus(dl(), []);

      expect(updates).toEqual([]);
      const methods = calls.map((c) => c.method);
      expect(methods).toContain("web.connected");
      expect(methods.filter((m) => m.startsWith("core.") || m.startsWith("label."))).toEqual([]);
    });

    it("still fails when asked about none and the web UI cannot be reached", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json({ result: false, error: null })));

      await expect(dc.getDownloadClientAdapter("deluge").getStatus(dl(), [])).rejects.toThrow(/rejected the login/);
    });
  });

  it("logs in again once when the session has expired", async () => {
    const { fn, calls } = delugeFetch({ "core.remove_torrent": true }, { connected: true, expireOnce: true });
    vi.stubGlobal("fetch", fn);
    await dc.getDownloadClientAdapter("deluge").removeDownload!(dl(), HASH, true);
    expect(calls.filter((c) => c.method === "auth.login").length).toBe(2);
    expect(calls.filter((c) => c.method === "core.remove_torrent").map((c) => c.args)).toEqual([
      [HASH, true],
      [HASH, true],
    ]);
  });

  it("the connection test names a wrong password", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ result: false, error: null })));
    await expect(dc.testDownloadClientConnection(dl())).rejects.toThrow(/rejected the login/);
  });
});

describe("an indexer that does not answer (DL10)", () => {
  it.each([
    ["nzbget", () => client({ type: "nzbget", host: "nz.local", port: 6789 })],
    ["transmission", () => client({ type: "transmission", host: "tr.local", port: 9091 })],
    ["deluge", () => client({ type: "deluge", host: "de.local", port: 8112 })],
  ] as const)("is named as the indexer's failure, not %s's", async (type, make) => {
    // Only the release URL is asked for; the client is never reached.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:9696"), { code: "ECONNREFUSED" }) }))));
    await expect(dc.getDownloadClientAdapter(type).addDownload(make(), "https://idx.example.com/dl.nzb?apikey=x", "tv", "Release")).rejects.toThrow(/^Failed to resolve download URL: the indexer did not answer/);
  });
});

describe("cleaning up after an import (DL21)", () => {
  it("slskd: removes a file's transfer, or every transfer of a folder, from its list", async () => {
    const deletes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "DELETE") {
          deletes.push(String(url));
          return { ok: true, status: 204, headers: new Headers(), json: async () => ({}) };
        }
        return json([
          {
            username: "peer",
            directories: [
              {
                files: [
                  { id: "t1", filename: "Music\\Album\\01.flac" },
                  { id: "t2", filename: "Music\\Album\\02.flac" },
                  { id: "t3", filename: "Music\\Other\\01.flac" },
                ],
              },
            ],
          },
        ]);
      })
    );
    const c = client({ type: "slskd", host: "sl.local", port: 5030, apiKey: "k" });
    await dc.getDownloadClientAdapter("slskd").removeDownload!(c, "peer Music\\Other\\01.flac", false);
    expect(deletes).toEqual(["http://sl.local:5030/api/v0/transfers/downloads/peer/t3?remove=true"]);
  });

  it("Blackhole: deletes what the external client wrote for the release, and nothing outside the downloads folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-blackhole-"));
    const original = config.downloadsDir;
    (config as any).downloadsDir = dir;
    try {
      const out = path.join(dir, "Some.Release.2024.1080p");
      fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, "movie.mkv"), "x");
      const adapter = dc.getDownloadClientAdapter("blackhole");
      const c = client({ type: "blackhole", host: path.join(dir, "watch") });
      await adapter.removeDownload!(c, "uuid|Some.Release.2024.1080p", false);
      expect(fs.existsSync(out)).toBe(true);
      await adapter.removeDownload!(c, "uuid|Some.Release.2024.1080p", true);
      expect(fs.existsSync(out)).toBe(false);
      await adapter.removeDownload!(c, "uuid|Not.There", true);
    } finally {
      (config as any).downloadsDir = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
