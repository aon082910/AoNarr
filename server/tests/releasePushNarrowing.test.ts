import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
}));

vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  notifyGrabbed: vi.fn(),
  notifyFailed: vi.fn(),
  notifyHealthIssue: vi.fn(),
  notifyManualInteractionRequired: vi.fn(),
  notifyUpdateAvailable: vi.fn(),
}));

/**
 * A pushed release is judged against the titles it can name, not the whole wanted library (M2): a release for a title the
 * library does not hold is answered without reading the library's episodes, and every answer is the one the whole library gives.
 */
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let judgeOneRelease: (typeof import("../src/services/rssSync.js"))["judgeOneRelease"];
let adapter: { addDownload: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn> };
let showId: number;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ judgeOneRelease } = await import("../src/services/rssSync.js"));
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("autoUpgradeEnabled", "1");
});

const insert = async (sql: string, ...params: unknown[]) => Number((await db.prepare(sql).run(...params)).lastInsertRowid);
const movie = (title: string, year: number, over: { monitored?: number; hasFile?: number; quality?: string | null } = {}) =>
  insert(
    "INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, quality, status) VALUES ('movie', ?, ?, ?, ?, ?, ?, 'missing')",
    title,
    title.toLowerCase(),
    year,
    over.monitored ?? 1,
    over.hasFile ?? 0,
    over.quality ?? null
  );

beforeEach(async () => {
  for (const t of ["history", "blocklist", "pending_releases", "rss_decisions", "queue", "delay_profiles", "episodes", "sub_items", "media_item_titles", "media_items", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  adapter = { addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: `id-${url.length}-${url.slice(-12)}` })), getStatus: vi.fn().mockResolvedValue([]) };
  getDownloadClientAdapter.mockReset().mockReturnValue(adapter);

  await insert("INSERT INTO download_clients (name, type, enabled) VALUES ('qbit', 'qbittorrent', 1)");
  await insert("INSERT INTO indexers (name, protocol, url, enabled, media_types) VALUES ('Idx', 'torznab', 'http://idx.example.com', 1, 'movie,series,anime,artist,author')");

  await movie("The Matrix", 1999);
  await movie("Blade Runner", 1982, { hasFile: 1, quality: "WEBDL-1080p" });
  const dune84 = await movie("Dune", 1984);
  await movie("Dune", 2021);
  await movie("Alien", 1979, { monitored: 0 });
  const lesMis = await movie("Les Misérables", 2012);
  // Two ways to be turned away besides naming nothing: a quality the profile does not allow, and a blocklisted release.
  const onlyBluray = await insert("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, 'Bluray-1080p')", `Only Bluray ${Math.random()}`, JSON.stringify(["Bluray-1080p"]));
  await db.prepare("UPDATE media_items SET quality_profile_id = ? WHERE id = ?").run(onlyBluray, lesMis);
  await db.prepare("INSERT INTO blocklist (media_item_id, release_title, reason) VALUES (?, ?, 'failed')").run(dune84, "Dune.1984.1080p.WEB-DL-GRP");
  showId = await insert("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Push Show', 'push show', 1, 0, 'missing')");
  await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, 1, 1, 'One', 1, 1, '2020-01-01')", showId);
  await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, 1, 2, 'Two', 1, 0, '2020-01-08')", showId);
  await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, 1, 3, 'Three', 1, 0, '2020-01-15')", showId);
  const titan = await insert("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('series', 'Shingeki no Kyojin', 'shingeki no kyojin', 1, 0, 'missing')");
  await insert("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, air_date) VALUES (?, 1, 1, 'To You', 1, 0, '2013-04-07')", titan);
  const { storeAliases } = await import("../src/services/releaseAliases.js");
  await storeAliases(titan, ["Attack on Titan"], "tmdb_alt");
  const artist = await insert("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist', 'Push Band', 'push band', 1, 0, 'missing')");
  await insert("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Second Record', 1, 0)", artist);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const release = (title: string) => ({
  indexerId: null,
  indexerName: "pushed",
  title,
  size: 5_000_000_000,
  seeders: null,
  leechers: null,
  publishDate: "2020-01-01T00:00:00.000Z",
  downloadUrl: `https://tracker.example/dl/${encodeURIComponent(title)}.torrent`,
  protocol: "torrent" as const,
  category: null,
  magnetUrl: null,
});

const RELEASES = [
  "The.Matrix.1999.1080p.WEB-DL-GRP",
  "The.Matrix.1999.720p.WEB-DL-GRP",
  "The.Matrix.2003.1080p.WEB-DL-GRP",
  "Blade.Runner.1982.1080p.BluRay.x264-GRP",
  "Dune.2021.1080p.WEB-DL-GRP",
  "Dune.1984.1080p.WEB-DL-GRP",
  "Dune.1080p.WEB-DL-GRP",
  "Alien.1979.1080p.WEB-DL-GRP",
  "Some.Unknown.Film.2012.1080p.WEB-DL-GRP",
  "Push.Show.S01E02.1080p.WEB-DL-GRP",
  "Push.Show.S01E01.1080p.WEB-DL-GRP",
  "Push.Show.S01E09.1080p.WEB-DL-GRP",
  "Push.Show.S01.1080p.WEB-DL-GRP",
  "Shingeki.no.Kyojin.S01E01.1080p.WEB-DL-GRP",
  "Attack.on.Titan.S01E01.1080p.WEB-DL-GRP",
  "Push Band - Second Record (2019) [FLAC]",
  "Push Band - Other Record (2020) [FLAC]",
  "Stranger Band - First Record (2001) [FLAC]",
  "a8f7d6c1e2b3d4e5f6a7b8c9d0e1f2a3",
  "Les.Miserables.2012.1080p.WEB-DL-GRP",
  "The.2020.1080p.WEB-DL-GRP",
];

/** What a judgement left behind is cleared, so the next one starts from the same library. */
async function reset() {
  for (const t of ["history", "pending_releases", "rss_decisions", "queue"]) await db.prepare(`DELETE FROM ${t}`).run();
}

describe("a pushed release is judged against the titles it can name", () => {
  it("gives the answer the whole wanted library gives, for every release, with and without an app's type limit", async () => {
    const outcomes = new Set<string>();
    for (const types of [undefined, ["movie"], ["series", "anime"], ["artist"]]) {
      for (const title of RELEASES) {
        const narrowed = await judgeOneRelease(release(title), { source: "push", types });
        await reset();
        const whole = await judgeOneRelease(release(title), { source: "push", types, narrow: false });
        await reset();
        expect(narrowed, `${title} ${JSON.stringify(types)}`).toEqual(whole);
        outcomes.add(narrowed.outcome);
      }
    }
    // The fixture is not trivial: releases are grabbed, refused and unmatched.
    expect(outcomes).toContain("grabbed");
    expect(outcomes).toContain("unmatched");
    expect(outcomes).toContain("rejected");
  });

  it("answers a release for a title the library does not hold without reading the library's episodes or items", async () => {
    const { initDb } = await import("../src/db/index.js");
    const prepare = vi.spyOn(await initDb(), "prepare");
    const result = await judgeOneRelease(release("Some.Unknown.Film.2012.1080p.WEB-DL-GRP"), { source: "push" });
    expect(result).toMatchObject({ outcome: "unmatched", temporary: false });
    expect(result.reasons[0]).toMatch(/no wanted title is named/);
    const sql = prepare.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /FROM episodes e JOIN media_items m/.test(s))).toBe(false);
    expect(sql.some((s) => /SELECT \* FROM media_items WHERE monitored = 1/.test(s))).toBe(false);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  it("answers a name with no title in it at once, as the whole library does", async () => {
    const { initDb } = await import("../src/db/index.js");
    const prepare = vi.spyOn(await initDb(), "prepare");
    const result = await judgeOneRelease(release("a8f7d6c1e2b3d4e5f6a7b8c9d0e1f2a3"), { source: "push" });
    expect(result).toMatchObject({ outcome: "unmatched" });
    expect(result.reasons[0]).toMatch(/hash/);
    expect(prepare.mock.calls.map((c) => String(c[0])).some((s) => /FROM episodes e JOIN media_items m/.test(s))).toBe(false);
  });

  it("reads only the episodes of the show a release names, and the whole library when it is not narrowed", async () => {
    const { initDb } = await import("../src/db/index.js");
    const prepare = vi.spyOn(await initDb(), "prepare");
    const result = await judgeOneRelease(release("Push.Show.S01E02.1080p.WEB-DL-GRP"), { source: "push" });
    expect(result.outcome).toBe("grabbed");
    const episodeReads = prepare.mock.calls.map((c) => String(c[0])).filter((s) => /FROM episodes e JOIN media_items m/.test(s));
    expect(episodeReads).toHaveLength(1);
    expect(episodeReads[0]).toMatch(/e\.media_item_id IN \(\?\)/);

    await reset();
    prepare.mockClear();
    await judgeOneRelease(release("Push.Show.S01E02.1080p.WEB-DL-GRP"), { source: "push", narrow: false });
    const whole = prepare.mock.calls.map((c) => String(c[0])).filter((s) => /FROM episodes e JOIN media_items m/.test(s));
    expect(whole).toHaveLength(1);
    expect(whole[0]).not.toMatch(/e\.media_item_id IN/);
  });

  it("finds a title by an alias it carries, and does not narrow a release that carries an id", async () => {
    const result = await judgeOneRelease(release("Attack.on.Titan.S01E01.1080p.WEB-DL-GRP"), { source: "push" });
    expect(result.outcome).toBe("grabbed");

    const { initDb } = await import("../src/db/index.js");
    await reset();
    const prepare = vi.spyOn(await initDb(), "prepare");
    // An id in the name names an item whatever the title says: the whole library is read for it.
    await judgeOneRelease(release("Some.Unknown.Film.2012.tt0133093.1080p.WEB-DL-GRP"), { source: "push" });
    expect(prepare.mock.calls.map((c) => String(c[0])).some((s) => /SELECT \* FROM media_items WHERE monitored = 1$/.test(s))).toBe(true);
  });
});
