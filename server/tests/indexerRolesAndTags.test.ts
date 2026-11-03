import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient, Indexer } from "../src/types/index.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let searchAllIndexers: (typeof import("../src/services/indexerClient.js"))["searchAllIndexers"];
let indexerTakesSearch: (typeof import("../src/services/indexerClient.js"))["indexerTakesSearch"];
let pickClientForProtocol: (typeof import("../src/services/scheduler.js"))["pickClientForProtocol"];
let tagScope: typeof import("../src/services/tagScope.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ searchAllIndexers, indexerTakesSearch } = await import("../src/services/indexerClient.js"));
  ({ pickClientForProtocol } = await import("../src/services/scheduler.js"));
  tagScope = await import("../src/services/tagScope.js");
});

beforeEach(async () => {
  for (const t of ["media_item_tags", "media_items", "indexers", "download_clients", "tags"]) await db.prepare(`DELETE FROM ${t}`).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const api = (method: "post" | "patch" | "delete" | "get", path: string, body?: unknown) =>
  (request(app as any) as any)[method](path).set("X-Api-Key", apiKey).send(body);

async function makeTag(name: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO tags (name) VALUES (?)").run(name)).lastInsertRowid);
}

describe("tag scopes (ST10)", () => {
  it("reads a stored list, and treats anything else as no scope", () => {
    expect(tagScope.parseTagIds("[3,1,3]")).toEqual([3, 1]);
    expect(tagScope.parseTagIds(null)).toEqual([]);
    expect(tagScope.parseTagIds("not json")).toEqual([]);
    expect(tagScope.parseTagIds('{"a":1}')).toEqual([]);
  });

  it("allows everything for no scope and only a shared tag for a scope", () => {
    expect(tagScope.scopeAllows([], [])).toBe(true);
    expect(tagScope.scopeAllows(undefined, [4])).toBe(true);
    expect(tagScope.scopeAllows([2], [])).toBe(false);
    expect(tagScope.scopeAllows([2, 3], [3])).toBe(true);
  });

  it("checks a request's tag ids", () => {
    expect(tagScope.tagIdsColumn([2, 2, 3])).toBe("[2,3]");
    expect(tagScope.tagIdsColumn([])).toBeNull();
    expect(() => tagScope.tagIdsColumn(["x"])).toThrow();
    expect(() => tagScope.tagIdsColumn("5")).toThrow();
  });
});

describe("the indexer routes (ST10, ST11)", () => {
  it("a new indexer starts with every role on, a minimum of one seeder and no scope", async () => {
    const res = await api("post", "/api/indexers", { name: "Fresh", protocol: "torznab", url: "https://idx.example.com", apiKey: "k" });
    expect(res.status).toBe(201);
    expect(res.body.minimumSeeders).toBe(1);
    expect(res.body.enableRss).toBe(1);
    expect(res.body.enableAutomaticSearch).toBe(1);
    expect(res.body.enableInteractiveSearch).toBe(1);
    expect(res.body.tagIds).toEqual([]);
    expect(res.body.seedRatio).toBeNull();
    expect(res.body.downloadClientId).toBeNull();
  });

  it("stores roles, seed goals, the client and the tags", async () => {
    const tagId = await makeTag("private");
    const clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Q', 'qbittorrent', 1)").run()).lastInsertRowid);
    const created = await api("post", "/api/indexers", {
      name: "Tracker",
      protocol: "torznab",
      url: "https://t.example.com",
      enableRss: false,
      enableAutomaticSearch: false,
      seedRatio: 1.5,
      seedTimeMinutes: 4320,
      downloadClientId: clientId,
      tagIds: [tagId],
      minimumSeeders: 0,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      enableRss: 0,
      enableAutomaticSearch: 0,
      enableInteractiveSearch: 1,
      seedRatio: 1.5,
      seedTimeMinutes: 4320,
      downloadClientId: clientId,
      tagIds: [tagId],
      minimumSeeders: 0,
    });

    const edited = await api("patch", `/api/indexers/${created.body.id}`, { enableInteractiveSearch: false, seedRatio: null, tagIds: [], downloadClientId: null });
    expect(edited.body).toMatchObject({ enableInteractiveSearch: 0, seedRatio: null, tagIds: [], downloadClientId: null });
  });

  it("rejects a bad seed goal, a missing client and a tag that does not exist", async () => {
    const base = { name: "Bad", protocol: "torznab", url: "https://b.example.com" };
    expect((await api("post", "/api/indexers", { ...base, seedRatio: -1 })).status).toBe(400);
    expect((await api("post", "/api/indexers", { ...base, seedTimeMinutes: 1.5 })).status).toBe(400);
    expect((await api("post", "/api/indexers", { ...base, downloadClientId: 9999 })).status).toBe(400);
    expect((await api("post", "/api/indexers", { ...base, tagIds: [9999] })).status).toBe(400);
  });
});

describe("a tag in use cannot be deleted (ST9, ST10)", () => {
  it("names the indexer, client, list and root folder that use it", async () => {
    const tagId = await makeTag("kids");
    const indexer = await api("post", "/api/indexers", { name: "Kid Tracker", protocol: "torznab", url: "https://k.example.com", tagIds: [tagId] });
    expect(indexer.status).toBe(201);
    const client = await api("post", "/api/download-clients", { name: "Kid Client", type: "http", tagIds: [tagId] });
    expect(client.status).toBe(201);

    const refused = await api("delete", `/api/tags/${tagId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Kid Tracker/);
    expect(refused.body.error).toMatch(/Kid Client/);

    await api("patch", `/api/indexers/${indexer.body.id}`, { tagIds: [] });
    await api("patch", `/api/download-clients/${client.body.id}`, { tagIds: [] });
    expect((await api("delete", `/api/tags/${tagId}`)).status).toBe(204);
  });
});

function makeIndexer(over: Partial<Indexer> & { id: number }): Indexer {
  return {
    name: `Idx ${over.id}`,
    protocol: "torznab",
    url: `https://idx${over.id}.example.com`,
    apiKey: "k",
    categories: "",
    mediaTypes: "movie",
    enabled: 1,
    priority: 25,
    config: null,
    useFlareSolverr: 0,
    queryLimitPerHour: null,
    ...over,
  } as Indexer;
}

const emptyFeed = () => vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<rss version="2.0"><channel></channel></rss>' });
const askedHosts = (fetchMock: ReturnType<typeof emptyFeed>) => fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);

describe("the roles an indexer can take (ST11)", () => {
  it("indexerTakesSearch reads a role that was never set as on", () => {
    expect(indexerTakesSearch({}, "automatic")).toBe(true);
    expect(indexerTakesSearch({ enableAutomaticSearch: 0 }, "automatic")).toBe(false);
    expect(indexerTakesSearch({ enableInteractiveSearch: 0 }, "automatic")).toBe(true);
    expect(indexerTakesSearch({ enableInteractiveSearch: 0 }, "interactive")).toBe(false);
  });

  it("an automatic search leaves out an indexer whose automatic role is off, and an interactive one does not", async () => {
    const fetchMock = emptyFeed();
    vi.stubGlobal("fetch", fetchMock);
    const onlyInteractive = makeIndexer({ id: 91001, enableAutomaticSearch: 0, enableInteractiveSearch: 1 });
    const onlyAutomatic = makeIndexer({ id: 91002, enableAutomaticSearch: 1, enableInteractiveSearch: 0 });

    await searchAllIndexers([onlyInteractive, onlyAutomatic], "role-automatic-query", "movie", false);
    expect(askedHosts(fetchMock)).toEqual(["idx91002.example.com"]);

    fetchMock.mockClear();
    await searchAllIndexers([onlyInteractive, onlyAutomatic], "role-interactive-query", "movie", true);
    expect(askedHosts(fetchMock)).toEqual(["idx91001.example.com"]);
  });

  it("an indexer scoped to a tag is asked only about a title that carries it", async () => {
    const tagId = await makeTag("scoped");
    const tagged = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Tagged', 'tagged', 1, 'missing')").run()).lastInsertRowid);
    const plain = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Plain', 'plain', 1, 'missing')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(tagged, tagId);
    const scoped = makeIndexer({ id: 91011, tagIds: [tagId] });
    const open = makeIndexer({ id: 91012, tagIds: [] });

    const fetchMock = emptyFeed();
    vi.stubGlobal("fetch", fetchMock);
    await searchAllIndexers([scoped, open], "scope-query-tagged", "movie", false, undefined, { itemId: tagged });
    expect(askedHosts(fetchMock).sort()).toEqual(["idx91011.example.com", "idx91012.example.com"]);

    fetchMock.mockClear();
    await searchAllIndexers([scoped, open], "scope-query-plain", "movie", false, undefined, { itemId: plain });
    expect(askedHosts(fetchMock)).toEqual(["idx91012.example.com"]);
  });
});

function makeClient(over: Partial<DownloadClient> & { id: number }): DownloadClient {
  return { name: `Client ${over.id}`, type: "qbittorrent", host: null, port: null, useSsl: 0, username: null, password: null, apiKey: null, category: null, enabled: 1, audioOnly: 0, downloadTypes: null, ...over } as DownloadClient;
}

describe("a tag-scoped client does not leave a title without a grab (M1)", () => {
  const torrent = (title: string) => ({ indexerId: 1, indexerName: "Idx", title, size: 1, seeders: 9, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=${title}`, protocol: "torrent", category: null }) as any;
  const usenet = (title: string) => ({ ...torrent(title), protocol: "usenet", downloadUrl: `https://nzb.example.com/${title}.nzb` }) as any;
  const scopedTorrentClient = makeClient({ id: 1, tagIds: [7] });
  const openUsenetClient = makeClient({ id: 2, type: "sabnzbd" });
  const pickFirst = async (remaining: any[]) => (remaining.length > 0 ? { result: remaining[0], quality: "WEBDL-1080p" } : null);
  let grabBestRelease: (typeof import("../src/services/scheduler.js"))["grabBestRelease"];

  beforeAll(async () => {
    ({ grabBestRelease } = await import("../src/services/scheduler.js"));
  });

  it("moves on to the usenet release when the better torrent has no client allowed for this title", async () => {
    const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Untagged', 'untagged', 1, 'missing')").run()).lastInsertRowid);
    const sent: string[] = [];
    const outcome = await grabBestRelease(
      [torrent("Best.Torrent"), usenet("Good.Usenet")],
      [scopedTorrentClient, openUsenetClient],
      pickFirst,
      async (client, chosen) => {
        sent.push(`${client.id}:${chosen.result.title}`);
        return true;
      },
      { itemId }
    );
    expect(outcome?.grabbed).toBe(true);
    expect(sent).toEqual(["2:Good.Usenet"]);
  });

  it("still sends the torrent when the title carries the tag", async () => {
    const itemId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', 'Tagged Too', 'tagged too', 1, 'missing')").run()).lastInsertRowid);
    const tagId = await makeTag("seven");
    await db.prepare("UPDATE download_clients SET id = id").run();
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(itemId, tagId);
    const scoped = makeClient({ id: 1, tagIds: [tagId] });
    const sent: string[] = [];
    await grabBestRelease([torrent("Best.Torrent"), usenet("Good.Usenet")], [scoped, openUsenetClient], pickFirst, async (client, chosen) => {
      sent.push(`${client.id}:${chosen.result.title}`);
      return true;
    }, { itemId });
    expect(sent).toEqual(["1:Best.Torrent"]);
  });
});

describe("choosing the download client (ST10, ST11)", () => {
  const plain = makeClient({ id: 1 });
  const second = makeClient({ id: 2 });
  const forKids = makeClient({ id: 3, tagIds: [7] });

  it("takes the client the release's indexer names, when it can take the protocol", () => {
    expect(pickClientForProtocol([plain, second], "torrent", { clientId: 2 })?.id).toBe(2);
  });

  it("ignores the indexer's client when it cannot take the protocol", () => {
    const sab = makeClient({ id: 4, type: "sabnzbd" });
    expect(pickClientForProtocol([plain, sab], "torrent", { clientId: 4 })?.id).toBe(1);
  });

  it("gives a tagged title the client scoped to its tag, and everything else an unscoped client", () => {
    expect(pickClientForProtocol([plain, forKids], "torrent", { itemTags: [7] })?.id).toBe(3);
    expect(pickClientForProtocol([plain, forKids], "torrent", { itemTags: [] })?.id).toBe(1);
    expect(pickClientForProtocol([plain, forKids], "torrent", { itemTags: [8] })?.id).toBe(1);
  });

  it("a tagged client alone is not used for a title without its tag", () => {
    expect(pickClientForProtocol([forKids], "torrent", { itemTags: [] })).toBeNull();
    expect(pickClientForProtocol([forKids], "torrent", { itemTags: [7] })?.id).toBe(3);
  });

  it("without any preference the choice is what it always was", () => {
    expect(pickClientForProtocol([second, plain], "torrent")?.id).toBe(1);
  });
});
