import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

/**
 * Round 30b: the adapters against what the real clients answer (reports/backend-audit-2026-11-02/round30b-live-clients/REPORT.md).
 * Each describe block is named after the finding it covers (S1, Q1-Q4, A1-A6, B1-B7, T1, D1-D3).
 */

let dc: typeof import("../src/services/downloadClient.js");
let scheduler: typeof import("../src/services/scheduler.js");
let log: (typeof import("../src/services/logger.js"))["log"];
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  dc = await import("../src/services/downloadClient.js");
  scheduler = await import("../src/services/scheduler.js");
  ({ log } = await import("../src/services/logger.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextClientId = 810_000;
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

interface Call {
  url: string;
  init: any;
  /** The RPC method of a JSON body (`method`), when the body is one. */
  method: string | null;
  /** The RPC parameters of a JSON body (`params`, or Transmission's `arguments`). */
  params: any;
  body: any;
}

/** Replaces fetch with `handler`, which answers (or throws) for each call; every call is recorded. */
function stubFetch(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init: any = {}) => {
    let method: string | null = null;
    let params: any = null;
    if (typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        method = parsed?.method ?? null;
        params = parsed?.params ?? parsed?.arguments ?? null;
      } catch {
        // not an RPC body
      }
    }
    const call: Call = { url: String(url), init, method, params, body: init.body };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

/** A fetch Response stand-in. A string body is sent as plain text (and is not JSON); anything else as JSON. */
function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => {
      const bytes = Buffer.from(text);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

/** A fetch Response whose body is the given bytes (a .torrent or NZB download from an indexer). */
function bytesReply(bytes: Buffer, init: { status?: number; headers?: Record<string, string> } = {}) {
  return {
    ...reply("", init),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to be rejected");
}

let grabNumber = 0;
/** A new movie and a release of it for the scheduler's grab(). */
async function prepareGrab(downloadUrl: string, protocol: "torrent" | "usenet") {
  const title = `Live Findings Film ${++grabNumber}`;
  const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(title, title.toLowerCase())).lastInsertRowid);
  const { mediaItemFromRow } = await import("../src/db/mappers.js");
  const item = mediaItemFromRow((await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id)) as any);
  // No indexer id: queue.indexer_id is a foreign key to a real indexer row, and no test here has one.
  const release = { indexerId: null, indexerName: "Idx", title: `${title.replace(/ /g, ".")}.2020.1080p`, size: 1, seeders: 5, leechers: 0, publishDate: null, downloadUrl, protocol, category: null } as any;
  return { item, chosen: { result: release, quality: "WEBDL-1080p" } as any };
}
/** Grabs a release for a new movie through the real scheduler and the real adapter, and returns the error the grab ended in. */
async function grabTo(target: DownloadClient, downloadUrl: string, protocol: "torrent" | "usenet" = "torrent") {
  const { item, chosen } = await prepareGrab(downloadUrl, protocol);
  return failure(scheduler.grab(target, item, null, null, chosen, 0, null, "auto"));
}

const NZB =
  '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="a" date="1" subject="x"><groups><group>g</group></groups><segments><segment bytes="1" number="1">id</segment></segments></file></nzb>';

// Bencoding, built here so the tests do not lean on the code under test.
const bstr = (value: string | Buffer): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value, "latin1") : value;
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "latin1"), bytes]);
};
const bint = (n: number): Buffer => Buffer.from(`i${n}e`, "latin1");
const blist = (...items: Buffer[]): Buffer => Buffer.concat([Buffer.from("l"), ...items, Buffer.from("e")]);
const bdict = (entries: [string, Buffer][]): Buffer => Buffer.concat([Buffer.from("d"), ...entries.flatMap(([key, value]) => [bstr(key), value]), Buffer.from("e")]);
const sha1 = (bytes: Buffer) => crypto.createHash("sha1").update(bytes).digest("hex");

/** 20 bytes made of the characters bencode itself is built from ("e", ":", "i", "d", "l", "4:infod"), plus NUL and 0xff. */
const PIECES = Buffer.from([0x65, 0x3a, 0x69, 0x64, 0x6c, 0x65, 0x00, 0xff, 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f, 0x64, 0x65, 0x31, 0x32, 0x3a, 0x65]);
/** d6:lengthi5e4:name1:a12:piece lengthi16384e6:pieces20:<20 bytes>e */
const INFO = bdict([
  ["length", bint(5)],
  ["name", bstr("a")],
  ["piece length", bint(16384)],
  ["pieces", bstr(PIECES)],
]);
const INFO_HASH = sha1(INFO);
const TORRENT = bdict([
  ["announce", bstr("http://tracker.example/announce")],
  ["info", INFO],
]);

// ---------------------------------------------------------------------------
// S1: a failed connection names its cause
// ---------------------------------------------------------------------------

describe("a failed connection names its cause (S1)", () => {
  const networkError = (code: string | null, causeMessage = `connect ${code}`) => {
    const cause: Error & { code?: string } = new Error(causeMessage);
    if (code) cause.code = code;
    return Object.assign(new TypeError("fetch failed"), { cause });
  };
  const qbit = () => dc.getDownloadClientAdapter("qbittorrent");
  const sab = () => client({ type: "sabnzbd", host: "sab.local", apiKey: "KEY" });

  it.each([
    ["ECONNREFUSED", "connection refused: nothing listens on that host and port"],
    ["ENOTFOUND", "host name not found"],
    ["ETIMEDOUT", "connection timed out"],
    ["EAI_AGAIN", "host name could not be looked up"],
    ["EHOSTUNREACH", "host unreachable"],
    ["ENETUNREACH", "network unreachable"],
    ["ECONNRESET", "connection reset by the other side"],
    ["UND_ERR_CONNECT_TIMEOUT", "connection timed out"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
    ["CERT_HAS_EXPIRED", "the certificate has expired"],
  ])("%s is added to the message", async (code, text) => {
    const original = networkError(code);
    stubFetch(() => {
      throw original;
    });

    const err = await failure(qbit().getStatus(client(), []));

    expect(err.message).toBe(`fetch failed (${text})`);
    // It is still the TypeError undici threw, and the chain still reaches the original error and its errno.
    expect(err.name).toBe("TypeError");
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(original);
    expect(err.cause.cause.code).toBe(code);
  });

  it("explains UND_ERR_SOCKET as the client closing the connection, which NZBGet does after failed logins", async () => {
    stubFetch(() => {
      throw networkError("UND_ERR_SOCKET", "other side closed");
    });

    const err = await failure(dc.getDownloadClientAdapter("nzbget").getStatus(client({ type: "nzbget", port: 6789 }), []));

    expect(err.message).toMatch(/^fetch failed \(the client closed the connection \(NZBGet does this/);
    expect(err.name).toBe("TypeError");
  });

  it("names an errno it has no words for by its code, and a cause without a code by the cause's own message", async () => {
    stubFetch(() => {
      throw networkError("EPROTO");
    });
    expect((await failure(dc.testDownloadClientConnection(sab()))).message).toBe("fetch failed (EPROTO)");

    stubFetch(() => {
      throw networkError(null, "socket hang up");
    });
    expect((await failure(dc.testDownloadClientConnection(sab()))).message).toBe("fetch failed (socket hang up)");
  });

  it("leaves an error alone that already says the reason, one without a cause, a timeout and a thrown string", async () => {
    const saysIt = Object.assign(new TypeError("write EPIPE"), { cause: Object.assign(new Error("boom"), { code: "EPIPE" }) });
    stubFetch(() => {
      throw saysIt;
    });
    expect(await failure(dc.testDownloadClientConnection(sab()))).toBe(saysIt);

    const noCause = new TypeError("fetch failed");
    stubFetch(() => {
      throw noCause;
    });
    expect(await failure(dc.testDownloadClientConnection(sab()))).toBe(noCause);

    // A timeout (the AbortSignal.timeout of apiFetch) has no cause: it comes through as it was.
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    stubFetch(() => {
      throw timeout;
    });
    const err = await failure(dc.testDownloadClientConnection(sab()));
    expect(err).toBe(timeout);
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toBe("The operation was aborted due to timeout");

    stubFetch(() => {
      throw "plain string";
    });
    expect(await failure(dc.testDownloadClientConnection(sab()))).toBe("plain string");
  });

  describe("the scheduler still takes it for a client that is down", () => {
    const magnet = `magnet:?xt=urn:btih:${"c".repeat(40)}`;

    it("treats a refused connection as the client being unavailable, with the cause in the message", async () => {
      stubFetch(() => {
        throw networkError("ECONNREFUSED");
      });

      const err = await grabTo(client(), magnet);

      expect(err).toBeInstanceOf(scheduler.DownloadClientUnavailableError);
      expect(err.message).toMatch(/is unavailable: fetch failed \(connection refused: nothing listens on that host and port\)/);
    });

    it("treats a closed connection and a timeout the same way", async () => {
      stubFetch(() => {
        throw networkError("UND_ERR_SOCKET");
      });
      expect(await grabTo(client(), magnet)).toBeInstanceOf(scheduler.DownloadClientUnavailableError);

      stubFetch(() => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
      expect(await grabTo(client(), magnet)).toBeInstanceOf(scheduler.DownloadClientUnavailableError);
    });

    it("does not blame the client when it is the indexer that does not answer", async () => {
      const { calls } = stubFetch(() => {
        throw networkError("ECONNREFUSED");
      });

      const err = await grabTo(client(), "https://idx.example.com/get/1.torrent");

      expect(err).toBeInstanceOf(scheduler.ReleaseRefusedError);
      expect(err.message).toMatch(/^Failed to resolve download URL: the indexer did not answer/);
      // Only the indexer was asked; the client was never reached.
      expect(calls.map((c) => new URL(c.url).host)).toEqual(["idx.example.com"]);
    });
  });
});

// ---------------------------------------------------------------------------
// SABnzbd (A1-A6)
// ---------------------------------------------------------------------------

describe("SABnzbd against the real client (A1-A6)", () => {
  const sab = (over: Partial<DownloadClient> = {}) => client({ type: "sabnzbd", host: "sab.local", port: 8080, apiKey: "KEY", username: null, password: null, category: "tv", ...over });
  const adapter = () => dc.getDownloadClientAdapter("sabnzbd");
  const modeOf = (url: string) => new URL(url).searchParams.get("mode");
  const RELEASE = "https://idx.example.com/getnzb/1.nzb";
  const HOSTNAME_DENIED = "Access denied - Hostname verification failed: https://sabnzbd.org/hostname-check";

  describe("HTTP 403 with a plain-text body (A1)", () => {
    function connectionTest(queueAnswer: unknown) {
      return stubFetch((call) => (modeOf(call.url) === "version" ? reply({ version: "5.1.3" }) : queueAnswer));
    }

    it("shows the status and what SABnzbd said for a wrong API key", async () => {
      connectionTest(reply("API Key Incorrect", { status: 403 }));

      const err = await failure(dc.testDownloadClientConnection(sab()));

      expect(err.message).toBe("HTTP 403 (API Key Incorrect).");
      expect(err.message).not.toMatch(/host_whitelist/);
    });

    it("adds the host_whitelist hint for a host name SABnzbd does not accept", async () => {
      connectionTest(reply(HOSTNAME_DENIED, { status: 403 }));

      const err = await failure(dc.testDownloadClientConnection(sab()));

      expect(err.message).toMatch(/^HTTP 403 \(Access denied - Hostname verification failed/);
      expect(err.message).toMatch(/host_whitelist/);
    });

    it("strips markup, keeps it short, and still gives the status when the body cannot be read", async () => {
      connectionTest(reply("<html><body><p>API Key Incorrect</p></body></html>", { status: 403 }));
      expect((await failure(dc.testDownloadClientConnection(sab()))).message).toBe("HTTP 403 (API Key Incorrect).");

      connectionTest(reply("x".repeat(500), { status: 403 }));
      const long = (await failure(dc.testDownloadClientConnection(sab()))).message as string;
      expect(long).toContain("x".repeat(200));
      expect(long).not.toContain("x".repeat(201));

      connectionTest({
        ...reply("", { status: 403 }),
        text: async () => {
          throw new Error("stream error");
        },
      });
      expect((await failure(dc.testDownloadClientConnection(sab()))).message).toBe("HTTP 403.");
    });

    it("does not quote an API key that the body repeats back (Round 30b, L9)", async () => {
      connectionTest(reply("Wrong key in /api?mode=queue&apikey=0123456789abcdef0123456789abcdef&output=json", { status: 403 }));

      const err = await failure(dc.testDownloadClientConnection(sab()));

      expect(err.message).toBe("HTTP 403 (Wrong key in /api?mode=queue&apikey=…&output=json).");
      expect(err.message).not.toContain("0123456789abcdef");

      // The key is cut off at the next space too, and in any letter case.
      connectionTest(reply("Rejected APIKEY=SECRETSECRET and apikey=other2 here", { status: 403 }));
      const second = (await failure(dc.testDownloadClientConnection(sab()))).message as string;
      expect(second).toBe("HTTP 403 (Rejected apikey=… and apikey=… here).");
      expect(second).not.toMatch(/SECRET|other2/);

      // And the add says the same about its own failure.
      stubFetch((call) => (call.url === RELEASE ? bytesReply(Buffer.from(NZB)) : reply("Key apikey=ADDSECRET refused", { status: 403 })));
      const add = await failure(adapter().addDownload(sab(), RELEASE, "tv", "Show.S01E01.1080p"));
      expect(add.message).toBe("SABnzbd add failed: HTTP 403 (Key apikey=… refused).");
    });

    it("says the same on the add, with the add prefix", async () => {
      stubFetch((call) => (call.url === RELEASE ? bytesReply(Buffer.from(NZB)) : reply(HOSTNAME_DENIED, { status: 403 })));

      const err = await failure(adapter().addDownload(sab(), RELEASE, "tv", "Show.S01E01.1080p"));

      expect(err.message).toMatch(/^SABnzbd add failed: HTTP 403 \(Access denied - Hostname verification failed: https:\/\/sabnzbd\.org\/hostname-check\)\./);
      expect(err.message).toMatch(/host_whitelist/);

      stubFetch((call) => (call.url === RELEASE ? bytesReply(Buffer.from(NZB)) : reply("API Key Incorrect", { status: 403 })));
      expect((await failure(adapter().addDownload(sab(), RELEASE, "tv", "Show.S01E01.1080p"))).message).toBe("SABnzbd add failed: HTTP 403 (API Key Incorrect).");
    });
  });

  describe("a refused NZB (A3)", () => {
    it("says SABnzbd refused the NZB when it answers status false with no job id and no error", async () => {
      stubFetch((call) => (call.url === RELEASE ? bytesReply(Buffer.from(NZB)) : reply({ status: false, nzo_ids: [] })));

      const err = await failure(adapter().addDownload(sab(), RELEASE, "tv", "Show.S01E01.1080p"));

      expect(err.message).toMatch(/^SABnzbd add failed: SABnzbd refused the NZB/);
      expect(err.message).not.toMatch(/rejected$/);
    });

    it("keeps the error text SABnzbd gives when it gives one", async () => {
      stubFetch((call) => (call.url === RELEASE ? bytesReply(Buffer.from(NZB)) : reply({ status: false, error: "API Key Incorrect" })));

      expect((await failure(adapter().addDownload(sab(), RELEASE, "tv", "Show.S01E01.1080p"))).message).toBe("SABnzbd add failed: API Key Incorrect");
    });
  });

  describe("deleting a job with its files (A5)", () => {
    it.each([
      [true, "1"],
      [false, "0"],
    ])("deleteFiles=%s sends del_files=%s on both the queue and the history delete", async (deleteFiles, expected) => {
      const { calls } = stubFetch(() => reply({ status: true }));

      await adapter().removeDownload!(sab(), "SABnzbd_nzo_abc123", deleteFiles);

      const deletes = calls.map((c) => new URL(c.url).searchParams);
      expect(deletes.map((q) => q.get("mode"))).toEqual(["queue", "history"]);
      for (const q of deletes) {
        expect(q.get("name")).toBe("delete");
        expect(q.get("value")).toBe("SABnzbd_nzo_abc123");
        expect(q.get("del_files")).toBe(expected);
        expect(q.get("apikey")).toBe("KEY");
      }
    });
  });

  describe("the path of a finished or failed job (A6)", () => {
    it("drops the path of a failed job, even when SABnzbd fills storage, and keeps a completed job's", async () => {
      stubFetch((call) => {
        if (modeOf(call.url) === "queue") return reply({ queue: { slots: [] } });
        return reply({
          history: {
            slots: [
              { nzo_id: "done", status: "Completed", storage: "/downloads/complete/tv/Show.S01E01" },
              { nzo_id: "bad", status: "Failed", storage: "/downloads/incomplete/Show.S01E02", fail_message: "Aborted, cannot be completed" },
              { nzo_id: "bad-silent", status: "Failed", storage: "/downloads/incomplete/Show.S01E03", fail_message: "" },
            ],
          },
        });
      });

      const updates = await adapter().getStatus(sab(), ["done", "bad", "bad-silent"]);
      const by = (id: string) => updates.find((u) => u.downloadId === id)!;

      expect(by("done")).toMatchObject({ status: "completed", progress: 1, remotePath: "/downloads/complete/tv/Show.S01E01" });
      expect(by("bad")).toMatchObject({ status: "failed", failureReason: "SABnzbd: Aborted, cannot be completed" });
      expect(by("bad").remotePath).toBeUndefined();
      expect(by("bad-silent")).toMatchObject({ status: "failed" });
      expect(by("bad-silent").remotePath).toBeUndefined();
      expect(by("bad-silent").failureReason).toBeUndefined();
    });
  });

  describe("health notes (A2, A4)", () => {
    /** An answer is a JSON body, or an Error to make the call fail. Misc defaults to an empty section. */
    function config(answers: { misc?: unknown; sorters?: unknown; cats?: unknown }) {
      return stubFetch((call) => {
        const q = new URL(call.url).searchParams;
        const answer = q.get("mode") === "get_cats" ? answers.cats : q.get("section") === "sorters" ? answers.sorters : (answers.misc ?? { config: { misc: {} } });
        if (answer instanceof Error) throw answer;
        return reply(answer ?? {});
      });
    }
    const cats = (...names: string[]) => ({ categories: ["*", ...names] });
    const sorters = (...flags: unknown[]) => ({ config: { sorters: flags.map((is_active, i) => ({ name: `sorter ${i}`, is_active })) } });
    const sortingNote = /has sorting turned on/;

    it("reports an active sorter from the sorters section, and asks for that section", async () => {
      const { calls } = config({ sorters: sorters(false, true), cats: cats("tv") });

      const notes = await adapter().healthNotes!(sab());

      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(sortingNote);
      const queries = calls.map((c) => new URL(c.url).searchParams);
      expect(queries.some((q) => q.get("mode") === "get_config" && q.get("section") === "sorters")).toBe(true);
    });

    it("counts an active flag written as 1, '1' or 'true' too", async () => {
      for (const flag of [1, "1", "true"]) {
        config({ sorters: sorters(flag), cats: cats("tv") });
        expect(await adapter().healthNotes!(sab())).toHaveLength(1);
      }
    });

    it("says nothing for sorters that are all inactive, or for no sorters at all", async () => {
      config({ sorters: sorters(false, 0, "0"), cats: cats("tv") });
      expect(await adapter().healthNotes!(sab())).toEqual([]);

      config({ sorters: { config: { sorters: [] } }, cats: cats("tv") });
      expect(await adapter().healthNotes!(sab())).toEqual([]);
    });

    it("still counts the old enable_*_sorting keys, with one note however many say so", async () => {
      config({ misc: { config: { misc: { enable_movie_sorting: "1" } } }, sorters: sorters(false), cats: cats("tv") });
      const old = await adapter().healthNotes!(sab());
      expect(old).toHaveLength(1);
      expect(old[0]).toMatch(sortingNote);

      config({ misc: { config: { misc: { enable_tv_sorting: "1", enable_date_sorting: "1" } } }, sorters: sorters(true), cats: cats("tv") });
      expect(await adapter().healthNotes!(sab())).toHaveLength(1);
    });

    describe("a sorter counts only for the categories it applies to (Round 30b, L8)", () => {
      /** One sorter, as get_config&section=sorters lists it. `cats` undefined leaves sort_cats out altogether. */
      const sorter = (is_active: unknown, cats?: unknown) => ({ name: "a sorter", is_active, ...(cats === undefined ? {} : { sort_cats: cats }) });
      const listing = (...list: unknown[]) => ({ config: { sorters: list } });

      it("counts an active sorter with no categories listed, an empty list, or '*'", async () => {
        for (const listed of [undefined, [], ["*"], ["movies", "*"]]) {
          config({ sorters: listing(sorter(true, listed)), cats: cats("tv") });
          const notes = await adapter().healthNotes!(sab());
          expect(notes, JSON.stringify(listed)).toHaveLength(1);
          expect(notes[0]).toMatch(sortingNote);
        }
      });

      it("counts an active sorter for one of the client's categories, whatever the case", async () => {
        config({ sorters: listing(sorter(true, ["TV"])), cats: cats("tv") });
        expect(await adapter().healthNotes!(sab({ category: "tv" }))).toHaveLength(1);

        config({ sorters: listing(sorter(true, ["anime", "Movies"])), cats: cats("tv", "movies") });
        expect(await adapter().healthNotes!(sab({ category: "tv", categoryByType: { movie: "movies" } }))).toHaveLength(1);
      });

      it("says nothing for an active sorter that applies to other categories only", async () => {
        config({ sorters: listing(sorter(true, ["anime"]), sorter(true, ["music", "books"])), cats: cats("tv") });

        expect(await adapter().healthNotes!(sab({ category: "tv" }))).toEqual([]);
      });

      it("says nothing for an inactive sorter, whichever categories it lists", async () => {
        config({ sorters: listing(sorter(false, ["tv"]), sorter(0, ["*"]), sorter("0", [])), cats: cats("tv") });

        expect(await adapter().healthNotes!(sab({ category: "tv" }))).toEqual([]);
      });

      it("finds the one sorter that applies among several", async () => {
        config({ sorters: listing(sorter(true, ["anime"]), sorter(false, ["tv"]), sorter(true, ["tv"])), cats: cats("tv") });

        expect(await adapter().healthNotes!(sab({ category: "tv" }))).toHaveLength(1);
      });

      it("for a client with no category, only a sorter that applies to every category counts", async () => {
        config({ sorters: listing(sorter(true, ["tv"])), cats: cats("tv") });
        expect(await adapter().healthNotes!(sab({ category: null }))).toEqual([]);

        config({ sorters: listing(sorter(true, ["tv"]), sorter(true, ["*"])), cats: cats("tv") });
        expect(await adapter().healthNotes!(sab({ category: null }))).toHaveLength(1);
      });

      it("does not let a sorter for other categories hide the old misc keys", async () => {
        config({ misc: { config: { misc: { enable_tv_sorting: "1" } } }, sorters: listing(sorter(true, ["anime"])), cats: cats("tv") });

        const notes = await adapter().healthNotes!(sab({ category: "tv" }));

        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(sortingNote);
      });
    });

    it("keeps the other notes when the sorters call fails", async () => {
      config({ misc: { config: { misc: { enable_tv_sorting: "1", history_retention_option: "all-delete" } } }, sorters: new Error("boom"), cats: cats("tv") });

      const notes = await adapter().healthNotes!(sab());

      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatch(sortingNote);
      expect(notes[1]).toMatch(/history at once/);
    });

    it("names a category SABnzbd does not have, and compares without regard to case", async () => {
      config({ sorters: sorters(), cats: cats("movies") });
      const missing = await adapter().healthNotes!(sab({ category: "anime" }));
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatch(/^has no category "anime"\./);
      expect(missing[0]).toMatch(/Add it under Config > Categories/);

      config({ sorters: sorters(), cats: cats("tv", "Movies") });
      expect(await adapter().healthNotes!(sab({ category: "TV", categoryByType: { movie: "movies" } }))).toEqual([]);
    });

    it("names every missing category when there are several (one per library type)", async () => {
      config({ sorters: sorters(), cats: cats("tv") });

      const notes = await adapter().healthNotes!(sab({ category: "tv", categoryByType: { movie: "movies", artist: "music" } }));

      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('"movies", "music"');
      expect(notes[0]).toMatch(/Add them under Config > Categories/);
    });

    it("says nothing about categories when SABnzbd lists none", async () => {
      config({ sorters: sorters(), cats: { categories: [] } });
      expect(await adapter().healthNotes!(sab({ category: "anime" }))).toEqual([]);
    });

    it("keeps the other notes when the category list fails, however it fails", async () => {
      const misc = { config: { misc: { history_retention_option: "all-delete" } } };

      config({ misc, sorters: sorters(true), cats: { status: false, error: "not allowed" } });
      let notes = await adapter().healthNotes!(sab());
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatch(sortingNote);
      expect(notes[1]).toMatch(/history at once/);

      config({ misc, sorters: sorters(true), cats: new Error("connection reset") });
      notes = await adapter().healthNotes!(sab());
      expect(notes).toHaveLength(2);
    });

    it("keeps the category note when the sorters call fails", async () => {
      config({ sorters: new Error("no such section"), cats: cats("movies") });

      const notes = await adapter().healthNotes!(sab({ category: "anime" }));

      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/has no category "anime"/);
    });
  });
});

// ---------------------------------------------------------------------------
// NZBGet (B2, B3, B6, B7)
// ---------------------------------------------------------------------------

describe("NZBGet against the real client (B2, B3, B6, B7)", () => {
  const nz = () => client({ type: "nzbget", host: "nz.local", port: 6789, username: "nzbget", password: "tegbzn6789", category: "tv" });
  const adapter = () => dc.getDownloadClientAdapter("nzbget");

  /** JSON-RPC answers by method; a function answer gets the params, and a throwing one makes the call fail. */
  function nzbget(answers: Record<string, unknown | ((params: any) => unknown)>) {
    return stubFetch((call) => {
      const answer = call.method ? answers[call.method] : undefined;
      return reply({ result: typeof answer === "function" ? (answer as (p: any) => unknown)(call.params) : (answer ?? null) });
    });
  }
  const statusCalls = (calls: Call[]) => calls.filter((c) => c.method === "status");

  describe("sizes in bytes (B2)", () => {
    it("reads FileSize and RemainingSize from their 32-bit halves", async () => {
      nzbget({
        listgroups: [
          { NZBID: 1, Status: "QUEUED", FileSizeLo: 5, FileSizeHi: 1, RemainingSizeLo: 5, RemainingSizeHi: 1 },
          { NZBID: 2, Status: "PAUSED", FileSizeLo: 0, FileSizeHi: 1, RemainingSizeLo: 2 ** 31, RemainingSizeHi: 0 },
        ],
      });

      const updates = await adapter().getStatus(nz(), ["1", "2"]);
      const by = (id: string) => updates.find((u) => u.downloadId === id)!;

      expect(by("1").sizeLeft).toBe(2 ** 32 + 5);
      expect(by("1").progress).toBe(0);
      // 4 GiB in all, 2 GiB left.
      expect(by("2").sizeLeft).toBe(2 ** 31);
      expect(by("2").progress).toBe(0.5);
    });

    it("counts a Lo with its top bit set as unsigned, whether NZBGet sends it as a large number or a negative one", async () => {
      nzbget({
        listgroups: [
          { NZBID: 1, Status: "QUEUED", FileSizeLo: 3_000_000_000, FileSizeHi: 0, RemainingSizeLo: 3_000_000_000, RemainingSizeHi: 0 },
          { NZBID: 2, Status: "QUEUED", FileSizeLo: -1_294_967_296, FileSizeHi: 0, RemainingSizeLo: -1_294_967_296, RemainingSizeHi: 0 },
          { NZBID: 3, Status: "QUEUED", FileSizeLo: 0x80000000, FileSizeHi: 1, RemainingSizeLo: 0x80000000, RemainingSizeHi: 1 },
        ],
      });

      const updates = await adapter().getStatus(nz(), ["1", "2", "3"]);

      expect(updates.find((u) => u.downloadId === "1")!.sizeLeft).toBe(3_000_000_000);
      expect(updates.find((u) => u.downloadId === "2")!.sizeLeft).toBe(3_000_000_000);
      expect(updates.find((u) => u.downloadId === "3")!.sizeLeft).toBe(2 ** 32 + 2 ** 31);
    });

    it("prefers the halves over the whole megabytes (a 150 kB NZB reads as 0 MB)", async () => {
      nzbget({ listgroups: [{ NZBID: 1, Status: "DOWNLOADING", FileSizeMB: 0, RemainingSizeMB: 0, FileSizeLo: 150_000, FileSizeHi: 0, RemainingSizeLo: 100_000, RemainingSizeHi: 0 }] });

      const [update] = await adapter().getStatus(nz(), ["1"]);

      expect(update.sizeLeft).toBe(100_000);
      expect(update.progress).toBeCloseTo(1 / 3, 5);
    });

    it("falls back to the megabyte fields when the halves are absent", async () => {
      nzbget({ listgroups: [{ NZBID: 1, Status: "QUEUED", FileSizeMB: 1000, RemainingSizeMB: 250 }] });

      const [update] = await adapter().getStatus(nz(), ["1"]);

      expect(update.sizeLeft).toBe(250 * 1024 * 1024);
      expect(update.progress).toBe(0.75);
    });

    it("reports no size left for a group with nothing left", async () => {
      nzbget({ listgroups: [{ NZBID: 1, Status: "UNPACKING", FileSizeLo: 5, FileSizeHi: 1, RemainingSizeLo: 0, RemainingSizeHi: 0 }] });

      const [update] = await adapter().getStatus(nz(), ["1"]);

      expect(update.sizeLeft).toBeUndefined();
      expect(update.progress).toBe(0.99);
    });
  });

  describe("estimated time from the download rate (B3)", () => {
    const downloading = (id: number, left: number) => ({ NZBID: id, Status: "DOWNLOADING", FileSizeLo: 2_000_000, FileSizeHi: 0, RemainingSizeLo: left, RemainingSizeHi: 0 });

    it("divides what is left by the rate, rounded, with one status call for the whole poll", async () => {
      const { calls } = nzbget({
        listgroups: [downloading(1, 1_100_000), downloading(2, 600_000), { NZBID: 3, Status: "PAUSED", FileSizeLo: 2_000_000, FileSizeHi: 0, RemainingSizeLo: 1_000_000, RemainingSizeHi: 0 }],
        status: { DownloadRate: 300_000, PostPaused: false },
      });

      const updates = await adapter().getStatus(nz(), ["1", "2", "3"]);
      const by = (id: string) => updates.find((u) => u.downloadId === id)!;

      expect(by("1").etaSeconds).toBe(4); // 3.67 s
      expect(by("2").etaSeconds).toBe(2);
      expect(by("3").etaSeconds).toBeUndefined(); // not downloading
      expect(statusCalls(calls)).toHaveLength(1);
    });

    it("gives no estimate while the rate is 0 or the status says nothing", async () => {
      nzbget({ listgroups: [downloading(1, 1_100_000)], status: { DownloadRate: 0 } });
      expect((await adapter().getStatus(nz(), ["1"]))[0].etaSeconds).toBeUndefined();

      nzbget({ listgroups: [downloading(1, 1_100_000)] });
      expect((await adapter().getStatus(nz(), ["1"]))[0].etaSeconds).toBeUndefined();
    });

    it("asks for the status only when a group needs it", async () => {
      const { calls } = nzbget({
        listgroups: [
          { NZBID: 1, Status: "PAUSED", FileSizeMB: 100, RemainingSizeMB: 100 },
          { NZBID: 2, Status: "QUEUED", FileSizeMB: 100, RemainingSizeMB: 100 },
          { NZBID: 3, Status: "UNPACKING", FileSizeMB: 100, RemainingSizeMB: 0 },
        ],
        history: [{ NZBID: 4, Status: "SUCCESS/ALL", DestDir: "/downloads/x" }],
        status: { DownloadRate: 1000, PostPaused: true },
      });

      await adapter().getStatus(nz(), ["1", "2", "3", "4"]);

      expect(statusCalls(calls)).toHaveLength(0);
    });

    it("ignores a failing status call, and does not repeat it for the next group", async () => {
      const { calls } = nzbget({
        listgroups: [downloading(1, 1_100_000), downloading(2, 600_000)],
        status: () => {
          throw new Error("NZBGet status failed: HTTP 500");
        },
      });

      const updates = await adapter().getStatus(nz(), ["1", "2"]);

      expect(updates).toHaveLength(2);
      expect(updates.every((u) => u.status === "downloading" && u.etaSeconds === undefined)).toBe(true);
      expect(updates.find((u) => u.downloadId === "1")!.sizeLeft).toBe(1_100_000);
      expect(statusCalls(calls)).toHaveLength(1);
    });
  });

  describe("post-processing paused (B6)", () => {
    const ppQueued = { NZBID: 1, Status: "PP_QUEUED", FileSizeMB: 100, RemainingSizeMB: 0 };

    it("marks a PP_QUEUED group paused when NZBGet's post-processing is paused", async () => {
      const { calls } = nzbget({ listgroups: [ppQueued], status: { PostPaused: true, DownloadRate: 0 } });

      const [update] = await adapter().getStatus(nz(), ["1"]);

      expect(update).toMatchObject({ status: "downloading", progress: 0.99, paused: true });
      expect(statusCalls(calls)).toHaveLength(1);
    });

    it("leaves a PP_QUEUED group unpaused when post-processing is not paused", async () => {
      nzbget({ listgroups: [ppQueued], status: { PostPaused: false, DownloadRate: 0 } });

      const [update] = await adapter().getStatus(nz(), ["1"]);

      expect(update).toMatchObject({ status: "downloading", progress: 0.99 });
      expect(update.paused).toBeUndefined();
    });

    it("does not mark it paused when the status call fails", async () => {
      nzbget({
        listgroups: [ppQueued],
        status: () => {
          throw new Error("down");
        },
      });

      const [update] = await adapter().getStatus(nz(), ["1"]);

      expect(update.paused).toBeUndefined();
    });

    it("does not mark a group that is working as paused just because post-processing is", async () => {
      nzbget({ listgroups: [{ NZBID: 1, Status: "UNPACKING", FileSizeMB: 100, RemainingSizeMB: 0 }, { NZBID: 2, Status: "DOWNLOADING", FileSizeMB: 100, RemainingSizeMB: 50 }], status: { PostPaused: true, DownloadRate: 0 } });

      const updates = await adapter().getStatus(nz(), ["1", "2"]);

      expect(updates.every((u) => u.paused === undefined)).toBe(true);
    });
  });

  describe("failure reasons in words (B7)", () => {
    async function failureReason(history: Record<string, unknown>) {
      nzbget({ listgroups: [], history: [{ NZBID: 9, ...history }] });
      const [update] = await adapter().getStatus(nz(), ["9"]);
      expect(update).toMatchObject({ downloadId: "9", status: "failed", progress: 1 });
      return update.failureReason;
    }

    it("says how far the health fell short when articles are missing", async () => {
      expect(await failureReason({ Status: "FAILURE/HEALTH", Health: 0, CriticalHealth: 1000 })).toBe(
        "NZBGet: too many articles missing (health 0%, below the critical 100%) (FAILURE/HEALTH)"
      );
      expect(await failureReason({ Status: "FAILURE/HEALTH", Health: 874, CriticalHealth: 900 })).toBe(
        "NZBGet: too many articles missing (health 87.4%, below the critical 90%) (FAILURE/HEALTH)"
      );
    });

    it("leaves the numbers out when NZBGet gave none, or a critical health of 0", async () => {
      expect(await failureReason({ Status: "FAILURE/HEALTH" })).toBe("NZBGet: too many articles missing (FAILURE/HEALTH)");
      expect(await failureReason({ Status: "FAILURE/HEALTH", Health: 0, CriticalHealth: 0 })).toBe("NZBGet: too many articles missing (FAILURE/HEALTH)");
    });

    it.each([
      ["FAILURE/SCAN", "NZBGet: the NZB could not be read or lists no files (FAILURE/SCAN)"],
      ["FAILURE/PAR", "NZBGet: par repair failed (FAILURE/PAR)"],
      ["FAILURE/UNPACK", "NZBGet: unpacking failed (FAILURE/UNPACK)"],
      ["FAILURE/MOVE", "NZBGet: the result could not be moved to its folder (FAILURE/MOVE)"],
      ["FAILURE/BAD", "NZBGet: marked bad by a script (FAILURE/BAD)"],
      ["DELETED/MANUAL", "NZBGet: deleted in NZBGet (DELETED/MANUAL)"],
      ["DELETED/GOOD", "NZBGet: deleted in NZBGet (DELETED/GOOD)"],
      ["DELETED/DUPE", "NZBGet: dropped as a duplicate (DELETED/DUPE)"],
      ["DELETED/COPY", "NZBGet: dropped as a copy of another download (DELETED/COPY)"],
    ])("%s", async (status, reason) => {
      expect(await failureReason({ Status: status })).toBe(reason);
    });

    it("marks a copy or duplicate NZBGet dropped as not the release's fault (noBlame), and no other end", async () => {
      const statuses = ["DELETED/COPY", "DELETED/DUPE", "DELETED/MANUAL", "DELETED/GOOD", "FAILURE/HEALTH", "FAILURE/SCAN", "FAILURE/PAR", "FAILURE/UNPACK", "FAILURE/ZIPPED", "WARNING/PASSWORD"];
      nzbget({ listgroups: [], history: statuses.map((Status, i) => ({ NZBID: 100 + i, Status })) });

      const updates = await adapter().getStatus(nz(), statuses.map((_s, i) => String(100 + i)));

      expect(updates).toHaveLength(statuses.length);
      for (const [i, status] of statuses.entries()) {
        const update = updates.find((u) => u.downloadId === String(100 + i))!;
        expect(update.status, status).toBe("failed");
        if (status === "DELETED/COPY" || status === "DELETED/DUPE") expect(update.noBlame, status).toBe(true);
        else expect(update.noBlame, status).toBeUndefined();
      }
    });

    it("does not mark a download that finished, or one still running, noBlame", async () => {
      nzbget({
        listgroups: [{ NZBID: 1, Status: "PAUSED", FileSizeMB: 100, RemainingSizeMB: 100 }],
        history: [{ NZBID: 2, Status: "SUCCESS/ALL", DestDir: "/downloads/x" }, { NZBID: 3, Status: "WARNING/SPACE" }],
      });

      const updates = await adapter().getStatus(nz(), ["1", "2", "3"]);

      expect(updates).toHaveLength(3);
      expect(updates.every((u) => u.noBlame === undefined)).toBe(true);
    });

    it("falls back to the raw status for one it has no words for", async () => {
      expect(await failureReason({ Status: "FAILURE/ZIPPED" })).toBe("NZBGet: FAILURE/ZIPPED");
      expect(await failureReason({ Status: "DELETED/ELSEWHERE" })).toBe("NZBGet: DELETED/ELSEWHERE");
    });
  });
});

// ---------------------------------------------------------------------------
// qBittorrent (Q1-Q4)
// ---------------------------------------------------------------------------

describe("torrentInfoHash (Q3)", () => {
  it("builds the torrent the way the spec shows it", () => {
    // Guards the helpers above: d6:length i5e 4:name 1:a 12:piece length i16384e 6:pieces 20:<20 bytes> e
    const head = "d6:lengthi5e4:name1:a12:piece lengthi16384e6:pieces20:";
    expect(INFO.subarray(0, head.length).toString("latin1")).toBe(head);
    expect(INFO.length).toBe(head.length + 20 + 1);
  });

  it("is the SHA-1 of exactly the bytes of the info dictionary", () => {
    expect(dc.torrentInfoHash(TORRENT)).toBe(INFO_HASH);
    expect(INFO_HASH).toMatch(/^[0-9a-f]{40}$/);
  });

  it("finds the info dictionary when it is not the first key, with lists, dictionaries, integers and binary strings around it", () => {
    const info = bdict([
      ["files", blist(bdict([["length", bint(3)], ["path", blist(bstr("dir"), bstr("a.txt"))]]), bdict([["length", bint(12345678901)], ["path", blist(bstr("b.bin"))]]), bint(-7))],
      ["name", bstr("pack")],
      ["piece length", bint(32768)],
      ["pieces", bstr(Buffer.alloc(40, 0x65))], // forty "e": the byte that ends every dictionary, list and integer
      ["private", bint(1)],
    ]);
    const torrent = bdict([
      // Binary that contains "4:infod": a search for the key would stop here.
      ["aaa", bstr(PIECES)],
      ["announce", bstr("http://tracker.example/announce")],
      ["announce-list", blist(blist(bstr("http://a.example")), blist(bstr("http://b.example"), bstr("udp://c.example:80")), blist())],
      ["comment", bstr("see 4:info for details")],
      ["created by", bstr("test")],
      ["creation date", bint(1700000000)],
      // An "info" key one level down is not the torrent's.
      ["extra", bdict([["info", bint(1)], ["z", blist(bstr("y"))]])],
      ["info", info],
      ["url-list", blist(bstr("http://seed.example/"))],
    ]);

    expect(dc.torrentInfoHash(torrent)).toBe(sha1(info));
  });

  it("hashes the bytes as they sit in the file, not a re-encoded dictionary (keys in any order)", () => {
    const info = bdict([
      ["pieces", bstr(PIECES)],
      ["name", bstr("a")],
      ["length", bint(5)],
      ["piece length", bint(16384)],
    ]);

    expect(dc.torrentInfoHash(bdict([["info", info]]))).toBe(sha1(info));
    expect(sha1(info)).not.toBe(INFO_HASH);
  });

  describe("v2 torrents (Round 30b, L1)", () => {
    // A v2 file tree: a.txt (5 bytes). Present in a v2-only and in a hybrid torrent.
    const FILE_TREE = bdict([["a.txt", bdict([["", bdict([["length", bint(5)]])]])]]);

    const v2OnlyInfo = bdict([
      ["file tree", FILE_TREE],
      ["meta version", bint(2)],
      ["name", bstr("a")],
      ["piece length", bint(16384)],
    ]);
    const hybridInfo = bdict([
      ["file tree", FILE_TREE],
      ["length", bint(5)],
      ["meta version", bint(2)],
      ["name", bstr("a")],
      ["piece length", bint(16384)],
      ["pieces", bstr(PIECES)],
    ]);

    it("builds the info dictionaries it means to", () => {
      expect(v2OnlyInfo.includes("12:meta versioni2e")).toBe(true);
      expect(v2OnlyInfo.includes("6:pieces")).toBe(false);
      expect(hybridInfo.includes("12:meta versioni2e")).toBe(true);
      expect(hybridInfo.includes("6:pieces")).toBe(true);
    });

    it("answers null for a v2-only torrent: qBittorrent keys it by a SHA-256 this does not compute", () => {
      expect(dc.torrentInfoHash(bdict([["announce", bstr("http://tracker.example/announce")], ["info", v2OnlyInfo]]))).toBeNull();
    });

    it("still gives the SHA-1 of a hybrid torrent's info dictionary, which has both meta version 2 and pieces", () => {
      expect(dc.torrentInfoHash(bdict([["announce", bstr("http://tracker.example/announce")], ["info", hybridInfo]]))).toBe(sha1(hybridInfo));
    });

    it("answers null for a v2-only torrent whatever else is around its info", () => {
      const torrent = bdict([
        ["announce", bstr("http://tracker.example/announce")],
        ["info", v2OnlyInfo],
        ["piece layers", bdict([["root", bstr("r".repeat(32))]])],
      ]);
      expect(dc.torrentInfoHash(torrent)).toBeNull();
    });
  });

  it("answers null for what is not a torrent", () => {
    expect(dc.torrentInfoHash(Buffer.alloc(0))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("this is not a torrent"))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("<html><body>Please log in</body></html>"))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from('{"error":"rate limited"}'))).toBeNull();
    // Bencode, but not a dictionary.
    expect(dc.torrentInfoHash(bstr("hello"))).toBeNull();
    expect(dc.torrentInfoHash(bint(7))).toBeNull();
    expect(dc.torrentInfoHash(blist(bstr("info"), INFO))).toBeNull();
  });

  it("answers null for a dictionary without an info key", () => {
    expect(dc.torrentInfoHash(Buffer.from("de"))).toBeNull();
    expect(dc.torrentInfoHash(bdict([["announce", bstr("http://tracker.example/announce")], ["comment", bstr("no info here")]]))).toBeNull();
  });

  it("answers null for a file cut short", () => {
    // Cut inside the 20 bytes of pieces.
    expect(dc.torrentInfoHash(TORRENT.subarray(0, TORRENT.length - 15))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("d4:info"))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("d4:infod"))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("d4:infod4:name1:a"))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("d4:infoi5"))).toBeNull();
    expect(dc.torrentInfoHash(Buffer.from("d10:annou"))).toBeNull();
  });
});

describe("qBittorrent against the real client (Q1-Q4)", () => {
  const adapter = () => dc.getDownloadClientAdapter("qbittorrent");
  const RELEASE = "https://idx.example.com/get/123.torrent";
  const HASH = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a";
  const V2_TRUNCATED = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
  const LOGIN = reply("Ok.", { headers: { "set-cookie": "SID=abc; Path=/" } });

  interface Server {
    /** What the indexer answers for the release URL. */
    release?: () => unknown;
    /** The answer to torrents/add. */
    add?: (call: Call) => unknown;
    /** torrents/info?hashes=<hash>: the torrents found. */
    direct?: (hash: string) => unknown[];
    /** torrents/info: the whole list (an HTTP status makes the call fail). */
    list?: unknown[] | number;
    /** torrents/info?tag=<tag>: the torrents carrying that tag (how a torrent added without a known hash is found again). */
    tagged?: (tag: string) => unknown[];
  }
  function qbittorrent(server: Server = {}) {
    return stubFetch((call) => {
      const { url } = call;
      if (url === RELEASE) return server.release ? server.release() : bytesReply(TORRENT);
      if (url.endsWith("/auth/login")) return LOGIN;
      if (url.endsWith("/torrents/add")) return server.add ? server.add(call) : reply("Ok.");
      if (url.includes("/torrents/info?hashes=")) return reply(server.direct?.(new URL(url).searchParams.get("hashes")!) ?? []);
      if (url.includes("/torrents/info?tag=")) return reply(server.tagged?.(new URL(url).searchParams.get("tag")!) ?? []);
      if (url.endsWith("/torrents/info")) return typeof server.list === "number" ? reply("", { status: server.list }) : reply(server.list ?? []);
      if (/\/torrents\/(topPrio|bottomPrio|addTags|delete|removeTags|deleteTags)$/.test(url)) return reply("");
      throw new Error(`unmocked fetch call: ${url}`);
    });
  }
  const callTo = (calls: Call[], suffix: string) => calls.find((c) => c.url.endsWith(suffix))!;
  const addedBy = (answer: unknown) => reply(answer);

  describe("a release URL is uploaded as a file (Q3)", () => {
    it("fetches the .torrent itself and uploads it with the tag, the category, the start flags and the seed goal", async () => {
      const { calls } = qbittorrent({ add: () => addedBy({ added_torrent_ids: [INFO_HASH.toUpperCase()], failed_torrent_ids: [], pending_count: 0 }) });

      const result = await adapter().addDownload(client(), RELEASE, "movies", "Release", "torrent", { seedGoal: { ratio: 1.5, minutes: 4320.4 } });

      expect(result.downloadId).toBe(INFO_HASH);
      // The indexer was asked first, by hand (a redirect to a magnet link has to be read, not followed).
      expect(calls[0].url).toBe(RELEASE);
      expect(calls[0].init.redirect).toBe("manual");
      const add = callTo(calls, "/api/v2/torrents/add");
      expect(add.init.method).toBe("POST");
      const form = add.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const file = form.get("torrents") as File;
      expect(file).toBeInstanceOf(Blob);
      expect(file.name).toBe("release.torrent");
      expect(Buffer.from(await file.arrayBuffer()).equals(TORRENT)).toBe(true);
      expect(form.get("tags")).toBe("aonarr");
      expect(form.get("category")).toBe("movies");
      expect(form.get("paused")).toBe("false");
      expect(form.get("stopped")).toBe("false");
      expect(form.get("ratioLimit")).toBe("1.5");
      expect(form.get("seedingTimeLimit")).toBe("4320");
      expect(form.has("urls")).toBe(false);
      // The multipart boundary is fetch's to set: a fixed Content-Type would break the upload. The session cookie goes with it.
      expect(add.init.headers["Content-Type"]).toBeUndefined();
      expect(add.init.headers.Cookie).toBe("SID=abc");
      // No pending tag to look for afterwards.
      expect(calls.some((c) => c.url.includes("/torrents/info"))).toBe(false);
    });

    it("sends no category or limits when there are none", async () => {
      const { calls } = qbittorrent({ add: () => addedBy({ added_torrent_ids: [INFO_HASH] }) });

      await adapter().addDownload(client(), RELEASE, null);

      const form = callTo(calls, "/api/v2/torrents/add").body as FormData;
      expect(form.has("category")).toBe(false);
      expect(form.has("ratioLimit")).toBe(false);
      expect(form.has("seedingTimeLimit")).toBe(false);
      expect(form.get("tags")).toBe("aonarr");
    });

    it("returns the id qBittorrent names, lower-cased, even when it is not the SHA-1 (a hybrid torrent's truncated v2 hash)", async () => {
      qbittorrent({ add: () => addedBy({ added_torrent_ids: [V2_TRUNCATED.toUpperCase()] }) });

      expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(V2_TRUNCATED);
    });

    it("returns the SHA-1 info hash it computed when the answer is an old-style 'Ok.'", async () => {
      qbittorrent({ add: () => reply("Ok.") });

      expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(INFO_HASH);
    });

    it("returns the computed hash when the answer names no torrent", async () => {
      qbittorrent({ add: () => addedBy({ added_torrent_ids: [], failed_torrent_ids: [], pending_count: 1 }) });

      expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(INFO_HASH);
    });

    it("tracks a torrent qBittorrent already holds (HTTP 409) under the id it keys it by", async () => {
      const { calls } = qbittorrent({ add: () => reply("Conflict", { status: 409 }), direct: (hash) => (hash === INFO_HASH ? [{ hash: INFO_HASH }] : []) });

      expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(INFO_HASH);
      expect(calls.some((c) => c.url.includes(`/torrents/info?hashes=${INFO_HASH}`))).toBe(true);
    });

    it("tracks a duplicate hybrid torrent under its truncated v2 id, found through infohash_v1", async () => {
      qbittorrent({ add: () => reply("Conflict", { status: 409 }), direct: () => [], list: [{ hash: V2_TRUNCATED, infohash_v1: INFO_HASH }] });

      expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(V2_TRUNCATED);
    });

    it("says qBittorrent refused the torrent when it answers 409 and does not hold it", async () => {
      qbittorrent({ add: () => reply("Conflict", { status: 409 }), direct: () => [], list: [] });

      await expect(adapter().addDownload(client(), RELEASE, null)).rejects.toThrow(/qBittorrent refused the torrent/);
    });

    it("says the file is not a valid torrent when qBittorrent answers 415", async () => {
      // Bencode (it starts with "d", so it gets as far as the upload) that is no torrent: qBittorrent has the last word.
      const { calls } = qbittorrent({ release: () => bytesReply(bdict([["announce", bstr("http://tracker.example/announce")]])), add: () => reply("", { status: 415 }) });

      await expect(adapter().addDownload(client(), RELEASE, null)).rejects.toThrow(/not a valid torrent/);
      expect(calls.some((c) => c.url.endsWith("/torrents/add"))).toBe(true);
    });

    describe("a body that is not a torrent is refused before the upload (Round 30b, M3)", () => {
      const NOT_A_TORRENT = "Failed to fetch release: the indexer's answer to the torrent download is not a torrent file";
      const TOO_LARGE = "Failed to fetch release: the indexer's answer is too large to be a torrent file";

      it.each([
        ["an HTML rate-limit page", Buffer.from("<html><body>Rate limit reached</body></html>")],
        ["an XML error document", Buffer.from('<?xml version="1.0"?><error code="429" description="Request limit reached"/>')],
        ["a JSON error", Buffer.from('{"error":"rate limited"}')],
        ["an empty body", Buffer.alloc(0)],
        ["an NZB", Buffer.from(NZB)],
      ])("refuses %s, and neither the login nor torrents/add is reached", async (_what, body) => {
        const { calls } = qbittorrent({ release: () => bytesReply(body) });

        const err = await failure(adapter().addDownload(client(), RELEASE, "movies"));

        expect(err.message).toBe(NOT_A_TORRENT);
        expect(calls.map((c) => c.url)).toEqual([RELEASE]);
      });

      it("refuses a body over 16 MiB, though it starts with a 'd', and never sends it on", async () => {
        const huge = Buffer.alloc(16 * 1024 * 1024 + 1);
        huge[0] = 0x64;
        const { calls } = qbittorrent({ release: () => bytesReply(huge) });

        const err = await failure(adapter().addDownload(client(), RELEASE, null));

        expect(err.message).toBe(TOO_LARGE);
        expect(calls.map((c) => c.url)).toEqual([RELEASE]);
      });

      it("judges the size before the first character: a huge page that is not bencode is too large, not 'not a torrent'", async () => {
        const hugePage = Buffer.alloc(16 * 1024 * 1024 + 1, 0x3c);
        qbittorrent({ release: () => bytesReply(hugePage) });

        expect((await failure(adapter().addDownload(client(), RELEASE, null))).message).toBe(TOO_LARGE);
      });

      it("lets a body of exactly 16 MiB that starts with a 'd' through to the upload", async () => {
        const limit = Buffer.alloc(16 * 1024 * 1024);
        limit[0] = 0x64;
        const { calls } = qbittorrent({ release: () => bytesReply(limit), add: () => reply("", { status: 415 }) });

        await expect(adapter().addDownload(client(), RELEASE, null)).rejects.toThrow(/not a valid torrent/);
        expect(calls.some((c) => c.url.endsWith("/torrents/add"))).toBe(true);
      });

      it("treats both refusals as the release's, not the client being down", async () => {
        const { calls } = qbittorrent({ release: () => bytesReply(Buffer.from("<html>Please log in</html>")) });

        const err = await grabTo(client(), RELEASE);

        expect(err).toBeInstanceOf(scheduler.ReleaseRefusedError);
        expect(err.message).toBe(NOT_A_TORRENT);
        expect(calls.map((c) => c.url)).toEqual([RELEASE]);

        const huge = Buffer.alloc(16 * 1024 * 1024 + 1);
        huge[0] = 0x64;
        qbittorrent({ release: () => bytesReply(huge) });
        const tooLarge = await grabTo(client(), RELEASE);
        expect(tooLarge).toBeInstanceOf(scheduler.ReleaseRefusedError);
        expect(tooLarge.message).toBe(TOO_LARGE);
      });

      it("does not apply to a magnet link, or to a release URL that redirects to one", async () => {
        const magnet = `magnet:?xt=urn:btih:${HASH}&dn=x`;
        const { calls } = qbittorrent({ release: () => reply("", { status: 302, headers: { location: magnet } }) });

        expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(HASH);
        expect((await adapter().addDownload(client(), magnet, null)).downloadId).toBe(HASH);
        expect(calls.filter((c) => c.url.endsWith("/torrents/add"))).toHaveLength(2);
      });
    });

    describe("a torrent whose hash cannot be computed is found again through a tag (Round 30b, L1)", () => {
      const V2_ONLY = bdict([
        ["announce", bstr("http://tracker.example/announce")],
        [
          "info",
          bdict([
            ["file tree", bdict([["a.txt", bdict([["", bdict([["length", bint(5)]])]])]])],
            ["meta version", bint(2)],
            ["name", bstr("a")],
            ["piece length", bint(16384)],
          ]),
        ],
      ]);
      const HYBRID_INFO = bdict([
        ["file tree", bdict([["a.txt", bdict([["", bdict([["length", bint(5)]])]])]])],
        ["length", bint(5)],
        ["meta version", bint(2)],
        ["name", bstr("a")],
        ["piece length", bint(16384)],
        ["pieces", bstr(PIECES)],
      ]);

      it("uploads a v2-only torrent with a pending tag, and takes the id of the torrent that carries it", async () => {
        vi.useFakeTimers();
        const { calls } = qbittorrent({
          release: () => bytesReply(V2_ONLY),
          add: () => reply("Ok."),
          tagged: (tag) => [{ hash: "9".repeat(40), tags: "" }, { hash: V2_TRUNCATED, tags: `aonarr, ${tag}` }],
        });

        const pending = adapter().addDownload(client(), RELEASE, "tv");
        await vi.advanceTimersByTimeAsync(1000);
        const result = await pending;

        expect(result.downloadId).toBe(V2_TRUNCATED);
        const form = callTo(calls, "/torrents/add").body as FormData;
        expect(form.get("torrents")).toBeInstanceOf(Blob);
        const [permanent, pendingTag] = String(form.get("tags")).split(",");
        expect(permanent).toBe("aonarr");
        expect(pendingTag).toMatch(/^aonarr-pending-[0-9a-f]+$/);
        const removeTags = callTo(calls, "/torrents/removeTags").body as URLSearchParams;
        expect(removeTags.get("hashes")).toBe(V2_TRUNCATED);
        expect(removeTags.get("tags")).toBe(pendingTag);
        expect((callTo(calls, "/torrents/deleteTags").body as URLSearchParams).get("tags")).toBe(pendingTag);
      });

      it("keeps a tag: placeholder id, never 'tag:null', when the torrent does not show up", async () => {
        vi.useFakeTimers();
        const { calls } = qbittorrent({ release: () => bytesReply(V2_ONLY), add: () => reply("Ok."), tagged: () => [] });

        const pending = adapter().addDownload(client(), RELEASE, null);
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await pending;

        const pendingTag = String((callTo(calls, "/torrents/add").body as FormData).get("tags")).split(",")[1];
        expect(result.downloadId).toBe(`tag:${pendingTag}`);
        expect(result.downloadId).toMatch(/^tag:aonarr-pending-[0-9a-f]+$/);
      });

      it("does the same for bencode with no info dictionary at all that qBittorrent accepted anyway", async () => {
        vi.useFakeTimers();
        qbittorrent({ release: () => bytesReply(bdict([["announce", bstr("http://tracker.example/announce")]])), add: () => reply("Ok."), tagged: () => [] });

        const pending = adapter().addDownload(client(), RELEASE, null);
        await vi.advanceTimersByTimeAsync(10_000);

        expect((await pending).downloadId).toMatch(/^tag:aonarr-pending-[0-9a-f]+$/);
      });

      it("uploads a hybrid torrent with no pending tag, under its SHA-1 info hash", async () => {
        const hybrid = bdict([
          ["announce", bstr("http://tracker.example/announce")],
          ["info", HYBRID_INFO],
        ]);
        const { calls } = qbittorrent({ release: () => bytesReply(hybrid), add: () => reply("Ok.") });

        const result = await adapter().addDownload(client(), RELEASE, null);

        expect(result.downloadId).toBe(sha1(HYBRID_INFO));
        expect((callTo(calls, "/torrents/add").body as FormData).get("tags")).toBe("aonarr");
        expect(calls.some((c) => c.url.includes("/torrents/info"))).toBe(false);
      });
    });

    it("tracks a torrent an older build answered 'Fails.' to when it holds it, and refuses one it does not", async () => {
      qbittorrent({ add: () => reply("Fails."), direct: (hash) => (hash === INFO_HASH ? [{ hash: INFO_HASH }] : []) });
      expect((await adapter().addDownload(client(), RELEASE, null)).downloadId).toBe(INFO_HASH);

      qbittorrent({ add: () => reply("Fails."), direct: () => [], list: [] });
      await expect(adapter().addDownload(client(), RELEASE, null)).rejects.toThrow(/did not add the torrent/);
    });

    it("reports another HTTP status of the add as the client's", async () => {
      qbittorrent({ add: () => reply("", { status: 500 }) });

      await expect(adapter().addDownload(client(), RELEASE, null)).rejects.toThrow("qBittorrent add failed: HTTP 500");
    });

    it("adds a release URL that redirects to a magnet link as a magnet", async () => {
      const magnet = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Some.Release`;
      const { calls } = qbittorrent({ release: () => reply("", { status: 302, headers: { location: magnet } }), add: () => reply("Ok.") });

      const result = await adapter().addDownload(client(), RELEASE, "tv");

      expect(result.downloadId).toBe(HASH);
      const form = callTo(calls, "/api/v2/torrents/add").body as URLSearchParams;
      expect(form).toBeInstanceOf(URLSearchParams);
      expect(form.get("urls")).toBe(magnet);
      expect(form.get("category")).toBe("tv");
      expect(form.get("paused")).toBe("false");
      expect(form.get("stopped")).toBe("false");
      expect(form.get("tags")).toBe("aonarr");
    });

    it("sends a magnet link with a v1 hash through urls and returns that hash, tracking a duplicate (409) of it", async () => {
      const magnet = `magnet:?xt=urn:btih:${HASH}&dn=x`;
      const { calls } = qbittorrent({ add: () => reply("Ok.") });
      expect((await adapter().addDownload(client(), magnet, null)).downloadId).toBe(HASH);
      expect((callTo(calls, "/api/v2/torrents/add").body as URLSearchParams).get("urls")).toBe(magnet);
      expect(calls.some((c) => c.url === RELEASE)).toBe(false);

      qbittorrent({ add: () => reply("Conflict", { status: 409 }), direct: (hash) => (hash === HASH ? [{ hash: HASH }] : []) });
      expect((await adapter().addDownload(client(), magnet, null)).downloadId).toBe(HASH);
    });

    it("fails as the indexer's failure when the indexer does not answer, without calling qBittorrent", async () => {
      const { calls } = stubFetch(() => {
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:9696"), { code: "ECONNREFUSED" }) });
      });

      const err = await failure(adapter().addDownload(client(), RELEASE, null));

      expect(err.message).toMatch(/^Failed to resolve download URL: the indexer did not answer/);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(RELEASE);
    });

    it("fails with the indexer's HTTP status when it answers an error", async () => {
      const { calls } = qbittorrent({ release: () => reply("", { status: 503 }) });

      await expect(adapter().addDownload(client(), RELEASE, null)).rejects.toThrow("Failed to resolve download URL: HTTP 503");
      expect(calls.some((c) => c.url.includes("/api/v2/"))).toBe(false);
    });
  });

  describe("hybrid torrents are found by their v1 hash (Q2)", () => {
    const V1 = "a1".repeat(20);
    const HYBRID = { hash: V2_TRUNCATED, infohash_v1: V1 };
    const form = (calls: Call[], suffix: string) => callTo(calls, suffix).body as URLSearchParams;

    const actions: [string, (a: ReturnType<typeof adapter>, c: DownloadClient) => Promise<unknown>, string, (f: URLSearchParams) => void][] = [
      ["setPriority (top)", (a, c) => a.setPriority!(c, V1, "top"), "/torrents/topPrio", () => {}],
      ["setPriority (normal)", (a, c) => a.setPriority!(c, V1, "normal"), "/torrents/bottomPrio", () => {}],
      ["markImported", (a, c) => a.markImported!(c, V1), "/torrents/addTags", (f) => expect(f.get("tags")).toBe("aonarr-imported")],
      ["removeDownload (keep data)", (a, c) => a.removeDownload!(c, V1, false), "/torrents/delete", (f) => expect(f.get("deleteFiles")).toBe("false")],
      ["removeDownload (with data)", (a, c) => a.removeDownload!(c, V1, true), "/torrents/delete", (f) => expect(f.get("deleteFiles")).toBe("true")],
    ];

    it.each(actions)("%s names the torrent by its truncated v2 hash when qBittorrent does not know the v1 one", async (_name, run, endpoint, check) => {
      const { calls } = qbittorrent({ direct: () => [], list: [{ hash: "9".repeat(40) }, HYBRID] });

      await run(adapter(), client());

      const body = form(calls, endpoint);
      expect(body.get("hashes")).toBe(V2_TRUNCATED);
      check(body);
      // The direct lookup came first, then the whole list.
      const lookups = calls.map((c) => c.url).filter((u) => u.includes("/torrents/info"));
      expect(lookups[0]).toContain(`/torrents/info?hashes=${V1}`);
      expect(lookups[1]).toMatch(/\/torrents\/info$/);
    });

    it("matches infohash_v1 whatever its case", async () => {
      const { calls } = qbittorrent({ direct: () => [], list: [{ hash: V2_TRUNCATED, infohash_v1: V1.toUpperCase() }] });

      await adapter().setPriority!(client(), V1, "top");

      expect(form(calls, "/torrents/topPrio").get("hashes")).toBe(V2_TRUNCATED);
    });

    it.each(actions)("%s makes no list request when the direct lookup finds the torrent", async (_name, run, endpoint) => {
      const { calls } = qbittorrent({ direct: () => [{ hash: V1 }] });

      await run(adapter(), client());

      expect(form(calls, endpoint).get("hashes")).toBe(V1);
      expect(calls.filter((c) => c.url.endsWith("/torrents/info"))).toHaveLength(0);
      expect(calls.filter((c) => c.url.includes("/torrents/info?hashes="))).toHaveLength(1);
    });

    it("uses the id unchanged when nothing matches, or when the list cannot be read", async () => {
      let served = qbittorrent({ direct: () => [], list: [{ hash: "c3".repeat(20), infohash_v1: "d4".repeat(20) }, { hash: "e5".repeat(20) }] });
      await adapter().removeDownload!(client(), V1, false);
      expect(form(served.calls, "/torrents/delete").get("hashes")).toBe(V1);

      served = qbittorrent({ direct: () => [], list: 500 });
      await adapter().removeDownload!(client(), V1, false);
      expect(form(served.calls, "/torrents/delete").get("hashes")).toBe(V1);
    });

    it("does not look up an id that is not a 40-character hash", async () => {
      const long = "f".repeat(64);
      const { calls } = qbittorrent();

      await adapter().removeDownload!(client(), long, false);

      expect(form(calls, "/torrents/delete").get("hashes")).toBe(long);
      expect(calls.some((c) => c.url.includes("/torrents/info"))).toBe(false);
    });
  });

  describe("the full listing is kept for five seconds per client (Round 30b, L2)", () => {
    const V1_A = "a1".repeat(20);
    const V1_B = "b2".repeat(20);
    const V2_A = "c3".repeat(20);
    const V2_B = "d4".repeat(20);
    const library = [
      { hash: V2_A, infohash_v1: V1_A },
      { hash: V2_B, infohash_v1: V1_B },
    ];
    const listings = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/torrents/info")).length;
    const hashesOf = (calls: Call[], suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).map((c) => (c.body as URLSearchParams).get("hashes"));

    it("lists the torrents once for the lookups within five seconds, and again after that", async () => {
      vi.useFakeTimers();
      const { calls } = qbittorrent({ direct: () => [], list: library });
      const target = client();

      await adapter().setPriority!(target, V1_A, "top");
      expect(listings(calls)).toBe(1);

      // The same hash again, and another hash from the same listing, a moment later: answered from what was listed.
      await adapter().markImported!(target, V1_A);
      vi.advanceTimersByTime(2_000);
      await adapter().removeDownload!(target, V1_B, false);
      vi.advanceTimersByTime(2_000);
      await adapter().setPriority!(target, V1_B, "normal");
      expect(listings(calls)).toBe(1);
      expect(hashesOf(calls, "/torrents/topPrio")).toEqual([V2_A]);
      expect(hashesOf(calls, "/torrents/addTags")).toEqual([V2_A]);
      expect(hashesOf(calls, "/torrents/delete")).toEqual([V2_B]);
      expect(hashesOf(calls, "/torrents/bottomPrio")).toEqual([V2_B]);
      // The direct lookup is not cached: it is the cheap one, and it is the one that sees a torrent just added.
      expect(calls.filter((c) => c.url.includes("/torrents/info?hashes=")).length).toBe(4);

      // More than five seconds after the listing (5.5 s in all): a new one.
      vi.advanceTimersByTime(1_500);
      await adapter().setPriority!(target, V1_A, "top");
      expect(listings(calls)).toBe(2);
      expect(hashesOf(calls, "/torrents/topPrio")).toEqual([V2_A, V2_A]);

      // And that one is kept in turn.
      await adapter().setPriority!(target, V1_B, "top");
      expect(listings(calls)).toBe(2);
    });

    it("is still fresh just inside five seconds and stale at five", async () => {
      vi.useFakeTimers();
      const { calls } = qbittorrent({ direct: () => [], list: library });
      const target = client();

      await adapter().setPriority!(target, V1_A, "top");
      vi.advanceTimersByTime(4_999);
      await adapter().setPriority!(target, V1_A, "top");
      expect(listings(calls)).toBe(1);

      vi.advanceTimersByTime(1);
      await adapter().setPriority!(target, V1_A, "top");
      expect(listings(calls)).toBe(2);
    });

    it("keeps a listing for each client", async () => {
      vi.useFakeTimers();
      const { calls } = qbittorrent({ direct: () => [], list: library });

      await adapter().setPriority!(client(), V1_A, "top");
      await adapter().setPriority!(client(), V1_A, "top");

      expect(listings(calls)).toBe(2);
    });

    it("does not keep a listing that could not be read", async () => {
      vi.useFakeTimers();
      const { calls } = qbittorrent({ direct: () => [], list: 500 });
      const target = client();

      await adapter().setPriority!(target, V1_A, "top");
      await adapter().setPriority!(target, V1_A, "top");

      expect(listings(calls)).toBe(2);
      // The id was used unchanged both times.
      expect(hashesOf(calls, "/torrents/topPrio")).toEqual([V1_A, V1_A]);
    });
  });

  describe("torrents the queue still tracks are not removed (Round 30b, M2)", () => {
    const [A, B, C, D] = ["a", "b", "c", "d"].map((c) => c.repeat(40));
    const seeded = (over: Record<string, unknown>) => ({ hash: C, state: "stalledUP", ratio: 3, seeding_time: 0, tags: "aonarr,aonarr-imported", category: "", ...over });
    const deletes = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/torrents/delete")).map((c) => (c.body as URLSearchParams).get("hashes"));

    it("leaves a torrent whose hash, or v1 hash, is in the skip set, whatever the case, and removes the others", async () => {
      const { calls } = qbittorrent({
        list: [
          seeded({ hash: A }),
          seeded({ hash: B.toUpperCase() }), // the listing's own case does not matter
          seeded({ hash: V2_TRUNCATED, infohash_v1: D.toUpperCase() }), // a hybrid torrent is held under its v1 hash
          seeded({ hash: C }),
        ],
      });

      const removed = await adapter().removeSeededTorrents!(client(), 1, null, new Set([A, B, D]));

      expect(removed).toBe(1);
      expect(deletes(calls)).toEqual([C]);
    });

    it("removes nothing, and sends no delete, when every eligible torrent is tracked", async () => {
      const { calls } = qbittorrent({ list: [seeded({ hash: A }), seeded({ hash: B })] });

      expect(await adapter().removeSeededTorrents!(client(), 1, null, new Set([A, B]))).toBe(0);
      expect(deletes(calls)).toEqual([]);
    });

    it("removes all of them without a skip set, or with an empty one", async () => {
      const list = [seeded({ hash: A }), seeded({ hash: B })];
      let served = qbittorrent({ list });
      expect(await adapter().removeSeededTorrents!(client(), 1, null)).toBe(2);
      expect(deletes(served.calls)).toEqual([`${A}|${B}`]);

      served = qbittorrent({ list });
      expect(await adapter().removeSeededTorrents!(client(), 1, null, new Set())).toBe(2);
    });

    it("removes a torrent that has no v1 hash field when the skip set holds only other hashes", async () => {
      // Its missing infohash_v1 must not be taken for a skipped hash.
      const { calls } = qbittorrent({ list: [seeded({ hash: C })] });

      expect(await adapter().removeSeededTorrents!(client(), 1, null, new Set([A]))).toBe(1);
      expect(deletes(calls)).toEqual([C]);
    });
  });

  describe("a torrent without metadata (Q4)", () => {
    const torrent = (over: Record<string, unknown>) => ({
      hash: "h".repeat(40),
      name: "Some.Release",
      tags: "aonarr",
      progress: 0,
      state: "downloading",
      size: 1000,
      amount_left: 600,
      eta: 120,
      content_path: "/downloads/Some.Release",
      save_path: "/downloads",
      ...over,
    });
    async function statusOf(over: Record<string, unknown>) {
      qbittorrent({ list: [torrent(over)] });
      const [update] = await adapter().getStatus(client(), []);
      return update;
    }

    it.each(["metaDL", "forcedMetaDL"])("reports no remotePath, size left or estimate for a %s torrent whose content_path is empty", async (state) => {
      const update = await statusOf({ state, content_path: "", size: 0, amount_left: 999, eta: 100 });

      expect(update.status).toBe("downloading");
      expect(update.remotePath).toBeUndefined();
      expect(update.sizeLeft).toBeUndefined();
      expect(update.etaSeconds).toBeUndefined();
      expect(update.stalled).toBe(true);
    });

    it("still reports content_path, size left and estimate for a normal download", async () => {
      const update = await statusOf({ state: "downloading", progress: 0.4 });

      expect(update).toMatchObject({ status: "downloading", remotePath: "/downloads/Some.Release", sizeLeft: 600, etaSeconds: 120 });
    });

    it("falls back to save_path for a torrent without content_path, unless it has no metadata", async () => {
      expect((await statusOf({ state: "downloading", content_path: "" })).remotePath).toBe("/downloads");

      const finished = await statusOf({ state: "stalledUP", progress: 1, content_path: "", amount_left: 0 });
      expect(finished.status).toBe("completed");
      expect(finished.remotePath).toBe("/downloads");
    });
  });
});

// ---------------------------------------------------------------------------
// Transmission (T1)
// ---------------------------------------------------------------------------

describe("Transmission against the real client (T1)", () => {
  const tr = () => client({ type: "transmission", host: "tr.local", port: 9091, username: "u", password: "p" });
  const row = (over: Record<string, unknown> = {}) => ({
    hashString: "a".repeat(40),
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

  /** Transmission answers 409 with a session id until the id is sent back; only the answered requests are recorded. */
  function transmission(torrents: unknown[]) {
    const answered: { method: string; args: any }[] = [];
    const fn = vi.fn(async (_url: string, init: any = {}) => {
      if (!init.headers["X-Transmission-Session-Id"]) return reply({}, { status: 409, headers: { "x-transmission-session-id": "SESSION-1" } });
      const body = JSON.parse(String(init.body));
      answered.push({ method: body.method, args: body.arguments });
      return reply({ result: "success", arguments: body.method === "torrent-get" ? { torrents } : {} });
    });
    vi.stubGlobal("fetch", fn);
    return answered;
  }
  const A = "a".repeat(40);

  it("reports no remotePath while the metadata is still coming in", async () => {
    transmission([row({ metadataPercentComplete: 0.4, name: "magnet-dn" }), row({ hashString: "b".repeat(40), metadataPercentComplete: 0 })]);

    const updates = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), [A, "b".repeat(40)]);

    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.status).toBe("downloading");
      expect(update.remotePath).toBeUndefined();
    }
    // The name Transmission shows for it is still passed on.
    expect(updates[0].clientTitle).toBe("magnet-dn");
  });

  it("reports the path once the metadata is complete, or when the field is absent", async () => {
    transmission([row({ metadataPercentComplete: 1 }), row({ hashString: "b".repeat(40) })]);

    const updates = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), [A, "b".repeat(40)]);

    expect(updates.map((u) => u.remotePath)).toEqual(["/downloads/Release", "/downloads/Release"]);
  });

  it("reports the path of a finished torrent", async () => {
    transmission([row({ status: 6, percentDone: 1, leftUntilDone: 0, eta: -1, metadataPercentComplete: 1 })]);

    const [update] = await dc.getDownloadClientAdapter("transmission").getStatus(tr(), [A]);

    expect(update).toMatchObject({ status: "completed", remotePath: "/downloads/Release" });
  });

  it("asks for metadataPercentComplete in torrent-get", async () => {
    const answered = transmission([row()]);

    await dc.getDownloadClientAdapter("transmission").getStatus(tr(), [A]);

    const get = answered.find((c) => c.method === "torrent-get")!;
    expect(get.args.fields).toContain("metadataPercentComplete");
    expect(get.args.ids).toEqual([A]);
  });

  describe("torrents the queue still tracks are not removed (Round 30b, M2)", () => {
    const [X, Y, Z] = ["1", "2", "3"].map((c) => c.repeat(40));
    const seeded = (hashString: string, over: Record<string, unknown> = {}) => ({ hashString, status: 6, uploadRatio: 3, secondsSeeding: 0, labels: ["aonarr", "aonarr-imported"], ...over });
    const removals = (answered: { method: string; args: any }[]) => answered.filter((c) => c.method === "torrent-remove").map((c) => c.args.ids[0]);

    it("leaves the torrents whose hash is in the skip set (whatever Transmission's case) and removes the others", async () => {
      const answered = transmission([seeded(X.toUpperCase()), seeded(Y), seeded(Z)]);

      const removed = await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null, new Set([X, Z]));

      expect(removed).toBe(1);
      expect(removals(answered)).toEqual([Y]);
    });

    it("removes nothing when every eligible torrent is tracked", async () => {
      const answered = transmission([seeded(X), seeded(Y)]);

      expect(await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null, new Set([X, Y]))).toBe(0);
      expect(removals(answered)).toEqual([]);
    });

    it("removes them all without a skip set, or with an empty one", async () => {
      let answered = transmission([seeded(X), seeded(Y)]);
      expect(await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null)).toBe(2);
      expect(removals(answered)).toEqual([X, Y]);

      answered = transmission([seeded(X), seeded(Y)]);
      expect(await dc.getDownloadClientAdapter("transmission").removeSeededTorrents!(tr(), 1, null, new Set())).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Deluge (D1-D3 and the seed goal)
// ---------------------------------------------------------------------------

describe("Deluge against the real client (D1-D3)", () => {
  const dl = (over: Partial<DownloadClient> = {}) => client({ type: "deluge", host: "de.local", port: 8112, username: null, password: "deluge", category: "movies", ...over });
  const adapter = () => dc.getDownloadClientAdapter("deluge");
  const HASH = "d".repeat(40);
  const RELEASE = "https://idx.example.com/dl.torrent";

  interface DelugeState {
    /** Whether the web UI is connected to its daemon. */
    connected: boolean;
    /** Methods whose next N calls get no answer before the abort signal fires. */
    timeouts?: Record<string, number>;
    /** The name of the error a call that gets no answer fails with. */
    timeoutName?: string;
  }
  interface Seen {
    method: string;
    params: any;
    /** The timeout the call's abort signal was made with (AbortSignal.timeout), in ms. */
    timeoutMs: number | undefined;
    signal: AbortSignal | undefined;
  }

  /** A deluge-web that logs in, reports `state.connected`, connects when asked, and answers the rest from `answers`. */
  function deluge(answers: Record<string, unknown | ((params: any) => unknown)> = {}, state: DelugeState = { connected: true }) {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const seen: Seen[] = [];
    stubFetch((call) => {
      if (!call.url.endsWith("/json")) return bytesReply(TORRENT);
      const method = call.method!;
      // AbortSignal.timeout is called just before fetch, by whoever made the signal: apiFetch (30 s) or the Deluge core call (10 s).
      seen.push({ method, params: call.params, timeoutMs: timeoutSpy.mock.calls.at(-1)?.[0] as number | undefined, signal: call.init.signal });
      if (state.timeouts && state.timeouts[method] > 0) {
        state.timeouts[method]--;
        throw new DOMException("The operation was aborted due to timeout", state.timeoutName ?? "TimeoutError");
      }
      if (method === "auth.login") return reply({ result: true, error: null }, { headers: { "set-cookie": "_session_id=abc123; Path=/" } });
      if (method === "web.connected") return reply({ result: state.connected, error: null });
      if (method === "web.get_hosts") return reply({ result: [["hostid", "127.0.0.1", 58846, "localhost"]], error: null });
      if (method === "web.connect") {
        state.connected = true;
        return reply({ result: null, error: null });
      }
      const answer = answers[method];
      if (answer instanceof Error) return reply({ result: null, error: { code: 4, message: answer.message } });
      return reply({ result: typeof answer === "function" ? (answer as (p: any) => unknown)(call.params) : answer, error: null });
    });
    return { seen, state, methods: () => seen.map((s) => s.method) };
  }

  /** A client that has logged in already, as one polled for a while has. */
  async function loggedIn(server: ReturnType<typeof deluge>, target = dl()) {
    await adapter().getStatus(target, []);
    server.seen.length = 0;
    return target;
  }

  const t = (over: Record<string, unknown> = {}) => ({ name: "Release", state: "Downloading", progress: 50, total_size: 1000, total_done: 500, eta: 30, save_path: "/downloads", message: "OK", download_payload_rate: 100, ...over });

  describe("a web UI that lost its daemon (D1)", () => {
    it("connects again and repeats the core call once when it gets no answer and the web UI is not connected", async () => {
      const server = deluge({ "core.get_torrents_status": { [HASH]: t() } }, { connected: true, timeouts: {} });
      const target = await loggedIn(server);
      // deluged restarts behind a web UI that is still logged in: every core call now gets no answer.
      server.state.connected = false;
      server.state.timeouts!["core.get_torrents_status"] = 1;

      const updates = await adapter().getStatus(target, [HASH]);

      expect(server.methods()).toEqual(["core.get_torrents_status", "web.connected", "auth.login", "web.connected", "web.get_hosts", "web.connect", "core.get_torrents_status"]);
      expect(server.seen[5].params).toEqual(["hostid"]);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ downloadId: HASH, status: "downloading", progress: 0.5, sizeLeft: 500 });
      expect(server.state.connected).toBe(true);
    });

    it("also does so when the call is aborted rather than timed out", async () => {
      const server = deluge({ "core.get_torrents_status": { [HASH]: t() } }, { connected: true, timeouts: {}, timeoutName: "AbortError" });
      const target = await loggedIn(server);
      server.state.connected = false;
      server.state.timeouts!["core.get_torrents_status"] = 1;

      const updates = await adapter().getStatus(target, [HASH]);

      expect(server.methods().filter((m) => m === "web.connect")).toHaveLength(1);
      expect(updates).toHaveLength(1);
    });

    it("throws the original timeout when the web UI says it is connected", async () => {
      const server = deluge({ "core.get_torrents_status": { [HASH]: t() } }, { connected: true, timeouts: {} });
      const target = await loggedIn(server);
      server.state.timeouts!["core.get_torrents_status"] = 1;

      const err = await failure(adapter().getStatus(target, [HASH]));

      expect(err.name).toBe("TimeoutError");
      expect(server.methods()).toEqual(["core.get_torrents_status", "web.connected"]);
    });

    it("throws a second timeout after the retry, and does not loop", async () => {
      const server = deluge({ "core.get_torrents_status": { [HASH]: t() } }, { connected: true, timeouts: {} });
      const target = await loggedIn(server);
      server.state.connected = false;
      server.state.timeouts!["core.get_torrents_status"] = 5;

      const err = await failure(adapter().getStatus(target, [HASH]));

      expect(err.name).toBe("TimeoutError");
      expect(server.methods()).toEqual(["core.get_torrents_status", "web.connected", "auth.login", "web.connected", "web.get_hosts", "web.connect", "core.get_torrents_status"]);
    });

    it("never retries a call that is not a core call", async () => {
      const server = deluge({}, { connected: true, timeouts: {} });
      const target = await loggedIn(server);
      server.state.connected = false;
      server.state.timeouts!["web.connected"] = 1;

      const err = await failure(adapter().getStatus(target, []));

      expect(err.name).toBe("TimeoutError");
      expect(server.methods()).toEqual(["web.connected"]);

      // Nor a login.
      const fresh = deluge({}, { connected: false, timeouts: { "auth.login": 1 } });
      const loginErr = await failure(dc.testDownloadClientConnection(dl()));
      expect(loginErr.name).toBe("TimeoutError");
      expect(fresh.methods()).toEqual(["auth.login"]);
    });

    it("reconnects for a label call that gets no answer too", async () => {
      const server = deluge(
        { "core.add_torrent_magnet": HASH, "core.get_enabled_plugins": ["Label"], "label.get_labels": [], "label.add": null, "label.set_torrent": null },
        { connected: true, timeouts: {} }
      );
      const target = await loggedIn(server);
      server.state.connected = false;
      server.state.timeouts!["label.get_labels"] = 1;

      const result = await adapter().addDownload(target, `magnet:?xt=urn:btih:${HASH}`, "movies");

      expect(result.downloadId).toBe(HASH);
      expect(server.methods().filter((m) => m === "label.get_labels")).toHaveLength(2);
      expect(server.methods()).toContain("web.connect");
      expect(server.methods().at(-1)).toBe("label.set_torrent");
    });

    // Only the poll gives up after 10 s; an add, a label call or a listing of everything gets the client's default 30 s (Round 30b, M4).
    it("gives the poll (core.get_torrents_status with a filter) a 10 s ceiling, and the login and connection calls the client default", async () => {
      const server = deluge({ "core.get_torrents_status": { [HASH]: t() } }, { connected: false });

      await adapter().getStatus(dl(), [HASH]);

      const poll = server.seen.filter((s) => s.method === "core.get_torrents_status");
      expect(poll).toHaveLength(1);
      expect(poll[0].params[0]).toEqual({ id: [HASH] });
      expect(poll[0].signal).toBeInstanceOf(AbortSignal);
      expect(poll[0].timeoutMs).toBe(10_000);
      // auth.login, web.connected, web.get_hosts and web.connect came first, each with the default.
      const others = server.seen.filter((s) => s.method !== "core.get_torrents_status");
      expect(others.map((s) => s.method)).toEqual(["auth.login", "web.connected", "web.get_hosts", "web.connect"]);
      for (const s of others) {
        expect(s.signal).toBeInstanceOf(AbortSignal);
        expect(s.timeoutMs).toBe(30_000);
      }
    });

    it("gives an add, the label calls, the plugin list and a removal the default ceiling, not the poll's", async () => {
      const server = deluge(
        { "core.add_torrent_magnet": HASH, "core.add_torrent_file": HASH, "core.get_enabled_plugins": ["Label"], "label.get_labels": [], "label.add": null, "label.set_torrent": null, "core.remove_torrent": true },
        { connected: true }
      );
      const target = dl();

      await adapter().addDownload(target, `magnet:?xt=urn:btih:${HASH}`, "movies");
      await adapter().addDownload(target, RELEASE, "movies");
      await adapter().removeDownload!(target, HASH, true);

      const methods = server.methods();
      for (const expected of ["core.add_torrent_magnet", "core.add_torrent_file", "core.get_enabled_plugins", "label.get_labels", "label.add", "label.set_torrent", "core.remove_torrent"]) {
        expect(methods, expected).toContain(expected);
      }
      expect(server.seen.length).toBeGreaterThan(8);
      for (const s of server.seen) {
        expect(s.signal, s.method).toBeInstanceOf(AbortSignal);
        expect(s.timeoutMs, s.method).toBe(30_000);
      }
    });

    it("gives the listing of every torrent (an empty filter) the default ceiling too", async () => {
      const server = deluge({ "core.get_enabled_plugins": ["Label"], "core.get_torrents_status": {}, "core.remove_torrent": true }, { connected: true });

      await adapter().removeSeededTorrents!(dl({ category: "TV" }), 1, null);

      const listing = server.seen.find((s) => s.method === "core.get_torrents_status")!;
      expect(listing.params[0]).toEqual({});
      expect(listing.timeoutMs).toBe(30_000);
      for (const s of server.seen) expect(s.timeoutMs, s.method).toBe(30_000);
    });

    it("still reconnects and repeats a poll that hit its 10 s ceiling", async () => {
      const server = deluge({ "core.get_torrents_status": { [HASH]: t() } }, { connected: true, timeouts: {} });
      const target = await loggedIn(server);
      server.state.connected = false;
      server.state.timeouts!["core.get_torrents_status"] = 1;

      await adapter().getStatus(target, [HASH]);

      const polls = server.seen.filter((s) => s.method === "core.get_torrents_status");
      expect(polls).toHaveLength(2);
      expect(polls.map((s) => s.timeoutMs)).toEqual([10_000, 10_000]);
      expect(server.methods()).toContain("web.connect");
    });
  });

  describe("polling with no ids (D1)", () => {
    it("connects the web UI to its daemon when it is not connected, instead of reporting it reachable", async () => {
      const server = deluge({}, { connected: true });
      const target = await loggedIn(server);
      server.state.connected = false;

      const updates = await adapter().getStatus(target, []);

      expect(updates).toEqual([]);
      expect(server.methods()).toEqual(["web.connected", "auth.login", "web.connected", "web.get_hosts", "web.connect"]);
      expect(server.state.connected).toBe(true);
    });

    it("only asks whether it is connected when it is", async () => {
      const server = deluge({}, { connected: true });
      const target = await loggedIn(server);

      await adapter().getStatus(target, []);

      expect(server.methods()).toEqual(["web.connected"]);
    });
  });

  describe("a torrent file Deluge already holds (D2)", () => {
    const ALREADY = (hash: string) =>
      `Failure: [Failure instance: Traceback (failure with no frames): <class 'deluge.error.AddTorrentError'>: Torrent already in session (${hash}).`;
    const HELD = "e8b8da625633b1fb2aeabb7782f30ae9abb13380";

    it("tracks the torrent the error names, for a .torrent file", async () => {
      deluge({ "core.add_torrent_file": new Error(ALREADY(HELD)) });

      expect((await adapter().addDownload(dl(), RELEASE, null)).downloadId).toBe(HELD);
    });

    it("cuts a 64-character hash to 40, and lower-cases it", async () => {
      const long = "A1B2C3D4E5F60718293A4B5C6D7E8F90".repeat(2).toUpperCase();
      deluge({ "core.add_torrent_file": new Error(ALREADY(long)) });

      expect((await adapter().addDownload(dl(), RELEASE, null)).downloadId).toBe(long.slice(0, 40).toLowerCase());
    });

    it("also copes when the traceback wrapper is closed on a new line", async () => {
      deluge({ "core.add_torrent_file": new Error(`${ALREADY(HELD)}\n]`) });

      expect((await adapter().addDownload(dl(), RELEASE, null)).downloadId).toBe(HELD);
    });

    it("tracks the torrent the error names for a magnet too", async () => {
      deluge({ "core.add_torrent_magnet": new Error(ALREADY(HELD)) });

      expect((await adapter().addDownload(dl(), `magnet:?xt=urn:btmh:1220${"a".repeat(64)}&dn=x`, null)).downloadId).toBe(HELD);
    });

    it("throws any other error with Deluge's traceback wrapper taken off", async () => {
      deluge({
        "core.add_torrent_file": new Error("Failure: [Failure instance: Traceback (failure with no frames): <class 'deluge.error.InvalidTorrentError'>: Not a valid torrent file.\n]"),
      });

      const err = await failure(adapter().addDownload(dl(), RELEASE, null));

      expect(err.message).toBe("Deluge core.add_torrent_file failed: Not a valid torrent file.");
      expect(err.message).not.toContain("Failure instance");
    });

    it("leaves an error without the wrapper as it was", async () => {
      deluge({ "core.add_torrent_file": new Error("Permission denied") });

      expect((await failure(adapter().addDownload(dl(), RELEASE, null))).message).toBe("Deluge core.add_torrent_file failed: Permission denied");
    });
  });

  describe("removing a torrent that is already gone (D3)", () => {
    const wrapped = (text: string) => `Failure: [Failure instance: Traceback (failure with no frames): <class 'deluge.error.InvalidTorrentError'>: ${text}\n]`;

    it("treats 'not in session' as done", async () => {
      const server = deluge({ "core.remove_torrent": new Error(wrapped(`torrent_id ${HASH} not in session`)) });

      await expect(adapter().removeDownload!(dl(), HASH, true)).resolves.toBeUndefined();
      expect(server.seen.find((s) => s.method === "core.remove_torrent")!.params).toEqual([HASH, true]);
    });

    it("throws any other error", async () => {
      deluge({ "core.remove_torrent": new Error(wrapped("Permission denied")) });

      await expect(adapter().removeDownload!(dl(), HASH, false)).rejects.toThrow("Deluge core.remove_torrent failed: Permission denied");
    });
  });

  describe("the seed goal at add", () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}`;
    // core.add_torrent_magnet(uri, options) and core.add_torrent_file(filename, base64, options)
    const optionsOf = (server: ReturnType<typeof deluge>, method = "core.add_torrent_magnet") => {
      const params = server.seen.find((s) => s.method === method)!.params;
      return params[params.length - 1];
    };

    it("sends the ratio as the torrent's own stop ratio, and does not remove it at that ratio", async () => {
      const server = deluge({ "core.add_torrent_magnet": HASH });

      await adapter().addDownload(dl(), magnet, null, "Release", "torrent", { seedGoal: { ratio: 1.5, minutes: 4320 } });

      expect(optionsOf(server)).toEqual({ add_paused: false, stop_at_ratio: true, stop_ratio: 1.5, remove_at_ratio: false });
    });

    it("sends the same options with a .torrent file", async () => {
      const server = deluge({ "core.add_torrent_file": HASH });

      await adapter().addDownload(dl(), RELEASE, null, "Release", "torrent", { seedGoal: { ratio: 2, minutes: null } });

      expect(optionsOf(server, "core.add_torrent_file")).toEqual({ add_paused: false, stop_at_ratio: true, stop_ratio: 2, remove_at_ratio: false });
    });

    it("sends only add_paused without a ratio: minutes alone are not sent", async () => {
      const server = deluge({ "core.add_torrent_magnet": HASH });

      await adapter().addDownload(dl(), magnet, null, "Release", "torrent", { seedGoal: { ratio: null, minutes: 4320 } });
      await adapter().addDownload(dl(), magnet, null, "Release", "torrent", { seedGoal: { ratio: 0, minutes: null } });
      await adapter().addDownload(dl(), magnet, null, "Release", "torrent", { seedGoal: null });
      await adapter().addDownload(dl(), magnet, null);

      const adds = server.seen.filter((s) => s.method === "core.add_torrent_magnet");
      expect(adds).toHaveLength(4);
      for (const add of adds) expect(add.params[1]).toStrictEqual({ add_paused: false });
    });
  });

  describe("cleaning up seeded torrents (removeSeededTorrents)", () => {
    const seeded = (over: Record<string, unknown>) => ({ label: "tv-shows", state: "Seeding", progress: 100, ratio: 0.1, seeding_time: 0, stop_at_ratio: false, stop_ratio: 2, ...over });
    const removals = (server: ReturnType<typeof deluge>) => server.seen.filter((s) => s.method === "core.remove_torrent");
    const library: Record<string, unknown> = {
      "met-ratio": seeded({ ratio: 2 }),
      "met-time": seeded({ seeding_time: 2 * 3600 }),
      // Deluge paused it at the ratio set on it at add: taken. One parked by hand (no stop_at_ratio) stays, whatever its ratio.
      "paused-at-goal": seeded({ state: "Paused", stop_at_ratio: true, stop_ratio: 2, ratio: 2.1 }),
      "paused-parked": seeded({ state: "Paused", ratio: 3 }),
      "paused-parked-no-field": seeded({ state: "Paused", ratio: 3, stop_at_ratio: undefined, stop_ratio: undefined }),
      "queued-done": seeded({ state: "Queued", ratio: 3 }),
      "own-goal-met": seeded({ stop_at_ratio: true, stop_ratio: 2.5, ratio: 2.6 }),
      // stop_ratio is only the torrent's goal while stop_at_ratio is on; otherwise the global goal applies.
      "own-goal-off": seeded({ stop_at_ratio: false, stop_ratio: 5, ratio: 2 }),
      "own-goal-not-met": seeded({ stop_at_ratio: true, stop_ratio: 3, ratio: 2 }),
      "below-goals": seeded({ ratio: 0.5, seeding_time: 60 }),
      downloading: seeded({ state: "Downloading", progress: 40, ratio: 9 }),
      "checking-done": seeded({ state: "Checking", ratio: 9 }),
      unlabeled: seeded({ label: "", ratio: 9 }),
      "other-label": seeded({ label: "anime", ratio: 9 }),
      "by-type-label": seeded({ label: "movies", ratio: 2 }),
    };
    const target = () => dl({ category: "TV Shows", categoryByType: { movie: "Movies" } });

    it("returns 0 and makes no status call when the Label plugin is not enabled", async () => {
      const server = deluge({ "core.get_enabled_plugins": ["Execute"], "core.get_torrents_status": library, "core.remove_torrent": true });

      expect(await adapter().removeSeededTorrents!(target(), 1, 60)).toBe(0);

      expect(server.methods()).toContain("core.get_enabled_plugins");
      expect(server.methods()).not.toContain("core.get_torrents_status");
      expect(server.methods()).not.toContain("core.remove_torrent");
    });

    it("returns 0 for a client with no category: nothing tells AoNarr's torrents from the user's", async () => {
      const server = deluge({ "core.get_enabled_plugins": ["Label"], "core.get_torrents_status": library, "core.remove_torrent": true });

      expect(await adapter().removeSeededTorrents!(dl({ category: null }), 1, 60)).toBe(0);

      expect(server.methods()).not.toContain("core.get_torrents_status");
    });

    it("removes the finished torrents of AoNarr's labels that met their goal, keeping their data, and touches no other", async () => {
      const server = deluge({ "core.get_enabled_plugins": ["Label"], "core.get_torrents_status": library, "core.remove_torrent": true });

      const removed = await adapter().removeSeededTorrents!(target(), 1, 60);

      const gone = removals(server).map((s) => s.params);
      expect(gone.map((p) => p[0]).sort()).toEqual(["by-type-label", "met-ratio", "met-time", "own-goal-met", "own-goal-off", "paused-at-goal", "queued-done"]);
      // The data stays: nothing says the library holds the same bytes.
      for (const params of gone) expect(params[1]).toBe(false);
      expect(removed).toBe(7);
      // It asks for the label, the state, the progress and the goals in one call, for every torrent.
      const ask = server.seen.find((s) => s.method === "core.get_torrents_status")!.params;
      expect(ask[0]).toEqual({});
      expect(ask[1]).toEqual(expect.arrayContaining(["state", "progress", "ratio", "seeding_time", "label", "stop_at_ratio", "stop_ratio"]));
    });

    // M2 (Round 30b)
    describe("a paused torrent is only taken when Deluge paused it at its goal", () => {
      it("leaves a torrent parked by hand, even when it is past every goal, and takes one stopped at its own ratio", async () => {
        const server = deluge({
          "core.get_enabled_plugins": ["Label"],
          "core.get_torrents_status": {
            parked: seeded({ state: "Paused", ratio: 9, seeding_time: 99 * 3600 }),
            "parked-ratio-set-off": seeded({ state: "Paused", ratio: 9, stop_at_ratio: false, stop_ratio: 1 }),
            "stopped-at-goal": seeded({ state: "Paused", ratio: 2.5, stop_at_ratio: true, stop_ratio: 2.5 }),
          },
          "core.remove_torrent": true,
        });

        expect(await adapter().removeSeededTorrents!(target(), 1, 60)).toBe(1);
        expect(removals(server).map((s) => s.params)).toEqual([["stopped-at-goal", false]]);
      });

      it("still takes a Seeding or Queued torrent that met its goal without stop_at_ratio", async () => {
        const server = deluge({
          "core.get_enabled_plugins": ["Label"],
          "core.get_torrents_status": { seeding: seeded({ ratio: 2 }), queued: seeded({ state: "Queued", ratio: 2 }) },
          "core.remove_torrent": true,
        });

        expect(await adapter().removeSeededTorrents!(target(), 1, null)).toBe(2);
        expect(removals(server).map((s) => s.params[0]).sort()).toEqual(["queued", "seeding"]);
      });
    });

    describe("downloads the queue still tracks are skipped (skipIds)", () => {
      it("never removes a torrent whose hash is in the skip set, however far past its goal, and removes the rest", async () => {
        const server = deluge({
          "core.get_enabled_plugins": ["Label"],
          "core.get_torrents_status": {
            ["a".repeat(40)]: seeded({ ratio: 9 }),
            ["b".repeat(40).toUpperCase()]: seeded({ state: "Queued", ratio: 9 }), // Deluge's own case is lowered before the lookup
            ["c".repeat(40)]: seeded({ state: "Paused", stop_at_ratio: true, stop_ratio: 1, ratio: 9 }),
            ["d".repeat(40)]: seeded({ ratio: 9 }),
          },
          "core.remove_torrent": true,
        });
        const skip = new Set(["a".repeat(40), "b".repeat(40), "c".repeat(40)]);

        const removed = await adapter().removeSeededTorrents!(target(), 1, null, skip);

        expect(removed).toBe(1);
        expect(removals(server).map((s) => s.params)).toEqual([["d".repeat(40), false]]);
      });

      it("removes everything that met its goal without a skip set, or with an empty one", async () => {
        const answers = { "core.get_enabled_plugins": ["Label"], "core.get_torrents_status": { one: seeded({ ratio: 2 }), two: seeded({ ratio: 2 }) }, "core.remove_torrent": true };
        deluge(answers);
        expect(await adapter().removeSeededTorrents!(target(), 1, null)).toBe(2);

        deluge(answers);
        expect(await adapter().removeSeededTorrents!(target(), 1, null, new Set())).toBe(2);
      });
    });

    describe("a removal that fails does not stop the rest", () => {
      it("counts only the torrents removed, goes on after the failure, and logs a warning", async () => {
        const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
        const server = deluge({
          "core.get_enabled_plugins": ["Label"],
          "core.get_torrents_status": { first: seeded({ ratio: 2 }), broken: seeded({ ratio: 2 }), last: seeded({ ratio: 2 }) },
          "core.remove_torrent": (params: any[]) => {
            if (params[0] === "broken") throw new Error("boom");
            return true;
          },
        });

        const removed = await adapter().removeSeededTorrents!(target(), 1, null);

        expect(removed).toBe(2);
        expect(removals(server).map((s) => s.params[0])).toEqual(["first", "broken", "last"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("broken");
        expect(String(warn.mock.calls[0][0])).toContain("was not removed");
        expect(String(warn.mock.calls[0][1])).toContain("boom");
      });

      it("also goes on when the client answers the removal with an error", async () => {
        vi.spyOn(log, "warn").mockImplementation(() => undefined);
        const server = deluge({
          "core.get_enabled_plugins": ["Label"],
          "core.get_torrents_status": { first: seeded({ ratio: 2 }), second: seeded({ ratio: 2 }) },
          "core.remove_torrent": new Error("torrent_id first not in session"),
        });

        expect(await adapter().removeSeededTorrents!(target(), 1, null)).toBe(0);
        expect(removals(server)).toHaveLength(2);
      });
    });

    it("sanitises the category into a label the way the add does (lower case, runs of other characters become '-')", async () => {
      const server = deluge({
        "core.get_enabled_plugins": ["Label"],
        "core.get_torrents_status": { yes: seeded({ label: "my-tv_shows.hd", ratio: 2 }), no: seeded({ label: "My TV/Shows", ratio: 2 }) },
        "core.remove_torrent": true,
      });

      expect(await adapter().removeSeededTorrents!(dl({ category: "My TV/Shows (HD)!" }), 1, null)).toBe(0);
      expect(removals(server)).toHaveLength(0);

      const second = deluge({
        "core.get_enabled_plugins": ["Label"],
        "core.get_torrents_status": { yes: seeded({ label: "my-tv-shows-hd-", ratio: 2 }), no: seeded({ label: "My TV/Shows", ratio: 2 }) },
        "core.remove_torrent": true,
      });
      expect(await adapter().removeSeededTorrents!(dl({ category: "My TV/Shows (HD)!" }), 1, null)).toBe(1);
      expect(removals(second).map((s) => s.params[0])).toEqual(["yes"]);
    });

    it("removes nothing when there are no goals and no torrent has a goal of its own", async () => {
      const server = deluge({
        "core.get_enabled_plugins": ["Label"],
        "core.get_torrents_status": { a: seeded({ ratio: 50, seeding_time: 999_999 }), b: seeded({ state: "Paused", ratio: 9 }) },
        "core.remove_torrent": true,
      });

      expect(await adapter().removeSeededTorrents!(target(), null, null)).toBe(0);
      expect(removals(server)).toHaveLength(0);
    });

    it("still removes a torrent that met the goal it was given at add when there is no global goal", async () => {
      const server = deluge({
        "core.get_enabled_plugins": ["Label"],
        "core.get_torrents_status": { met: seeded({ stop_at_ratio: true, stop_ratio: 1.5, ratio: 1.6 }), held: seeded({ stop_at_ratio: true, stop_ratio: 1.5, ratio: 1.4 }) },
        "core.remove_torrent": true,
      });

      expect(await adapter().removeSeededTorrents!(target(), null, null)).toBe(1);
      expect(removals(server).map((s) => s.params)).toEqual([["met", false]]);
    });
  });
});

// ---------------------------------------------------------------------------
// Blackhole (L10)
// ---------------------------------------------------------------------------

describe("Blackhole sniffs for an NZB only when it does not know the protocol (Round 30b, L10)", () => {
  const RELEASE = "https://idx.example.com/get/1";
  const TITLE = "Some Release 2020";
  const adapter = () => dc.getDownloadClientAdapter("blackhole");
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Adds `body` as the release's download to a fresh watch folder; returns the folder and what was added to it. */
  async function addTo(body: Buffer, protocol?: "torrent" | "usenet") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-blackhole-"));
    made.push(dir);
    stubFetch(() => bytesReply(body));
    const target = client({ type: "blackhole", host: dir });
    const outcome = await adapter().addDownload(target, RELEASE, null, TITLE, protocol).then(
      (result) => ({ result, error: null as any }),
      (error) => ({ result: null, error })
    );
    return { dir, files: fs.readdirSync(dir), ...outcome };
  }
  const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file));
  const gzipNzb = zlib.gzipSync(Buffer.from(NZB));
  const NOT_AN_NZB = "Failed to fetch release: the indexer's answer to the NZB download is not an NZB file";

  describe("protocol torrent: never an NZB", () => {
    it("writes a gzip body untouched as a .torrent", async () => {
      const { dir, files, error } = await addTo(gzipNzb, "torrent");

      expect(error).toBeNull();
      expect(files).toEqual([`${TITLE}.torrent`]);
      expect(read(dir, `${TITLE}.torrent`).equals(gzipNzb)).toBe(true);
    });

    it("writes a body that looks like XML, a UTF-16 byte order mark or a UTF-8 one untouched too", async () => {
      for (const body of [Buffer.from("<html>not checked</html>"), Buffer.from(NZB), Buffer.from([0xff, 0xfe, 0x3c, 0x00]), Buffer.from([0xef, 0xbb, 0xbf, 0x3c])]) {
        const { dir, files, error } = await addTo(body, "torrent");
        expect(error).toBeNull();
        expect(files).toEqual([`${TITLE}.torrent`]);
        expect(read(dir, `${TITLE}.torrent`).equals(body)).toBe(true);
      }
    });

    it("writes a real torrent file as it came", async () => {
      const { dir, files } = await addTo(TORRENT, "torrent");

      expect(files).toEqual([`${TITLE}.torrent`]);
      expect(read(dir, `${TITLE}.torrent`).equals(TORRENT)).toBe(true);
    });
  });

  describe("protocol usenet: always an NZB", () => {
    it("writes a plain NZB as a .nzb, and a gzip-compressed one decoded", async () => {
      const plain = await addTo(Buffer.from(NZB), "usenet");
      expect(plain.files).toEqual([`${TITLE}.nzb`]);
      expect(read(plain.dir, `${TITLE}.nzb`).toString()).toBe(NZB);

      const gzipped = await addTo(gzipNzb, "usenet");
      expect(gzipped.files).toEqual([`${TITLE}.nzb`]);
      expect(read(gzipped.dir, `${TITLE}.nzb`).toString()).toBe(NZB);
    });

    it("refuses a body that is not an NZB, whatever it starts with, and writes nothing", async () => {
      for (const body of [TORRENT, Buffer.from("just some text"), Buffer.from("<html><body>Please log in</body></html>"), Buffer.alloc(0)]) {
        const { files, error } = await addTo(body, "usenet");
        expect(error?.message).toBe(NOT_AN_NZB);
        expect(files).toEqual([]);
      }
    });

    it("refuses an indexer's error document as the indexer's answer, and an NZB with no files", async () => {
      const refused = await addTo(Buffer.from('<?xml version="1.0"?><error code="429" description="Request limit reached"/>'), "usenet");
      expect(refused.error?.message).toMatch(/^Failed to fetch release: .*error 429: Request limit reached/);
      expect(refused.files).toEqual([]);

      const empty = await addTo(Buffer.from("<nzb></nzb>"), "usenet");
      expect(empty.error?.message).toMatch(/^Failed to fetch release: .*lists no files/);
    });
  });

  describe("protocol unknown: the body decides, as it did", () => {
    it("takes a plain, a gzip-compressed and a UTF-16 NZB for an NZB", async () => {
      const plain = await addTo(Buffer.from(NZB));
      expect(plain.files).toEqual([`${TITLE}.nzb`]);

      const gzipped = await addTo(gzipNzb);
      expect(gzipped.files).toEqual([`${TITLE}.nzb`]);
      expect(read(gzipped.dir, `${TITLE}.nzb`).toString()).toBe(NZB);

      const utf16 = await addTo(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(NZB, "utf16le")]));
      expect(utf16.files).toEqual([`${TITLE}.nzb`]);
      expect(read(utf16.dir, `${TITLE}.nzb`).toString()).toBe(NZB);
    });

    it("takes bencode for a torrent, and refuses an HTML page it took for an NZB", async () => {
      const torrent = await addTo(TORRENT);
      expect(torrent.files).toEqual([`${TITLE}.torrent`]);
      expect(read(torrent.dir, `${TITLE}.torrent`).equals(TORRENT)).toBe(true);

      const page = await addTo(Buffer.from("<html><body>Please log in</body></html>"));
      expect(page.error?.message).toBe(NOT_AN_NZB);
      expect(page.files).toEqual([]);
    });
  });

  it("is told the protocol of the release by the scheduler", async () => {
    // grab() hands the release's protocol on as the fifth argument: a gzip-compressed torrent is not taken for an NZB,
    // and a usenet release that is no NZB is refused as the release's fault.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-blackhole-"));
    made.push(dir);
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, host, enabled) VALUES ('Watch folder', 'blackhole', ?, 1)").run(dir)).lastInsertRowid);
    const target = client({ id: clientId, type: "blackhole", host: dir });

    stubFetch(() => bytesReply(gzipNzb));
    const torrent = await prepareGrab(RELEASE, "torrent");
    expect(await scheduler.grab(target, torrent.item, null, null, torrent.chosen, 0, null, "auto")).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(fs.readdirSync(dir)[0]).toMatch(/\.torrent$/);
    expect(read(dir, fs.readdirSync(dir)[0]).equals(gzipNzb)).toBe(true);

    stubFetch(() => bytesReply(TORRENT));
    const err = await grabTo(target, RELEASE, "usenet");
    expect(err).toBeInstanceOf(scheduler.ReleaseRefusedError);
    expect(err.message).toBe(NOT_AN_NZB);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});
