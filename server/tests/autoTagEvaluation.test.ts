import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const searchMetadata = vi.fn();
const fetchByExternalId = vi.fn();
const fetchMovieByTmdbId = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/metadata.js")>();
  return {
    ...actual,
    searchMetadata: (...args: unknown[]) => searchMetadata(...args),
    fetchByExternalId: (...args: unknown[]) => fetchByExternalId(...args),
    fetchMovieByTmdbId: (...args: unknown[]) => fetchMovieByTmdbId(...args),
    fetchSeriesEpisodesFor: async () => [],
    fetchSeriesEpisodesForProvider: async () => [],
    fetchSeriesSeasonsFor: async () => [],
    fetchArtistAlbumsFor: async () => null,
    fetchCollectionChildrenFor: async () => ({ provider: null, children: [] }),
  };
});
// The metadata import route starts a background match against the other providers; nothing here may reach them.
vi.mock("../src/services/sceneNumbering.js", () => ({ syncSceneNumbering: async () => ({ updated: 0 }) }));

type AutoTag = typeof import("../src/services/autoTag.js");
let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let autoTag: AutoTag;
let setSetting: (key: string, value: string) => void;
let syncImportList: (typeof import("../src/services/importLists.js"))["syncImportList"];
let itemListKeys: (typeof import("../src/services/importLists.js"))["itemListKeys"];
let finishWantedAdd: (typeof import("../src/services/addDefaults.js"))["finishWantedAdd"];
let refreshOneMediaItem: (typeof import("../src/services/libraryScan.js"))["refreshOneMediaItem"];
let isJobBusy: (typeof import("../src/services/jobRegistry.js"))["isJobBusy"];
type ImportListRow = import("../src/services/importLists.js").ImportListRow;

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  autoTag = await import("../src/services/autoTag.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ syncImportList, itemListKeys } = await import("../src/services/importLists.js"));
  ({ finishWantedAdd } = await import("../src/services/addDefaults.js"));
  ({ refreshOneMediaItem } = await import("../src/services/libraryScan.js"));
  ({ isJobBusy } = await import("../src/services/jobRegistry.js"));
});

let tmpRoot: string;

beforeEach(async () => {
  for (const t of ["media_item_auto_tags", "auto_tag_rules", "media_item_tags", "episodes", "media_items", "tags", "import_list_entries", "import_lists", "root_folders", "quality_profiles"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  autoTag.invalidateAutoTagRules();
  searchMetadata.mockReset().mockResolvedValue([]);
  fetchByExternalId.mockReset().mockRejectedValue(new Error("not mocked"));
  fetchMovieByTmdbId.mockReset().mockResolvedValue({});
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-autotag-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSetting("traktClientId", "");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function tag(name: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO tags (name) VALUES (?)").run(name)).lastInsertRowid);
}

async function item(title: string, opts: { type?: string; genres?: string[]; ids?: Record<string, string>; sourceListId?: number } = {}): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, genres, external_ids, source_list_id, monitored, has_file, status)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'unknown')`
    )
    .run(opts.type ?? "movie", title, title.toLowerCase(), opts.genres ? JSON.stringify(opts.genres) : null, opts.ids ? JSON.stringify(opts.ids) : null, opts.sourceListId ?? null);
  return Number(result.lastInsertRowid);
}

async function tagsOf(itemId: number): Promise<string[]> {
  const rows = (await db
    .prepare("SELECT t.name AS name FROM media_item_tags mit JOIN tags t ON t.id = mit.tag_id WHERE mit.media_item_id = ? ORDER BY t.name")
    .all(itemId)) as { name: string }[];
  return rows.map((r) => r.name);
}

async function claimsOf(itemId: number): Promise<{ tag: number; rule: number }[]> {
  const rows = (await db.prepare("SELECT tag_id, rule_id FROM media_item_auto_tags WHERE media_item_id = ? ORDER BY tag_id, rule_id").all(itemId)) as { tag_id: number; rule_id: number }[];
  return rows.map((r) => ({ tag: Number(r.tag_id), rule: Number(r.rule_id) }));
}

const rule = (input: Parameters<AutoTag["createAutoTagRule"]>[0]) => autoTag.createAutoTagRule(input);

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The run has ended and the job registry has let go of it (a new run is refused until then). */
const jobIdle = () => waitFor(() => !isJobBusy(autoTag.AUTO_TAG_JOB), "the Auto Tagging job to end");

const facts = (type: string, genres: string[] = [], lists: number[] = []) => ({ type, genres: new Set(genres.map((g) => g.toLowerCase())), lists: new Set(lists) });

describe("conditions", () => {
  const base = { match: "any" as const, libraryTypes: [] as string[], genres: [] as string[], listIds: [] as number[] };

  it("a library type condition holds for a title of one of those types", () => {
    const r = { ...base, libraryTypes: ["movie", "series"] };
    expect(autoTag.ruleMatches(r, facts("movie"))).toBe(true);
    expect(autoTag.ruleMatches(r, facts("series"))).toBe(true);
    expect(autoTag.ruleMatches(r, facts("artist"))).toBe(false);
  });

  it("genres are compared without regard to case and any one of them is enough", () => {
    const r = { ...base, genres: ["Anime", "Animation"] };
    expect(autoTag.ruleMatches(r, facts("movie", ["animation", "Family"]))).toBe(true);
    expect(autoTag.ruleMatches(r, facts("movie", ["ANIME"]))).toBe(true);
    expect(autoTag.ruleMatches(r, facts("movie", ["Drama"]))).toBe(false);
    expect(autoTag.ruleMatches(r, facts("movie", []))).toBe(false);
  });

  it("a list condition holds for a title the list added or holds", () => {
    const r = { ...base, listIds: [4, 9] };
    expect(autoTag.ruleMatches(r, facts("movie", [], [9]))).toBe(true);
    expect(autoTag.ruleMatches(r, facts("movie", [], [5]))).toBe(false);
  });

  it("'any' needs one condition to hold, 'all' needs every condition the rule has", () => {
    const any = { ...base, libraryTypes: ["movie"], genres: ["Horror"] };
    const all = { ...any, match: "all" as const };
    expect(autoTag.ruleMatches(any, facts("movie", ["Comedy"]))).toBe(true);
    expect(autoTag.ruleMatches(all, facts("movie", ["Comedy"]))).toBe(false);
    expect(autoTag.ruleMatches(all, facts("movie", ["horror"]))).toBe(true);
    expect(autoTag.ruleMatches(all, facts("series", ["horror"]))).toBe(false);
  });

  it("a rule with no condition at all matches nothing", () => {
    expect(autoTag.ruleMatches(base, facts("movie", ["Horror"], [1]))).toBe(false);
    expect(autoTag.ruleMatches({ ...base, match: "all" as const }, facts("movie"))).toBe(false);
  });

  it("the list keys agree with the ones import lists record", () => {
    const samples = [
      { type: "movie", title: "A", external_ids: JSON.stringify({ tmdb: "12", imdb: "tt1" }) },
      { type: "series", title: "B", external_ids: JSON.stringify({ tmdb: "7" }) },
      { type: "artist", title: "Some Band", external_ids: null },
      { type: "movie", title: "C", external_ids: "not json" },
    ];
    for (const s of samples) expect(autoTag.listKeysOfItem(s)).toEqual(itemListKeys(s));
  });
});

describe("planning", () => {
  const mk = (over: Partial<import("../src/services/autoTag.js").AutoTagRule> & { id: number }): import("../src/services/autoTag.js").AutoTagRule => ({
    name: `rule ${over.id}`,
    enabled: true,
    match: "any",
    libraryTypes: [],
    genres: [],
    listIds: [],
    tagIds: [],
    removeWhenUnmatched: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  });

  it("gives a matching title the tags it lacks and records the claim", () => {
    const { ops } = autoTag.planItem([mk({ id: 1, libraryTypes: ["movie"], tagIds: [10, 11] })], facts("movie"), { tags: new Set([11]), owners: new Map() });
    expect(ops).toEqual([{ kind: "add", tagId: 10, ruleId: 1 }]);
  });

  it("does not take over a tag the title had already, and never removes it", () => {
    const rules = [mk({ id: 1, libraryTypes: ["movie"], tagIds: [10], removeWhenUnmatched: true })];
    const state = { tags: new Set([10]), owners: new Map() };
    expect(autoTag.planItem(rules, facts("movie"), state).ops).toEqual([]);
    expect(autoTag.planItem(rules, facts("series"), state).ops).toEqual([]);
  });

  it("removes a tag only the rule that gave it takes back, and only when the title stops matching", () => {
    const rules = [mk({ id: 1, genres: ["Horror"], tagIds: [10], removeWhenUnmatched: true })];
    const state = { tags: new Set([10, 20]), owners: new Map([[10, new Set([1])]]) };
    expect(autoTag.planItem(rules, facts("movie", ["Horror"]), state).ops).toEqual([]);
    expect(autoTag.planItem(rules, facts("movie", ["Comedy"]), state).ops).toEqual([
      { kind: "release", tagId: 10, ruleId: 1 },
      { kind: "remove", tagId: 10 },
    ]);
  });

  it("a rule without remove_when_unmatched leaves its tags alone", () => {
    const rules = [mk({ id: 1, genres: ["Horror"], tagIds: [10] })];
    const state = { tags: new Set([10]), owners: new Map([[10, new Set([1])]]) };
    expect(autoTag.planItem(rules, facts("movie", ["Comedy"]), state).ops).toEqual([]);
  });

  it("two rules that give one tag share it: it goes when the last of them lets go", () => {
    const rules = [
      mk({ id: 1, genres: ["Horror"], tagIds: [10], removeWhenUnmatched: true }),
      mk({ id: 2, libraryTypes: ["movie"], tagIds: [10], removeWhenUnmatched: true }),
    ];
    const state = { tags: new Set([10]), owners: new Map([[10, new Set([1])]]) };
    expect(autoTag.planItem(rules, facts("movie", ["Horror"]), state).ops).toEqual([{ kind: "share", tagId: 10, ruleId: 2 }]);
    const shared = { tags: new Set([10]), owners: new Map([[10, new Set([1, 2])]]) };
    expect(autoTag.planItem(rules, facts("movie", ["Comedy"]), shared).ops).toEqual([{ kind: "release", tagId: 10, ruleId: 1 }]);
    expect(autoTag.planItem(rules, facts("series", ["Comedy"]), shared).ops).toEqual([
      { kind: "release", tagId: 10, ruleId: 1 },
      { kind: "release", tagId: 10, ruleId: 2 },
      { kind: "remove", tagId: 10 },
    ]);
  });

  it("a claim on a tag the title no longer has is dropped", () => {
    const { ops } = autoTag.planItem([], facts("movie"), { tags: new Set(), owners: new Map([[10, new Set([1])]]) });
    expect(ops).toEqual([{ kind: "release", tagId: 10, ruleId: 1 }]);
  });

  it("a rule that cannot be evaluated does not stop the others", () => {
    const broken = mk({ id: 1, genres: [123 as unknown as string], tagIds: [10] });
    const good = mk({ id: 2, libraryTypes: ["movie"], tagIds: [11] });
    const { ops, matched } = autoTag.planItem([broken, good], facts("movie"), { tags: new Set(), owners: new Map() });
    expect(ops).toEqual([{ kind: "add", tagId: 11, ruleId: 2 }]);
    expect([...matched]).toEqual([2]);
  });
});

describe("evaluating a title", () => {
  it("adds the tags of the rules that match, records which rule gave them, and a second look changes nothing", async () => {
    const kids = await tag("kids");
    const horror = await tag("scary");
    const r1 = await rule({ name: "Animation", genres: ["animation"], tagIds: [kids] });
    await rule({ name: "Horror", genres: ["Horror"], tagIds: [horror] });
    const cartoon = await item("Cartoon", { genres: ["Animation", "Family"] });

    expect(await autoTag.evaluateRulesForItem(cartoon)).toEqual({ added: 1, removed: 0 });
    expect(await tagsOf(cartoon)).toEqual(["kids"]);
    expect(await claimsOf(cartoon)).toEqual([{ tag: kids, rule: r1.id }]);

    expect(await autoTag.evaluateRulesForItem(cartoon)).toEqual({ added: 0, removed: 0 });
    expect(await tagsOf(cartoon)).toEqual(["kids"]);
  });

  it("does nothing for a switched-off rule", async () => {
    const t = await tag("off");
    await rule({ name: "Off", enabled: false, libraryTypes: ["movie"], tagIds: [t] });
    const m = await item("Some Movie");
    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 0, removed: 0 });
    expect(await tagsOf(m)).toEqual([]);
  });

  it("a tag the admin already set by hand is not taken over, so the rule never removes it", async () => {
    const t = await tag("mine");
    await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t], removeWhenUnmatched: true });
    const m = await item("Hand Tagged", { type: "movie" });
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(m, t);

    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 0, removed: 0 });
    expect(await claimsOf(m)).toEqual([]);

    await db.prepare("UPDATE media_items SET type = 'series' WHERE id = ?").run(m);
    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 0, removed: 0 });
    expect(await tagsOf(m)).toEqual(["mine"]);
  });

  it("takes back a tag it gave once the title stops matching, and only that one", async () => {
    const auto = await tag("auto");
    const manual = await tag("manual");
    await rule({ name: "Horror", genres: ["Horror"], tagIds: [auto], removeWhenUnmatched: true });
    const m = await item("Slasher", { genres: ["Horror"] });
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(m, manual);

    await autoTag.evaluateRulesForItem(m);
    expect(await tagsOf(m)).toEqual(["auto", "manual"]);

    await db.prepare("UPDATE media_items SET genres = ? WHERE id = ?").run(JSON.stringify(["Comedy"]), m);
    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 0, removed: 1 });
    expect(await tagsOf(m)).toEqual(["manual"]);
    expect(await claimsOf(m)).toEqual([]);
  });

  it("without remove_when_unmatched a tag stays after the title stops matching", async () => {
    const auto = await tag("stays");
    await rule({ name: "Horror", genres: ["Horror"], tagIds: [auto] });
    const m = await item("Slasher", { genres: ["Horror"] });
    await autoTag.evaluateRulesForItem(m);
    await db.prepare("UPDATE media_items SET genres = ? WHERE id = ?").run(JSON.stringify(["Comedy"]), m);

    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 0, removed: 0 });
    expect(await tagsOf(m)).toEqual(["stays"]);
  });

  it("a tag the admin sets by hand after a rule added it is theirs from then on", async () => {
    const t = await tag("both");
    await rule({ name: "Horror", genres: ["Horror"], tagIds: [t], removeWhenUnmatched: true });
    const m = await item("Slasher", { genres: ["Horror"] });
    await autoTag.evaluateRulesForItem(m);
    expect(await claimsOf(m)).toHaveLength(1);

    // The same call the tag picker on the title makes.
    await authed(request(app).post(`/api/media/${m}/tags`)).send({ tagId: t }).expect(201);
    expect(await claimsOf(m)).toEqual([]);

    await db.prepare("UPDATE media_items SET genres = ? WHERE id = ?").run(JSON.stringify(["Comedy"]), m);
    await autoTag.evaluateRulesForItem(m);
    expect(await tagsOf(m)).toEqual(["both"]);
  });

  it("the bulk tag action also takes the claim away", async () => {
    const t = await tag("bulk");
    await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t], removeWhenUnmatched: true });
    const a = await item("A");
    const b = await item("B");
    await autoTag.evaluateRulesForItem(a);
    await autoTag.evaluateRulesForItem(b);

    await authed(request(app).post("/api/media/bulk/tag")).send({ mediaItemIds: [a, b], tagId: t }).expect(200);

    expect(await claimsOf(a)).toEqual([]);
    expect(await claimsOf(b)).toEqual([]);
  });

  it("a tag taken off by hand is given again while the rule still matches, and claimed again", async () => {
    const t = await tag("again");
    const r = await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });
    const m = await item("Movie");
    await autoTag.evaluateRulesForItem(m);

    await authed(request(app).delete(`/api/media/${m}/tags/${t}`)).expect(204);
    expect(await tagsOf(m)).toEqual([]);
    expect(await claimsOf(m)).toEqual([]);

    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 1, removed: 0 });
    expect(await claimsOf(m)).toEqual([{ tag: t, rule: r.id }]);
  });

  it("two rules for one tag keep it until neither matches", async () => {
    const t = await tag("shared");
    await rule({ name: "Horror", genres: ["Horror"], tagIds: [t], removeWhenUnmatched: true });
    await rule({ name: "Series", libraryTypes: ["series"], tagIds: [t], removeWhenUnmatched: true });
    const m = await item("Horror Show", { type: "series", genres: ["Horror"] });
    await autoTag.evaluateRulesForItem(m);
    expect((await claimsOf(m)).length).toBe(2);

    await db.prepare("UPDATE media_items SET genres = ? WHERE id = ?").run(JSON.stringify(["Comedy"]), m);
    await autoTag.evaluateRulesForItem(m);
    expect(await tagsOf(m)).toEqual(["shared"]);

    await db.prepare("UPDATE media_items SET type = 'movie' WHERE id = ?").run(m);
    await autoTag.evaluateRulesForItem(m);
    expect(await tagsOf(m)).toEqual([]);
  });

  it("a rule that is switched off lets go of its tags, which stay as plain tags", async () => {
    const t = await tag("plain");
    const r = await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t], removeWhenUnmatched: true });
    const m = await item("Movie");
    await autoTag.evaluateRulesForItem(m);
    expect(await claimsOf(m)).toHaveLength(1);

    await autoTag.updateAutoTagRule(r.id, { enabled: false });
    expect(await claimsOf(m)).toEqual([]);

    await db.prepare("UPDATE media_items SET type = 'series' WHERE id = ?").run(m);
    await autoTag.evaluateRulesForItem(m);
    expect(await tagsOf(m)).toEqual(["plain"]);
  });

  it("a deleted rule leaves its tags on the titles as plain tags, and the tag can then be deleted", async () => {
    const t = await tag("orphan");
    const r = await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t], removeWhenUnmatched: true });
    const m = await item("Movie");
    await autoTag.evaluateRulesForItem(m);

    expect(await autoTag.deleteAutoTagRule(r.id)).toBe(true);
    expect(await tagsOf(m)).toEqual(["orphan"]);
    expect(await claimsOf(m)).toEqual([]);

    await authed(request(app).delete(`/api/tags/${t}`)).expect(204);
    expect(await tagsOf(m)).toEqual([]);
  });

  it("a rule on the import lists matches a title the list added or holds", async () => {
    const t = await tag("from-list");
    const list = Number((await db.prepare("INSERT INTO import_lists (name, type, url) VALUES ('Watch', 'trakt', 'u')").run()).lastInsertRowid);
    await rule({ name: "From list", listIds: [list], tagIds: [t] });
    const added = await item("Added", { sourceListId: list });
    const held = await item("Held", { ids: { tmdb: "555" } });
    const other = await item("Other", { ids: { tmdb: "556" } });
    await db.prepare("INSERT INTO import_list_entries (list_id, entry_key) VALUES (?, ?)").run(list, "movie:tmdb:555");

    for (const id of [added, held, other]) await autoTag.evaluateRulesForItem(id);

    expect(await tagsOf(added)).toEqual(["from-list"]);
    expect(await tagsOf(held)).toEqual(["from-list"]);
    expect(await tagsOf(other)).toEqual([]);
  });

  it("never throws into the add that called it, whatever fails", async () => {
    const t = await tag("safe");
    await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });
    const m = await item("Movie");
    await db.exec("ALTER TABLE media_item_auto_tags RENAME TO media_item_auto_tags_moved");
    try {
      await expect(autoTag.evaluateRulesForItem(m)).resolves.toEqual({ added: 0, removed: 0 });
      await expect(finishWantedAdd(m)).resolves.toBeUndefined();
    } finally {
      await db.exec("ALTER TABLE media_item_auto_tags_moved RENAME TO media_item_auto_tags");
    }
    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 1, removed: 0 });
  });

  it("a tag that was deleted behind the rule's back is skipped, the other tags still go on", async () => {
    const live = await tag("live");
    const gone = await tag("gone");
    await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [gone, live] });
    await db.prepare("DELETE FROM tags WHERE id = ?").run(gone);
    autoTag.invalidateAutoTagRules();
    const m = await item("Movie");
    expect(await autoTag.evaluateRulesForItem(m)).toEqual({ added: 1, removed: 0 });
    expect(await tagsOf(m)).toEqual(["live"]);
  });
});

describe("where the rules run", () => {
  async function rootFolders(): Promise<void> {
    const profile = Number((await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES ('P', '[\"SD\"]', 'SD')").run()).lastInsertRowid);
    expect(profile).toBeGreaterThan(0);
    for (const type of ["movie", "series"]) {
      const dir = fs.mkdtempSync(path.join(tmpRoot, `${type}-`));
      await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, type);
    }
  }

  it("finishWantedAdd, the one step every list, watchlist, request and webhook add ends with", async () => {
    const t = await tag("added");
    await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });
    const m = await item("Fresh Add");
    await finishWantedAdd(m);
    expect(await tagsOf(m)).toEqual(["added"]);
  });

  it("the Add route", async () => {
    await rootFolders();
    const t = await tag("route");
    await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });

    const res = await authed(request(app).post("/api/media")).send({ type: "movie", title: "Route Film", year: 2020, externalIds: { tmdb: "9001" }, confirmDuplicate: true });

    expect(res.status).toBe(201);
    expect(await tagsOf(res.body.id)).toEqual(["route"]);
  });

  it("the metadata import route, with the genres it carries", async () => {
    await rootFolders();
    const t = await tag("meta");
    await rule({ name: "Scary", genres: ["Horror"], tagIds: [t] });

    const res = await authed(request(app).post("/api/metadata/import")).send({
      type: "movie",
      title: "Meta Film",
      year: 2021,
      externalIds: { tmdb: "9002" },
      genres: ["Horror", "Thriller"],
      confirmDuplicate: true,
    });

    expect(res.status).toBe(201);
    expect(await tagsOf(res.body.id)).toEqual(["meta"]);
  });

  it("a metadata refresh, which can change the genres", async () => {
    const t = await tag("refreshed");
    await rule({ name: "Animation", genres: ["Animation"], tagIds: [t], removeWhenUnmatched: true });
    const m = await item("Old Cartoon", { ids: { tmdb: "100" } });
    fetchByExternalId.mockResolvedValue({ title: "Old Cartoon", year: 2001, genres: ["Animation"], externalIds: { tmdb: "100" } });

    expect((await refreshOneMediaItem(m)).ok).toBe(true);
    expect(await tagsOf(m)).toEqual(["refreshed"]);

    // The provider drops the genre: the next refresh takes the tag back.
    fetchByExternalId.mockResolvedValue({ title: "Old Cartoon", year: 2001, genres: ["Drama"], externalIds: { tmdb: "100" } });
    expect((await refreshOneMediaItem(m)).ok).toBe(true);
    expect(await tagsOf(m)).toEqual([]);
  });

  describe("an import list sync", () => {
    async function list(): Promise<ImportListRow> {
      const result = await db.prepare("INSERT INTO import_lists (name, type, url, enabled) VALUES ('Trakt picks', 'trakt', 'https://trakt.tv/users/t/lists/l', 1)").run();
      return (await db.prepare("SELECT * FROM import_lists WHERE id = ?").get(Number(result.lastInsertRowid))) as ImportListRow;
    }
    const traktReturns = (movies: { title: string; tmdb: number }[]) => {
      setSetting("traktClientId", "test-client");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => movies.map((m) => ({ movie: { title: m.title, year: 2024, ids: { tmdb: m.tmdb, trakt: m.tmdb } } })) })
      );
    };

    it("tags the titles the list adds and the ones it holds that were in the library already, and takes the tag off a held one that left", async () => {
      await rootFolders();
      const l = await list();
      const t = await tag("trakt");
      await rule({ name: "On the list", listIds: [l.id], tagIds: [t], removeWhenUnmatched: true });
      const existing = await item("Existing", { ids: { tmdb: "8301" } });
      const unrelated = await item("Unrelated", { ids: { tmdb: "8399" } });
      traktReturns([
        { title: "Existing", tmdb: 8301 },
        { title: "Brand New", tmdb: 8302 },
      ]);

      expect((await syncImportList(l)).added).toBe(1);

      const brandNew = (await db.prepare("SELECT id FROM media_items WHERE title = 'Brand New'").get()) as { id: number };
      expect(await tagsOf(Number(brandNew.id))).toEqual(["trakt"]);
      expect(await tagsOf(existing)).toEqual(["trakt"]);
      expect(await tagsOf(unrelated)).toEqual([]);

      // The list stops holding "Existing"; "Brand New" was added by it and keeps matching.
      traktReturns([{ title: "Brand New", tmdb: 8302 }]);
      await syncImportList(l);
      expect(await tagsOf(existing)).toEqual([]);
      expect(await tagsOf(Number(brandNew.id))).toEqual(["trakt"]);
    });

    it("costs nothing when no rule names the list", async () => {
      await rootFolders();
      const l = await list();
      const t = await tag("elsewhere");
      const other = Number((await db.prepare("INSERT INTO import_lists (name, type, url) VALUES ('Other', 'trakt', 'u')").run()).lastInsertRowid);
      await rule({ name: "Other list", listIds: [other], tagIds: [t] });
      const existing = await item("Existing", { ids: { tmdb: "8401" } });
      traktReturns([{ title: "Existing", tmdb: 8401 }]);

      await syncImportList(l);

      expect(await tagsOf(existing)).toEqual([]);
    });
  });
});

describe("a preview and applying a rule to the library", () => {
  async function library(n: number, type = "movie"): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(await item(`Title ${type} ${i}`, { type, genres: i % 2 === 0 ? ["Horror"] : ["Comedy"] }));
    return ids;
  }

  it("a preview counts and names examples and writes nothing", async () => {
    const t = await tag("preview");
    const r = await rule({ name: "Horror", genres: ["Horror"], tagIds: [t] });
    await library(30);

    const preview = await autoTag.previewAutoTagRule(r);

    expect(preview).toMatchObject({ scanned: 30, matching: 15, itemsGaining: 15, itemsLosing: 0, tagsAdded: 15, cancelled: false });
    expect(preview.samples).toHaveLength(15);
    expect(preview.samples[0]).toMatchObject({ adds: ["preview"], removes: [] });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM media_item_tags").get()) as { c: number }).toMatchObject({ c: 0 });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM media_item_auto_tags").get()) as { c: number }).toMatchObject({ c: 0 });
  });

  it("a preview shows no more than 20 examples", async () => {
    const t = await tag("many");
    const r = await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });
    await library(45);
    const preview = await autoTag.previewAutoTagRule(r);
    expect(preview.itemsGaining).toBe(45);
    expect(preview.samples).toHaveLength(20);
  });

  it("a preview of a switched-off rule shows what switching it on would do", async () => {
    const t = await tag("dormant");
    const r = await rule({ name: "Dormant", enabled: false, libraryTypes: ["movie"], tagIds: [t] });
    await library(4);
    expect((await autoTag.previewAutoTagRule(r)).itemsGaining).toBe(4);
  });

  it("Apply tags the library as a tracked job and reports counts; running it again changes nothing", async () => {
    const t = await tag("applied");
    const r = await rule({ name: "Horror", genres: ["Horror"], tagIds: [t] });
    const ids = await library(450); // more than one chunk

    expect(await autoTag.startAutoTagApply(r)).toEqual({ started: true });
    await waitFor(() => autoTag.lastApplyOf(r.id)?.finishedAt != null, "the apply job");
    await jobIdle();

    expect(autoTag.lastApplyOf(r.id)).toMatchObject({ ruleId: r.id, total: 450, scanned: 450, matching: 225, itemsGaining: 225, tagsAdded: 225, tagsRemoved: 0, cancelled: false, error: null });
    expect(await tagsOf(ids[0])).toEqual(["applied"]);
    expect(await tagsOf(ids[1])).toEqual([]);

    const firstRun = autoTag.lastApplyOf(r.id);
    expect(await autoTag.startAutoTagApply(r)).toEqual({ started: true });
    await waitFor(() => autoTag.lastApplyOf(r.id) !== firstRun && autoTag.lastApplyOf(r.id)?.finishedAt != null, "the second apply");
    await jobIdle();
    expect(autoTag.lastApplyOf(r.id)).toMatchObject({ scanned: 450, tagsAdded: 0, itemsGaining: 0 });
  });

  it("does not start a second run while one is going", async () => {
    const t = await tag("busy");
    const r = await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });
    await library(450);
    expect(await autoTag.startAutoTagApply(r)).toEqual({ started: true });
    expect(await autoTag.startAutoTagApply(r)).toEqual({ started: false, reason: "already-running" });
    await waitFor(() => autoTag.lastApplyOf(r.id)?.finishedAt != null, "the apply job");
    await jobIdle();
  });

  it("can be cancelled between chunks and finished by running it again, adding nothing twice", async () => {
    const t = await tag("resumed");
    const r = await rule({ name: "Movies", libraryTypes: ["movie"], tagIds: [t] });
    await library(450);
    const controller = new AbortController();

    const first = await autoTag.runAutoTag({ rules: [r], signal: controller.signal, onProgress: () => controller.abort() });
    expect(first.cancelled).toBe(true);
    expect(first.scanned).toBe(200);
    expect(first.tagsAdded).toBe(200);

    const second = await autoTag.runAutoTag({ rules: [r] });
    expect(second.cancelled).toBe(false);
    expect(second.scanned).toBe(450);
    expect(second.tagsAdded).toBe(250);
    expect((await db.prepare("SELECT COUNT(*) AS c FROM media_item_tags WHERE tag_id = ?").get(t)) as { c: number }).toMatchObject({ c: 450 });
  });

  it("with remove_when_unmatched an apply takes back what no longer fits", async () => {
    const t = await tag("trim");
    const r = await rule({ name: "Horror", genres: ["Horror"], tagIds: [t], removeWhenUnmatched: true });
    const ids = await library(10);
    await autoTag.runAutoTag({ rules: [r] });
    await db.prepare("UPDATE media_items SET genres = ? WHERE id = ?").run(JSON.stringify(["Comedy"]), ids[0]);

    const preview = await autoTag.previewAutoTagRule(r);
    expect(preview).toMatchObject({ itemsLosing: 1, tagsRemoved: 1, itemsGaining: 0 });
    expect(preview.samples[0]).toMatchObject({ id: ids[0], removes: ["trim"] });
    expect(await tagsOf(ids[0])).toEqual(["trim"]);

    const run = await autoTag.runAutoTag({ rules: [r] });
    expect(run.tagsRemoved).toBe(1);
    expect(await tagsOf(ids[0])).toEqual([]);
  });
});
