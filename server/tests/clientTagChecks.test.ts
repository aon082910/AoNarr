import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import type { DownloadClient } from "../src/types/index.js";

// Round 30c: the checks that ask "is there a client for this" pass the title's tags, so a title whose tags match only a
// client scoped to other tags reads as having no client instead of as having one.

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let scheduler: typeof import("../src/services/scheduler.js");
let getHealthReport: (typeof import("../src/services/healthReport.js"))["getHealthReport"];
let clearHealthReportCache: (typeof import("../src/services/healthReport.js"))["clearHealthReportCache"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let tagA: number;
let tagB: number;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  scheduler = await import("../src/services/scheduler.js");
  ({ getHealthReport, clearHealthReportCache } = await import("../src/services/healthReport.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  for (const t of ["media_item_tags", "download_clients", "media_items", "tags"]) await db.prepare(`DELETE FROM ${t}`).run();
  tagA = Number((await db.prepare("INSERT INTO tags (name) VALUES ('anime')").run()).lastInsertRowid);
  tagB = Number((await db.prepare("INSERT INTO tags (name) VALUES ('kids')").run()).lastInsertRowid);
  clearHealthReportCache();
  setSetting("backupEnabled", "0");
  // Every client probe fails fast and offline.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const c = (over: Partial<DownloadClient> & { id: number }): DownloadClient =>
  ({ name: `Client ${over.id}`, type: "qbittorrent", host: "h", port: 1, useSsl: 0, username: null, password: null, apiKey: null, category: null, enabled: 1, audioOnly: 0, downloadTypes: null, tagIds: [], priority: 1, ...over }) as DownloadClient;
const release = (title: string) =>
  ({ indexerId: 1, indexerName: "Idx", title, size: 1, seeders: 5, leechers: 0, publishDate: null, downloadUrl: `magnet:?xt=${title}`, protocol: "torrent", category: null }) as any;

describe("whyNothingGrabbed with the title's tags", () => {
  it("says no client takes the title's tags when every client is scoped to other tags", () => {
    const scoped = c({ id: 1, tagIds: [tagA] });
    const why = scheduler.whyNothingGrabbed([release("x")], [scoped], [scoped], undefined, undefined, [tagB]);
    expect(why).toBe("No download client takes this title's tags");
  });

  it("says so for an untagged title when every client is scoped", () => {
    const scoped = c({ id: 1, tagIds: [tagA] });
    expect(scheduler.whyNothingGrabbed([release("x")], [scoped], [scoped], undefined, undefined, [])).toBe("No download client takes this title's tags");
  });

  it("still says no client is configured when none exists for the protocol at all", () => {
    const sab = c({ id: 1, type: "sabnzbd", tagIds: [tagA] });
    expect(scheduler.whyNothingGrabbed([release("x")], [sab], [sab], undefined, undefined, [tagB])).toBe('No "torrent" download client configured');
  });

  it("does not blame the tags when a client takes them, or when the tags are not given", () => {
    const scoped = c({ id: 1, tagIds: [tagA] });
    expect(scheduler.whyNothingGrabbed([release("x")], [scoped], [scoped], undefined, undefined, [tagA])).toBe("No matching results");
    expect(scheduler.whyNothingGrabbed([release("x")], [scoped], [scoped], undefined)).toBe("No matching results");
    const open = c({ id: 2 });
    expect(scheduler.whyNothingGrabbed([release("x")], [scoped, open], [scoped, open], undefined, undefined, [tagB])).toBe("No matching results");
  });
});

describe("the health check for titles no client takes", () => {
  async function insertClient(name: string, tagIds: number[] | null): Promise<void> {
    await db
      .prepare("INSERT INTO download_clients (name, type, host, port, enabled, priority, tag_ids) VALUES (?, 'qbittorrent', 'dl.local', 8080, 1, 1, ?)")
      .run(name, tagIds ? JSON.stringify(tagIds) : null);
  }
  async function insertTitle(title: string, tags: number[], monitored = 1): Promise<void> {
    const id = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, status) VALUES ('movie', ?, ?, ?, 'missing')").run(title, title.toLowerCase(), monitored)).lastInsertRowid
    );
    for (const tag of tags) await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(id, tag);
  }
  async function tagIssues() {
    clearHealthReportCache();
    return (await getHealthReport({ refresh: true })).issues.filter((i) => i.source === "download-client-tags");
  }

  it("counts the monitored titles whose tags match no client when every client is scoped", async () => {
    await insertClient("Anime only", [tagA]);
    await insertTitle("Anime Show", [tagA]);
    await insertTitle("Kids Show", [tagB]);
    await insertTitle("Plain Film", []);
    await insertTitle("Unmonitored Kids", [tagB], 0);

    const issues = await tagIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("2 monitored title(s) have no download client that takes their tags, so nothing can be sent for them");
    expect(issues[0].severity).toBe("warning");
  });

  it("reports nothing once an unscoped client takes the rest", async () => {
    await insertClient("Anime only", [tagA]);
    await insertClient("Everything else", null);
    await insertTitle("Kids Show", [tagB]);
    await insertTitle("Plain Film", []);

    expect(await tagIssues()).toEqual([]);
  });

  it("reports nothing when no client is scoped to tags", async () => {
    await insertClient("Open", null);
    await insertTitle("Kids Show", [tagB]);

    expect(await tagIssues()).toEqual([]);
  });
});
