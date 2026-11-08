import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient, SearchResult } from "../src/types/index.js";
import { preflightContextFor } from "../src/services/throttlearr/preflight.js";

// Throttlearr pre-flight wired into chooseBestResult (names, size, ids) and into the grab/release path (NZB inspection).
const adapter: any = { addDownload: vi.fn(), getStatus: vi.fn(), queueLoad: undefined };
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

const setGate = (over: Record<string, unknown>) => setSetting("throttlearr", JSON.stringify(over));

beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "episodes", "media_items", "blocklist"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  adapter.queueLoad = undefined;
  adapter.addDownload.mockReset();
  adapter.getStatus.mockResolvedValue([]);
  setGate({});
});

function fakeResult(over: Partial<SearchResult>): SearchResult {
  return { indexerId: null, indexerName: "Idx", title: "x", size: 4_000_000_000, seeders: 5, leechers: 0, publishDate: null, downloadUrl: "magnet:?xt=urn:btih:abc", protocol: "torrent", category: null, ...over } as SearchResult;
}

const choose = (results: SearchResult[], extra: Record<string, unknown> = {}, identity: any = null) =>
  scheduler.chooseBestResult(results, [], "", null, 0, null, new Set(), "movie", null, identity, null, extra as any);

describe("pre-flight in chooseBestResult", () => {
  const junk = fakeResult({ title: "Some.Movie.2020.1080p.BluRay.x264-AAA.sample", seeders: 900 });
  const tiny = fakeResult({ title: "Some.Movie.2020.1080p.BluRay.x264-BBB", size: 146_000_000, seeders: 800 });
  const real = fakeResult({ title: "Some.Movie.2020.1080p.BluRay.x264-CCC", seeders: 3 });

  it("changes nothing while Throttlearr is off", async () => {
    setGate({ enabled: false });
    expect((await choose([junk, tiny, real]))?.result.title).toBe(junk.title);
  });

  it("skips a junk name and a size under the floor, and picks the next best release in the same search", async () => {
    setGate({ enabled: true });
    expect((await choose([junk, tiny, real]))?.result.title).toBe(real.title);
    expect(await choose([junk, tiny])).toBeNull();
  });

  it("reports why each one was turned away", async () => {
    setGate({ enabled: true });
    const reasons: string[] = [];
    await choose([junk, tiny, real], { onRejected: (r: SearchResult, why: string) => reasons.push(`${r.title}: ${why}`) });
    expect(reasons.some((r) => r.includes(".sample") && /sample clip/.test(r))).toBe(true);
    expect(reasons.some((r) => r.includes("BBB") && /146 MB for 1080p/.test(r))).toBe(true);
  });

  it("each switch turns its rule off", async () => {
    setGate({ enabled: true, preflight: { junkNames: false } });
    expect((await choose([junk, real]))?.result.title).toBe(junk.title);
    setGate({ enabled: true, preflight: { sizeFloor: false } });
    expect((await choose([tiny, real]))?.result.title).toBe(tiny.title);
    setGate({ enabled: true, preflight: { enabled: false } });
    expect((await choose([junk, tiny, real]))?.result.title).toBe(junk.title);
  });

  it("does not judge music or books", async () => {
    setGate({ enabled: true });
    expect(await preflightContextFor(null, "artist")).toBeNull();
    expect(await preflightContextFor(null, "author")).toBeNull();
    expect(await preflightContextFor(null, "movie")).not.toBeNull();
    setGate({ enabled: false });
    expect(await preflightContextFor(null, "movie")).toBeNull();
    setGate({ enabled: true, preflight: { enabled: false } });
    expect(await preflightContextFor(null, "movie")).toBeNull();
  });

  it("with strictIdentity, an indexer's id no longer vouches for a release whose name is another film's", async () => {
    const wrongFilm = fakeResult({ title: "Other.Film.2020.1080p.BluRay.x264-DDD", imdbId: "tt1234567" });
    const identity = { year: 2020, externalIds: { imdb: "tt1234567" } };
    const opts = { name: { title: "Some Movie" }, identityMode: "enforce" };

    setGate({ enabled: true });
    expect((await choose([wrongFilm], opts, identity))?.result.title).toBe(wrongFilm.title); // today's behaviour: the id settles it

    setGate({ enabled: true, preflight: { strictIdentity: true } });
    expect(await choose([wrongFilm], opts, identity)).toBeNull();

    // A release that names the film is untouched by the switch.
    const right = fakeResult({ title: "Some.Movie.2020.1080p.BluRay.x264-EEE", imdbId: "tt1234567" });
    expect((await choose([wrongFilm, right], opts, identity))?.result.title).toBe(right.title);
  });
});

const GB = 1_000_000_000;
function nzb(files: { name: string; bytes: number }[], meta = ""): Buffer {
  const body = files
    .map((f) => `<file poster="p" date="1" subject="&quot;${f.name}&quot; yEnc (1/1)"><groups><group>g</group></groups><segments><segment bytes="${f.bytes}" number="1">id@x</segment></segments></file>`)
    .join("");
  return Buffer.from(`<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head>${meta}</head>${body}</nzb>`);
}

/** A client adapter that fetches `body` as the NZB and runs the caller's inspection on it, as SABnzbd's does. */
let nzoCounter = 0;
function adapterServing(body: () => Buffer) {
  adapter.addDownload.mockImplementation(async (_c: unknown, _url: string, _cat: unknown, _title: unknown, _proto: unknown, options?: any) => {
    const reason = options?.inspectNzb?.(body());
    if (reason) throw new Error(`Refused before download: ${reason}`);
    return { downloadId: `nzo${++nzoCounter}` };
  });
}

async function insertClient(name = "Sab"): Promise<DownloadClient> {
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, 'sabnzbd', 'dl.local', 8080, 1, 1)").run(name)).lastInsertRowid);
  return { id, name, type: "sabnzbd", host: "dl.local", port: 8080, useSsl: 0, username: null, password: null, apiKey: null, category: null, categoryByType: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1 } as DownloadClient;
}

let n = 0;
async function grabUsenet(client: DownloadClient, source: "auto" | "interactive" = "auto") {
  n++;
  const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, 1, 'missing')").run(`Nzb ${n}`, `nzb ${n}`)).lastInsertRowid);
  const item = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(itemId)) as any;
  const result = fakeResult({ title: `Nzb.${itemId}.2020.1080p.BluRay.x264-GRP`, protocol: "usenet", downloadUrl: `http://idx/get/${itemId}.nzb` });
  const ok = await scheduler.grab(client, mediaItemFromRow(item), null, null, { result, quality: "Bluray-1080p" } as any, 0, null, source);
  return { ok, itemId };
}

describe("NZB inspection on the way to the client", () => {
  it("sends a clean NZB", async () => {
    setGate({ enabled: true });
    adapterServing(() => nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }]));
    const client = await insertClient();
    expect((await grabUsenet(client)).ok).toBe(true);
    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
    expect(typeof adapter.addDownload.mock.calls[0][5].inspectNzb).toBe("function");
  });

  it("refuses an NZB that holds only an .nfo and repair data, as a refused release", async () => {
    setGate({ enabled: true });
    adapterServing(() => nzb([{ name: "Film.nfo", bytes: 4000 }, { name: "Film.par2", bytes: 1_000_000 }]));
    const client = await insertClient();
    await expect(grabUsenet(client)).rejects.toBeInstanceOf(scheduler.ReleaseRefusedError);
    expect((await db.prepare("SELECT COUNT(*) AS c FROM queue").get()) as any).toMatchObject({ c: 0 });
  });

  it("refuses a program, but not a password the NZB brings (the client unpacks with it)", async () => {
    setGate({ enabled: true });
    const client = await insertClient();
    adapterServing(() => nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }], '<meta type="password">pw</meta>'));
    await expect(grabUsenet(client)).resolves.toBeDefined();
    adapterServing(() => nzb([{ name: "Film.mkv", bytes: 4 * GB }, { name: "Play.exe", bytes: 100_000 }]));
    await expect(grabUsenet(client)).rejects.toThrow(/program/);
  });

  it("refuses an NZB that holds far less video than the indexer's size and the quality say", async () => {
    setGate({ enabled: true });
    adapterServing(() => nzb([{ name: "Film.2020.1080p.mkv", bytes: 120_000_000 }]));
    const client = await insertClient();
    await expect(grabUsenet(client)).rejects.toThrow(/MB of video, under the/);
  });

  it("does nothing while Throttlearr is off or inspection is off, and never refuses a hand-picked release", async () => {
    const client = await insertClient();
    const junkNzb = () => nzb([{ name: "Film.nfo", bytes: 4000 }]);
    adapterServing(junkNzb);
    setGate({ enabled: false });
    expect((await grabUsenet(client)).ok).toBe(true);
    setGate({ enabled: true, preflight: { inspectNzb: false } });
    expect((await grabUsenet(client)).ok).toBe(true);
    setGate({ enabled: true });
    expect((await grabUsenet(client, "interactive")).ok).toBe(true);
  });

  it("a held grab is inspected when it is released: refused, blocklisted, and the next one goes", async () => {
    const client = await insertClient();
    setGate({ enabled: true, clients: { [client.id]: { maxActive: 1 } } });
    let current = nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }]);
    adapterServing(() => current);
    await grabUsenet(client); // sent, fills the one slot
    await grabUsenet(client); // held: will be a bad NZB
    await grabUsenet(client); // held: fine
    await db.prepare("UPDATE queue SET status = 'completed' WHERE download_id IS NOT NULL").run();

    setGate({ enabled: true, clients: { [client.id]: { maxActive: 2 } } });
    let calls = 0;
    adapterServing(() => (++calls === 1 ? nzb([{ name: "Film.nfo", bytes: 4000 }]) : nzb([{ name: "Film.2020.1080p.mkv", bytes: 4 * GB }])));
    const summary = await release.releaseHeldGrabs();
    expect(summary).toMatchObject({ released: 1, failed: 1 });
    const rows = (await db.prepare("SELECT * FROM queue ORDER BY id").all()) as any[];
    expect(rows[1]).toMatchObject({ status: "failed", gate_state: null });
    expect(rows[2]).toMatchObject({ gate_state: "released" });
    const blocked = (await db.prepare("SELECT reason FROM blocklist").all()) as { reason: string }[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toMatch(/Refused before download: The NZB holds no video or archive/);
  });
});
