import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let backoff: typeof import("../src/services/searchBackoff.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  backoff = await import("../src/services/searchBackoff.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00Z");
const stored = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

describe("waitAfter", () => {
  it("steps from none to a day, three days and a week", () => {
    expect([0, 2, 3, 5, 6, 11, 12, 99].map((m) => backoff.waitAfter(m) / DAY)).toEqual([0, 0, 1, 1, 3, 3, 7, 7]);
    expect([0, 1, 2, 5, 6, 12].map((m) => backoff.waitAfter(m, backoff.SEASON_STEPS) / DAY)).toEqual([0, 0, 1, 1, 3, 7]);
  });
});

describe("parseStoredTime", () => {
  it("reads the database's UTC timestamps and ISO strings", () => {
    expect(backoff.parseStoredTime("2026-10-25 12:00:00")).toBe(NOW);
    expect(backoff.parseStoredTime("2026-10-25T12:00:00Z")).toBe(NOW);
    expect(backoff.parseStoredTime("2026-10-25T14:00:00+02:00")).toBe(NOW);
    expect(backoff.parseStoredTime(null)).toBeNull();
    expect(backoff.parseStoredTime("not a time")).toBeNull();
  });
});

describe("leafDue", () => {
  it("searches a target every time for its first few misses, then once a day, then less", () => {
    const at = (misses: number, ageMs: number) => backoff.leafDue({ auto_search_misses: misses, last_auto_searched_at: stored(NOW - ageMs) }, null, NOW);
    expect(at(0, 1000)).toBe(true);
    expect(at(2, 1000)).toBe(true);
    expect(at(3, 2 * 60 * 60 * 1000)).toBe(false);
    expect(at(3, DAY + 1000)).toBe(true);
    expect(at(8, 2 * DAY)).toBe(false);
    expect(at(8, 3 * DAY + 1000)).toBe(true);
    expect(at(40, 6 * DAY)).toBe(false);
    expect(at(40, 7 * DAY + 1000)).toBe(true);
  });

  it("searches a target never searched, and one that aired or came out in the last two weeks whatever it missed", () => {
    expect(backoff.leafDue({ auto_search_misses: 20, last_auto_searched_at: null }, null, NOW)).toBe(true);
    const recent = { auto_search_misses: 20, last_auto_searched_at: stored(NOW - 1000) };
    expect(backoff.leafDue(recent, "2026-10-20", NOW)).toBe(true);
    expect(backoff.leafDue(recent, "2026-09-01", NOW)).toBe(false);
    // A date in the future is not "recent".
    expect(backoff.leafDue(recent, "2026-11-20", NOW)).toBe(false);
  });

  it("is always due with the backoff switched off", () => {
    setSetting("searchBackoff", "0");
    try {
      expect(backoff.leafDue({ auto_search_misses: 50, last_auto_searched_at: stored(NOW - 1000) }, null, NOW)).toBe(true);
    } finally {
      setSetting("searchBackoff", "");
    }
  });
});

async function insertShow(title: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', ?, ?, 1, 0, 'missing')").run(title, title.toLowerCase())).lastInsertRowid);
}

describe("recording outcomes", () => {
  it("counts a search that grabbed nothing, and starts over after a grab", async () => {
    const show = await insertShow("Misses Show");
    const ep = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, 1, 1, 1, 0)").run(show)).lastInsertRowid);
    const misses = async () => Number(((await db.prepare("SELECT auto_search_misses FROM episodes WHERE id = ?").get(ep)) as any).auto_search_misses);

    await backoff.recordLeafOutcome("episodes", ep, false);
    await backoff.recordLeafOutcome("episodes", ep, false);
    expect(await misses()).toBe(2);
    await backoff.recordLeafOutcome("episodes", ep, true);
    expect(await misses()).toBe(0);
    await backoff.recordLeafOutcome("episodes", ep, false);
    await backoff.wakeLeaf("episodes", ep);
    expect(await misses()).toBe(0);
  });

  it("keeps a season's count apart and is due again after its wait", async () => {
    const show = await insertShow("Season Backoff");
    expect(await backoff.seasonSearchDue(show, 1)).toBe(true);
    await backoff.recordSeasonSearch(show, 1, false);
    expect(await backoff.seasonSearchDue(show, 1)).toBe(true); // the first two misses cost nothing
    await backoff.recordSeasonSearch(show, 1, false);
    expect(await backoff.seasonSearchDue(show, 1)).toBe(false);
    expect(await backoff.seasonSearchDue(show, 2)).toBe(true);
    expect(await backoff.seasonSearchDue(show, 1, Date.now() + DAY + 60_000)).toBe(true);
    await backoff.recordSeasonSearch(show, 1, true);
    expect(await backoff.seasonSearchDue(show, 1)).toBe(true);
    await backoff.recordSeasonSearch(show, 1, false);
    await backoff.recordSeasonSearch(show, 1, false);
    await backoff.wakeSeason(show, 1);
    expect(await backoff.seasonSearchDue(show, 1)).toBe(true);
  });

  it("starts the backoff over for one item and its children, or for everything", async () => {
    const a = await insertShow("Reset A");
    const b = await insertShow("Reset B");
    const epA = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, auto_search_misses) VALUES (?, 1, 1, 1, 0, 7)").run(a)).lastInsertRowid);
    const epB = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file, auto_search_misses) VALUES (?, 1, 1, 1, 0, 7)").run(b)).lastInsertRowid);
    await db.prepare("UPDATE media_items SET auto_search_misses = 5 WHERE id IN (?, ?)").run(a, b);
    await backoff.recordSeasonSearch(a, 1, false);
    const misses = async (id: number) => Number(((await db.prepare("SELECT auto_search_misses FROM episodes WHERE id = ?").get(id)) as any).auto_search_misses);

    await backoff.resetSearchBackoff(a);
    expect([await misses(epA), await misses(epB)]).toEqual([0, 7]);
    expect(Number(((await db.prepare("SELECT auto_search_misses FROM media_items WHERE id = ?").get(a)) as any).auto_search_misses)).toBe(0);
    expect(Number(((await db.prepare("SELECT auto_search_misses FROM media_items WHERE id = ?").get(b)) as any).auto_search_misses)).toBe(5);
    expect(await db.prepare("SELECT 1 AS x FROM season_searches WHERE media_item_id = ?").get(a)).toBeUndefined();

    await backoff.resetSearchBackoff();
    expect(await misses(epB)).toBe(0);
  });
});
