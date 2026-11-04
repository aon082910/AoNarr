import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

// Clients of equal priority and type take the grabs in turn (pickClientForProtocol with rotate: true). The turn is kept
// in memory per "protocol:priority:type" for the life of the process, so every test here uses a priority of its own.
const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let status: typeof import("../src/services/clientStatus.js");
let scheduler: typeof import("../src/services/scheduler.js");

beforeAll(async () => {
  ({ db } = await setupTestDb());
  status = await import("../src/services/clientStatus.js");
  scheduler = await import("../src/services/scheduler.js");
});

beforeEach(async () => {
  for (const t of ["history", "queue", "download_client_status", "download_clients", "media_items"]) await db.prepare(`DELETE FROM ${t}`).run();
  status.resetClientStatuses();
  getDownloadClientAdapter.mockReset();
});

let nextPriority = 10;
/** A priority no other test used, so the in-memory turn of its clients starts at the first. */
const freshPriority = () => nextPriority++;

let nextId = 1;
const c = (over: Partial<DownloadClient> = {}): DownloadClient =>
  ({
    id: nextId++,
    name: `Client ${nextId - 1}`,
    type: "qbittorrent",
    host: "h",
    port: 1,
    useSsl: 0,
    username: null,
    password: null,
    apiKey: null,
    category: null,
    categoryByType: null,
    enabled: 1,
    audioOnly: 0,
    downloadTypes: null,
    tagIds: [],
    priority: 1,
    ...over,
  }) as DownloadClient;

/** A client that is also a row in the database (the failure ladder keeps its state against a real client id). */
async function dbClient(priority: number, over: Partial<DownloadClient> = {}): Promise<DownloadClient> {
  const type = over.type ?? "qbittorrent";
  const name = over.name ?? `Seedbox ${nextId}`;
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority) VALUES (?, ?, 'dl.local', 8080, 1, ?)").run(name, type, priority)).lastInsertRowid);
  return c({ ...over, id, name, type, priority });
}

const rotate = (clients: DownloadClient[], protocol: "torrent" | "usenet" = "torrent", extra: Record<string, unknown> = {}) =>
  scheduler.pickClientForProtocol(clients, protocol, { rotate: true, ...extra })?.id;

/** Picks `times` in a row and returns the ids. */
const picks = (times: number, pick: () => number | undefined) => Array.from({ length: times }, pick);

describe("pickClientForProtocol — clients of equal priority and type take turns when asked to rotate", () => {
  it("alternates between two qBittorrent clients of the same priority: A, B, A, B", () => {
    const priority = freshPriority();
    const a = c({ priority });
    const b = c({ priority });

    expect(picks(4, () => rotate([a, b]))).toEqual([a.id, b.id, a.id, b.id]);
  });

  it("goes round all of three clients", () => {
    const priority = freshPriority();
    const [a, b, d] = [c({ priority }), c({ priority }), c({ priority })];

    expect(picks(7, () => rotate([a, b, d]))).toEqual([a.id, b.id, d.id, a.id, b.id, d.id, a.id]);
  });

  it("takes the turns in id order whatever order the list comes in", () => {
    const priority = freshPriority();
    const a = c({ priority });
    const b = c({ priority });

    expect(picks(4, () => rotate([b, a]))).toEqual([a.id, b.id, a.id, b.id]);
  });

  it("always answers the first one without rotate, and does not use up a turn", () => {
    const priority = freshPriority();
    const a = c({ priority });
    const b = c({ priority });

    expect(picks(4, () => scheduler.pickClientForProtocol([a, b], "torrent")?.id)).toEqual([a.id, a.id, a.id, a.id]);
    expect(picks(3, () => scheduler.pickClientForProtocol([a, b], "torrent", { rotate: false })?.id)).toEqual([a.id, a.id, a.id]);
    // The checks that only ask whether a client exists left the rotation where it was.
    expect(picks(2, () => rotate([a, b]))).toEqual([a.id, b.id]);
  });

  it("answers the only client every time", () => {
    const only = c({ priority: freshPriority() });

    expect(picks(3, () => rotate([only]))).toEqual([only.id, only.id, only.id]);
  });

  it("does not mix in a client of another type with the same priority", () => {
    const priority = freshPriority();
    const qbA = c({ priority, type: "qbittorrent" });
    const qbB = c({ priority, type: "qbittorrent" });
    const transmission = c({ priority, type: "transmission" });

    const chosen = picks(6, () => rotate([transmission, qbA, qbB]));

    expect(chosen).toEqual([qbA.id, qbB.id, qbA.id, qbB.id, qbA.id, qbB.id]);
    expect(chosen).not.toContain(transmission.id);
  });

  it("a lone client of another type with the same priority is picked only when the preferred type is gone", () => {
    const priority = freshPriority();
    const qb = c({ priority, type: "qbittorrent" });
    const deluge = c({ priority, type: "deluge" });

    expect(picks(3, () => rotate([deluge, qb]))).toEqual([qb.id, qb.id, qb.id]);
    expect(picks(3, () => rotate([deluge]))).toEqual([deluge.id, deluge.id, deluge.id]);
  });

  it("lets a lower priority number win over a rotation among higher numbers", () => {
    const priority = freshPriority();
    const preferred = c({ priority });
    const a = c({ priority: priority + 100 });
    const b = c({ priority: priority + 100 });

    expect(picks(4, () => rotate([a, b, preferred]))).toEqual([preferred.id, preferred.id, preferred.id, preferred.id]);
    // Once the preferred client is out of the way, the others take turns.
    expect(picks(4, () => rotate([a, b]))).toEqual([a.id, b.id, a.id, b.id]);
  });

  it("treats a client without a priority as priority 1", () => {
    // Priority 1 is used by this test only.
    const noPriority = c({ priority: undefined });
    const one = c({ priority: 1 });
    const two = c({ priority: 2 });

    expect(picks(4, () => rotate([two, one, noPriority]))).toEqual([noPriority.id, one.id, noPriority.id, one.id]);
  });

  it("rotates usenet clients on a turn of their own, apart from the torrent clients", () => {
    const priority = freshPriority();
    const qbA = c({ priority });
    const qbB = c({ priority });
    const sabA = c({ priority, type: "sabnzbd" });
    const sabB = c({ priority, type: "sabnzbd" });

    const order: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      order.push(rotate([qbA, qbB, sabA, sabB], "torrent"));
      order.push(rotate([qbA, qbB, sabA, sabB], "usenet"));
    }

    expect(order).toEqual([qbA.id, sabA.id, qbB.id, sabB.id, qbA.id, sabA.id]);
  });

  it("answers the client the release's indexer names, without using up a turn", () => {
    const priority = freshPriority();
    const a = c({ priority });
    const b = c({ priority });
    const named = c({ priority: priority + 100 });

    expect(rotate([a, b, named], "torrent", { clientId: named.id })).toBe(named.id);
    expect(rotate([a, b, named], "torrent", { clientId: named.id })).toBe(named.id);
    expect(picks(2, () => rotate([a, b, named]))).toEqual([a.id, b.id]);
  });
});

describe("pickClientForProtocol — rotation skips clients that are being left alone", () => {
  it("never picks a backed-off client, and the others take turns", async () => {
    const priority = freshPriority();
    const a = await dbClient(priority);
    const b = await dbClient(priority);
    const d = await dbClient(priority);
    await status.recordClientFailure(a.id, "ECONNREFUSED");

    const chosen = picks(6, () => rotate([a, b, d]));

    expect(chosen).not.toContain(a.id);
    expect(new Set(chosen)).toEqual(new Set([b.id, d.id]));
    for (let i = 1; i < chosen.length; i++) expect(chosen[i]).not.toBe(chosen[i - 1]);
  });

  it("answers the one client left when the rest are backed off, and none when all are", async () => {
    const priority = freshPriority();
    const a = await dbClient(priority);
    const b = await dbClient(priority);
    await status.recordClientFailure(a.id, "down");

    expect(picks(3, () => rotate([a, b]))).toEqual([b.id, b.id, b.id]);
    await status.recordClientFailure(b.id, "down");
    expect(rotate([a, b])).toBeUndefined();
  });

  it("takes the client back into the rotation once it answers again", async () => {
    const priority = freshPriority();
    const a = await dbClient(priority);
    const b = await dbClient(priority);
    await status.recordClientFailure(a.id, "down");
    expect(picks(2, () => rotate([a, b]))).toEqual([b.id, b.id]);

    await status.recordClientSuccess(a.id);

    const chosen = picks(4, () => rotate([a, b]));
    expect(new Set(chosen)).toEqual(new Set([a.id, b.id]));
    for (let i = 1; i < chosen.length; i++) expect(chosen[i]).not.toBe(chosen[i - 1]);
  });

  it("still rotates through a backed-off client when asked to ignore the back-off", async () => {
    const priority = freshPriority();
    const a = await dbClient(priority);
    const b = await dbClient(priority);
    await status.recordClientFailure(a.id, "down");

    expect(picks(4, () => rotate([a, b], "torrent", { ignoreBackoff: true }))).toEqual([a.id, b.id, a.id, b.id]);
  });

  it("falls to the next priority when every client of the first is backed off", async () => {
    const priority = freshPriority();
    const a = await dbClient(priority);
    const b = await dbClient(priority);
    const spare = await dbClient(priority + 100);
    await status.recordClientFailure(a.id, "down");
    await status.recordClientFailure(b.id, "down");

    expect(picks(2, () => rotate([a, b, spare]))).toEqual([spare.id, spare.id]);
  });
});

describe("pickClientForProtocol — rotation among the clients a title's tags allow", () => {
  it("rotates among the tag-scoped clients allowed for the title, and not the unscoped ones", () => {
    const priority = freshPriority();
    const scopedA = c({ priority, tagIds: [7] });
    const scopedB = c({ priority, tagIds: [7, 8] });
    const scopedElsewhere = c({ priority, tagIds: [9] });
    const openA = c({ priority });
    const openB = c({ priority });
    const all = [openA, scopedElsewhere, openB, scopedB, scopedA];

    const chosen = picks(4, () => rotate(all, "torrent", { itemTags: [7] }));

    expect(chosen).toEqual([scopedA.id, scopedB.id, scopedA.id, scopedB.id]);
  });

  it("rotates among the unscoped clients for a title no scoped client takes", () => {
    const priority = freshPriority();
    const scoped = c({ priority, tagIds: [7] });
    const openA = c({ priority: priority + 100 });
    const openB = c({ priority: priority + 100 });

    expect(picks(4, () => rotate([scoped, openA, openB], "torrent", { itemTags: [9] }))).toEqual([openA.id, openB.id, openA.id, openB.id]);
    expect(picks(2, () => rotate([scoped, openA, openB], "torrent", { itemTags: [] }))).toEqual([openA.id, openB.id]);
  });

  it("keeps a turn of its own per group when tagged and untagged titles alternate", () => {
    // The scoped pair and the unscoped pair share a priority and a type: each pair still takes its grabs in turn.
    const priority = freshPriority();
    const scopedA = c({ priority, tagIds: [7] });
    const scopedB = c({ priority, tagIds: [7] });
    const openA = c({ priority });
    const openB = c({ priority });
    const all = [scopedA, scopedB, openA, openB];

    const order: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(rotate(all, "torrent", { itemTags: [7] })); // a tagged title
      order.push(rotate(all, "torrent", { itemTags: [9] })); // a title no scoped client takes
    }

    expect(order.filter((_id, i) => i % 2 === 0)).toEqual([scopedA.id, scopedB.id, scopedA.id, scopedB.id]);
    expect(order.filter((_id, i) => i % 2 === 1)).toEqual([openA.id, openB.id, openA.id, openB.id]);
  });

  it("keeps a turn of its own per group when titles with no tags at all come in between", () => {
    const priority = freshPriority();
    const scopedA = c({ priority, tagIds: [7] });
    const scopedB = c({ priority, tagIds: [7] });
    const openA = c({ priority });
    const openB = c({ priority });
    const all = [scopedA, scopedB, openA, openB];

    const tagged = picks(3, () => {
      rotate(all, "torrent", { itemTags: [] }); // an untagged title takes a turn among the unscoped clients
      return rotate(all, "torrent", { itemTags: [7] });
    });

    // The untagged titles' grabs do not move the tagged titles' turn.
    expect(tagged).toEqual([scopedA.id, scopedB.id, scopedA.id]);
  });

  it("starts the turn over for a different set of clients of the same priority and type", () => {
    const priority = freshPriority();
    const a = c({ priority });
    const b = c({ priority });
    const d = c({ priority });
    expect(picks(3, () => rotate([a, b]))).toEqual([a.id, b.id, a.id]);

    // A third client joins: the run is a different one, and goes round from its first.
    expect(picks(4, () => rotate([a, b, d]))).toEqual([a.id, b.id, d.id, a.id]);
    // Back to the pair: its own turn was left where it was.
    expect(rotate([a, b])).toBe(b.id);
  });

  it("answers nothing when only scoped clients exist and none is allowed for the title", () => {
    const priority = freshPriority();
    const a = c({ priority, tagIds: [7] });
    const b = c({ priority, tagIds: [8] });

    expect(rotate([a, b], "torrent", { itemTags: [9] })).toBeUndefined();
  });
});

describe("grabBestRelease — three grabs through two equal qBittorrent clients go A, B, A", () => {
  const release = (title: string) =>
    ({ indexerId: null, indexerName: "Idx", title, size: 1, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=urn:btih:${title}`, protocol: "torrent", category: null }) as any;
  const choose = async (remaining: any[]) => (remaining.length > 0 ? { result: remaining[0], quality: "WEBDL-1080p" } : null);

  async function insertMovie(title: string) {
    const id = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', ?, ?, 1, 0, 'missing')").run(title, title.toLowerCase())).lastInsertRowid);
    const { mediaItemFromRow } = await import("../src/db/mappers.js");
    return mediaItemFromRow(await db.prepare("SELECT * FROM media_items WHERE id = ?").get(id));
  }

  it("sends each grab to the next client, and the queue rows record it", async () => {
    const priority = freshPriority();
    const clientA = await dbClient(priority, { name: "Seedbox A" });
    const clientB = await dbClient(priority, { name: "Seedbox B" });
    const addedTo: number[] = [];
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn(async (client: DownloadClient, url: string) => {
        addedTo.push(client.id);
        return { downloadId: `id-${url}` };
      }),
      getStatus: vi.fn(async () => []),
    });
    const sentTo: string[] = [];

    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      const movie = await insertMovie(title);
      const outcome = await scheduler.grabBestRelease(
        [release(`${title}.2020.1080p.WEB-DL-GRP`)],
        [clientA, clientB],
        choose,
        async (client, chosen) => {
          sentTo.push(client.name);
          return scheduler.grab(client, movie, null, null, chosen, 0, null, "auto");
        },
        { itemId: movie.id }
      );
      expect(outcome?.grabbed).toBe(true);
    }

    expect(sentTo).toEqual(["Seedbox A", "Seedbox B", "Seedbox A"]);
    expect(addedTo).toEqual([clientA.id, clientB.id, clientA.id]);
    const rows = (await db.prepare("SELECT download_client_id FROM queue ORDER BY id").all()) as { download_client_id: number }[];
    expect(rows.map((r) => Number(r.download_client_id))).toEqual([clientA.id, clientB.id, clientA.id]);
  });

  it("goes to the other client when the one whose turn it is cannot be reached", async () => {
    const priority = freshPriority();
    const clientA = await dbClient(priority, { name: "Seedbox A" });
    const clientB = await dbClient(priority, { name: "Seedbox B" });
    const movie = await insertMovie("Delta");
    const tried: string[] = [];

    const outcome = await scheduler.grabBestRelease(
      [release("Delta.2020.1080p.WEB-DL-GRP")],
      [clientA, clientB],
      choose,
      async (client) => {
        tried.push(client.name);
        if (client.id === clientA.id) throw new scheduler.DownloadClientUnavailableError(client, new Error("ECONNREFUSED"));
        return true;
      },
      { itemId: movie.id }
    );

    expect(tried).toEqual(["Seedbox A", "Seedbox B"]);
    expect(outcome?.client.id).toBe(clientB.id);
    expect(status.isClientBackedOff(clientA.id)).toBe(true);
  });
});
