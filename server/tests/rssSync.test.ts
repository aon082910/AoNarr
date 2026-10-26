import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const fetchRecentReleases = vi.fn();
vi.mock("../src/services/indexerClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  fetchRecentReleases: (...args: unknown[]) => fetchRecentReleases(...args),
}));

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

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let runRssSync: (typeof import("../src/services/rssSync.js"))["runRssSync"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ runRssSync } = await import("../src/services/rssSync.js"));
});

beforeEach(async () => {
  for (const t of ["history", "blocklist", "queue", "delay_profiles", "episodes", "media_items", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  fetchRecentReleases.mockReset().mockResolvedValue({ results: [], newest: null });
  getDownloadClientAdapter.mockReset().mockReturnValue(urlKeyedAdapter());
  setSetting("autoUpgradeEnabled", "0");
});

function urlKeyedAdapter() {
  return { addDownload: vi.fn(async (_client: unknown, url: string) => ({ downloadId: url })), getStatus: vi.fn().mockResolvedValue([]) };
}

async function insertClient(): Promise<number> {
  return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Test Client', 'qbittorrent', 1)").run()).lastInsertRowid);
}

async function insertIndexer(over: { name?: string; protocol?: string; enabled?: number; mediaTypes?: string } = {}): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO indexers (name, protocol, url, enabled, media_types) VALUES (?, ?, 'http://idx.example.com', ?, ?)")
        .run(over.name ?? "Idx", over.protocol ?? "torznab", over.enabled ?? 1, over.mediaTypes ?? "movie,series,anime")
    ).lastInsertRowid
  );
}

async function insertProfile(allowed: string[], cutoff: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)").run(`Profile ${Math.random()}`, JSON.stringify(allowed), cutoff))
      .lastInsertRowid
  );
}

async function insertMovie(over: { title?: string; year?: number; hasFile?: number; quality?: string | null; profileId?: number | null } = {}): Promise<number> {
  const title = over.title ?? "The Matrix";
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, quality, quality_profile_id, status) VALUES ('movie', ?, ?, ?, 1, ?, ?, ?, 'missing')")
        .run(title, title.toLowerCase(), over.year ?? 1999, over.hasFile ?? 0, over.quality ?? null, over.profileId ?? null)
    ).lastInsertRowid
  );
}

async function insertSeries(title: string, seriesType: string | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, series_type, status) VALUES ('series', ?, ?, 1, 0, ?, 'missing')")
        .run(title, title.toLowerCase(), seriesType)
    ).lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number, over: { airDate?: string | null; quality?: string | null } = {}): Promise<number> {
  const quality = over.quality ?? null;
  return Number(
    (
      await db
        .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, quality, air_date) VALUES (?, ?, ?, 'Ep', 1, ?, ?, ?)")
        .run(showId, season, episode, quality ? 1 : 0, quality, over.airDate === undefined ? "2020-01-01" : over.airDate)
    ).lastInsertRowid
  );
}

function release(title: string, indexerId: number | null, over: Record<string, unknown> = {}): any {
  return {
    indexerId,
    indexerName: "Idx",
    title,
    size: 5_000_000_000,
    seeders: 100,
    leechers: 10,
    publishDate: "2020-01-01T00:00:00Z",
    downloadUrl: "magnet:?xt=" + title,
    protocol: "torrent",
    category: null,
    ...over,
  };
}

/** The feed of each category group (2000 movies, 5000 series), newest release first; `newest` is the first. */
function feeds(byCats: Record<string, any[]>) {
  fetchRecentReleases.mockImplementation(async (_indexer: unknown, group: { cats: string }) => {
    const results = byCats[group.cats] ?? [];
    return { results, newest: results[0] ? { url: results[0].downloadUrl, at: results[0].publishDate } : null };
  });
}

const queueRows = async (): Promise<any[]> =>
  (await db.prepare("SELECT media_item_id, episode_id, season_number, title, grab_source FROM queue ORDER BY id").all()) as any[];

describe("runRssSync", () => {
  it("reads nothing without an enabled download client or when nothing is wanted", async () => {
    await insertIndexer();
    await insertMovie();
    expect(await runRssSync()).toEqual({ releases: 0, grabbed: 0, woken: 0 });
    expect(fetchRecentReleases).not.toHaveBeenCalled();

    await insertClient();
    await db.prepare("UPDATE media_items SET has_file = 1, quality = 'WEBDL-1080p'").run();
    expect(await runRssSync()).toEqual({ releases: 0, grabbed: 0, woken: 0 });
    expect(fetchRecentReleases).not.toHaveBeenCalled();
  });

  it("grabs a new release for a missing movie, records it as an RSS grab, and saves where the feed was read to", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const movieId = await insertMovie();
    const wanted = release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId);
    feeds({ "2000": [wanted, release("Some.Other.Film.2012.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toEqual({ releases: 2, grabbed: 1, woken: 0 });

    expect(await queueRows()).toEqual([{ media_item_id: movieId, episode_id: null, season_number: null, title: wanted.title, grab_source: "rss" }]);
    const marker = (await db.prepare("SELECT feed_key, last_seen_url, last_seen_at FROM rss_sync_state WHERE indexer_id = ?").get(indexerId)) as any;
    expect(marker).toEqual({ feed_key: "2000", last_seen_url: wanted.downloadUrl, last_seen_at: wanted.publishDate });
  });

  it("reads each feed back to the marker it saved, keeps the marker of an empty read, and grabs nothing twice", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await insertMovie();
    const wanted = release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId);
    feeds({ "2000": [wanted] });
    await runRssSync();
    expect(fetchRecentReleases.mock.calls[0][2]).toBeNull();

    await runRssSync();
    expect(fetchRecentReleases.mock.calls[1][2]).toEqual({ url: wanted.downloadUrl, at: wanted.publishDate });
    expect((await queueRows()).length).toBe(1);

    feeds({});
    await runRssSync();
    const marker = (await db.prepare("SELECT last_seen_url FROM rss_sync_state WHERE indexer_id = ?").get(indexerId)) as any;
    expect(marker.last_seen_url).toBe(wanted.downloadUrl);
  });

  it("grabs nothing for a movie that is not wanted, and not for a different film that shares a word", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await insertMovie({ hasFile: 1, quality: "WEBDL-1080p" });
    await insertMovie({ title: "Heat", year: 1995 });
    feeds({ "2000": [release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId), release("Heat.Wave.2005.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ releases: 2, grabbed: 0 });
    expect(await queueRows()).toEqual([]);
  });

  it("grabs an episode release for the episode it names and no other", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Rss Show");
    await insertEpisode(showId, 1, 1);
    const two = await insertEpisode(showId, 1, 2);
    feeds({ "5000": [release("Rss.Show.S01E02.1080p.WEB-DL-GRP", indexerId), release("Rss.Show.S02E01.1080p.WEB-DL-GRP", indexerId), release("Other.Show.S01E01.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ releases: 3, grabbed: 1 });

    expect(await queueRows()).toEqual([{ media_item_id: showId, episode_id: two, season_number: null, title: "Rss.Show.S01E02.1080p.WEB-DL-GRP", grab_source: "rss" }]);
  });

  it("grabs a date-named release for a daily show's episode of that day", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Daily Show", "daily");
    await insertEpisode(showId, 2025, 101, { airDate: "2025-03-13" });
    const today = await insertEpisode(showId, 2025, 102, { airDate: "2025-03-14" });
    feeds({ "5000": [release("Daily.Show.2025.03.14.1080p.WEB-DL-GRP", indexerId)] });

    await runRssSync();

    expect((await queueRows()).map((r) => r.episode_id)).toEqual([today]);
  });

  it("grabs a season pack for the season it names when the season is finished and wanted, against the whole season", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Pack Show");
    for (let n = 1; n <= 3; n++) await insertEpisode(showId, 1, n);
    feeds({ "5000": [release("Pack.Show.S01.1080p.WEB-DL-GRP", indexerId), release("Pack.Show.S01E02.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ grabbed: 1 });

    // The episode release is not grabbed on top of the pack that covers it.
    expect(await queueRows()).toEqual([{ media_item_id: showId, episode_id: null, season_number: 1, title: "Pack.Show.S01.1080p.WEB-DL-GRP", grab_source: "rss" }]);
  });

  it("passes a pack over for the single episode when it would fill one episode of ten", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const profileId = await insertProfile(["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p");
    const showId = await insertSeries("Almost Done");
    await db.prepare("UPDATE media_items SET quality_profile_id = ? WHERE id = ?").run(profileId, showId);
    let target = 0;
    for (let n = 1; n <= 10; n++) {
      const id = await insertEpisode(showId, 1, n, { quality: n === 5 ? null : "Bluray-1080p" });
      if (n === 5) target = id;
    }
    feeds({ "5000": [release("Almost.Done.S01.1080p.WEB-DL-GRP", indexerId), release("Almost.Done.S01E05.720p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ grabbed: 1, woken: 0 });

    expect((await queueRows()).map((r) => [r.episode_id, r.season_number])).toEqual([[target, null]]);
  });

  it("does not grab a pack of a season that is still airing", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Still Airing");
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    await insertEpisode(showId, 1, 3, { airDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) });
    feeds({ "5000": [release("Still.Airing.S01.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ releases: 1, grabbed: 0 });
    expect(await queueRows()).toEqual([]);
  });

  it("grabs an upgrade only with automatic upgrades switched on", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const profileId = await insertProfile(["HDTV-720p", "WEBDL-1080p"], "WEBDL-1080p");
    await insertMovie({ hasFile: 1, quality: "HDTV-720p", profileId });
    feeds({ "2000": [release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ grabbed: 0 });
    expect(await queueRows()).toEqual([]);

    setSetting("autoUpgradeEnabled", "1");
    expect(await runRssSync()).toMatchObject({ grabbed: 1 });
    expect((await queueRows()).map((r) => r.title)).toEqual(["The.Matrix.1999.1080p.WEB-DL-GRP"]);
  });

  describe("a later revision of the file's own release (Round 13)", () => {
    async function movieWithFile(releaseTitle: string | null): Promise<number> {
      const profileId = await insertProfile(["HDTV-720p", "WEBDL-1080p"], "WEBDL-1080p");
      const id = await insertMovie({ hasFile: 1, quality: "WEBDL-1080p", profileId });
      await db.prepare("UPDATE media_items SET file_release_title = ? WHERE id = ?").run(releaseTitle, id);
      return id;
    }

    it("replaces a file at the cutoff with a PROPER or its own group's REPACK, with upgrades switched on", async () => {
      await insertClient();
      const indexerId = await insertIndexer();
      await movieWithFile("The.Matrix.1999.1080p.WEB-DL.x264-GRPA");
      feeds({ "2000": [release("The.Matrix.1999.REPACK.1080p.WEB-DL.x264-GRPA", indexerId)] });

      expect(await runRssSync()).toMatchObject({ grabbed: 0 });
      setSetting("autoUpgradeEnabled", "1");
      await db.prepare("DELETE FROM rss_sync_state").run();
      expect(await runRssSync()).toMatchObject({ grabbed: 1 });
      expect((await queueRows()).map((r) => r.title)).toEqual(["The.Matrix.1999.REPACK.1080p.WEB-DL.x264-GRPA"]);
    });

    it("leaves a file at the cutoff alone for another group's REPACK, a plain re-listing, or when revisions are not upgrades", async () => {
      await insertClient();
      const indexerId = await insertIndexer();
      setSetting("autoUpgradeEnabled", "1");
      await movieWithFile("The.Matrix.1999.1080p.WEB-DL.x264-GRPA");
      feeds({
        "2000": [release("The.Matrix.1999.REPACK.1080p.WEB-DL.x264-GRPB", indexerId), release("The.Matrix.1999.1080p.WEB-DL.x264-GRPC", indexerId)],
      });
      expect(await runRssSync()).toMatchObject({ grabbed: 0 });

      setSetting("downloadPropersAndRepacks", "doNotUpgrade");
      try {
        feeds({ "2000": [release("The.Matrix.1999.PROPER.1080p.WEB-DL.x264-GRPA", indexerId)] });
        await db.prepare("DELETE FROM rss_sync_state").run();
        expect(await runRssSync()).toMatchObject({ grabbed: 0 });
      } finally {
        setSetting("downloadPropersAndRepacks", "preferAndUpgrade");
      }
      expect(await queueRows()).toEqual([]);
    });

    it("never replaces a file of a profile that allows no upgrades", async () => {
      await insertClient();
      const indexerId = await insertIndexer();
      setSetting("autoUpgradeEnabled", "1");
      const id = await movieWithFile("The.Matrix.1999.1080p.WEB-DL.x264-GRPA");
      const row = (await db.prepare("SELECT quality_profile_id FROM media_items WHERE id = ?").get(id)) as { quality_profile_id: number };
      await db.prepare("UPDATE quality_profiles SET upgrade_allowed = 0 WHERE id = ?").run(row.quality_profile_id);
      feeds({ "2000": [release("The.Matrix.1999.PROPER.1080p.WEB-DL.x264-GRPB", indexerId)] });
      expect(await runRssSync()).toMatchObject({ grabbed: 0 });
    });
  });

  it("does not grab a release that is already queued for its target", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await insertMovie();
    feeds({ "2000": [release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId)] });
    await runRssSync();
    // A feed that lists the same release again (a marker lost, an indexer that re-lists).
    await db.prepare("DELETE FROM rss_sync_state").run();

    expect(await runRssSync()).toMatchObject({ grabbed: 0 });
    expect((await queueRows()).length).toBe(1);
  });

  describe("a release the delay profile holds back", () => {
    const insertDelay = (minutes: number) =>
      db
        .prepare(
          "INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index) VALUES (NULL, 1, 1, 0, ?, 0, 0)"
        )
        .run(minutes);

    it("wakes the movie, so that the next search looks for it, and grabs nothing yet", async () => {
      await insertClient();
      const indexerId = await insertIndexer();
      const movieId = await insertMovie();
      await db.prepare("UPDATE media_items SET auto_search_misses = 9 WHERE id = ?").run(movieId);
      await insertDelay(24 * 60);
      feeds({ "2000": [release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId, { publishDate: new Date().toISOString() })] });

      expect(await runRssSync()).toEqual({ releases: 1, grabbed: 0, woken: 1 });

      expect(await queueRows()).toEqual([]);
      const row = (await db.prepare("SELECT auto_search_misses FROM media_items WHERE id = ?").get(movieId)) as any;
      expect(Number(row.auto_search_misses)).toBe(0);
    });

    it("does not wake a movie for a release that is refused for another reason", async () => {
      await insertClient();
      const indexerId = await insertIndexer();
      const profileId = await insertProfile(["Bluray-1080p"], "Bluray-1080p");
      const movieId = await insertMovie({ profileId });
      await db.prepare("UPDATE media_items SET auto_search_misses = 9 WHERE id = ?").run(movieId);
      await insertDelay(24 * 60);
      feeds({ "2000": [release("The.Matrix.1999.720p.WEB-DL-GRP", indexerId, { publishDate: new Date().toISOString() })] });

      expect(await runRssSync()).toEqual({ releases: 1, grabbed: 0, woken: 0 });

      const row = (await db.prepare("SELECT auto_search_misses FROM media_items WHERE id = ?").get(movieId)) as any;
      expect(Number(row.auto_search_misses)).toBe(9);
    });

    it("wakes the season of a pack the delay holds back, and an episode of an episode release", async () => {
      await insertClient();
      const indexerId = await insertIndexer();
      await insertDelay(24 * 60);
      const packShow = await insertSeries("Pack Show");
      for (let n = 1; n <= 3; n++) await insertEpisode(packShow, 1, n);
      await db.prepare("INSERT INTO season_searches (media_item_id, season_number, misses, last_searched_at) VALUES (?, 1, 7, ?)").run(packShow, new Date().toISOString().slice(0, 19).replace("T", " "));
      const epShow = await insertSeries("Ep Show");
      const ep = await insertEpisode(epShow, 1, 1);
      await db.prepare("UPDATE episodes SET auto_search_misses = 5 WHERE id = ?").run(ep);
      const now = new Date().toISOString();
      feeds({ "5000": [release("Pack.Show.S01.1080p.WEB-DL-GRP", indexerId, { publishDate: now }), release("Ep.Show.S01E01.1080p.WEB-DL-GRP", indexerId, { publishDate: now })] });

      expect(await runRssSync()).toEqual({ releases: 2, grabbed: 0, woken: 2 });

      expect(await db.prepare("SELECT 1 AS x FROM season_searches WHERE media_item_id = ?").get(packShow)).toBeUndefined();
      const row = (await db.prepare("SELECT auto_search_misses FROM episodes WHERE id = ?").get(ep)) as any;
      expect(Number(row.auto_search_misses)).toBe(0);
    });
  });

  describe("which feeds are read", () => {
    it("reads every enabled Torznab, Newznab and RSS indexer, and nothing else", async () => {
      await insertClient();
      await insertMovie();
      const torznab = await insertIndexer({ name: "Torznab" });
      const rss = await insertIndexer({ name: "Plain RSS", protocol: "rss", mediaTypes: "movie" });
      await insertIndexer({ name: "Off", enabled: 0 });
      await insertIndexer({ name: "Ddl", protocol: "ddl" });
      await insertIndexer({ name: "Series only RSS", protocol: "rss", mediaTypes: "series" });

      await runRssSync();

      const read = fetchRecentReleases.mock.calls.map((c) => [(c[0] as { id: number }).id, (c[1] as { key: string }).key]);
      expect(read.sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
        [torznab, "2000"],
        [rss, "rss"],
      ]);
    });

    it("asks a feed only for the media types something is wanted in", async () => {
      await insertClient();
      await insertIndexer();
      const showId = await insertSeries("Wanted Show");
      await insertEpisode(showId, 1, 1);

      await runRssSync();

      expect(fetchRecentReleases.mock.calls.map((c) => (c[1] as { cats: string }).cats)).toEqual(["5000"]);
    });

    it("goes on with the other indexers when one cannot be read, keeping its old marker", async () => {
      await insertClient();
      await insertMovie();
      const broken = await insertIndexer({ name: "Broken" });
      const working = await insertIndexer({ name: "Working" });
      await db.prepare("INSERT INTO rss_sync_state (indexer_id, feed_key, last_seen_url, last_seen_at) VALUES (?, '2000', 'old-url', NULL)").run(broken);
      const wanted = release("The.Matrix.1999.1080p.WEB-DL-GRP", working);
      fetchRecentReleases.mockImplementation(async (indexer: { id: number }) => {
        if (indexer.id === broken) throw new Error("HTTP 500");
        return { results: [wanted], newest: { url: wanted.downloadUrl, at: wanted.publishDate } };
      });

      expect(await runRssSync()).toMatchObject({ releases: 1, grabbed: 1 });

      const row = (await db.prepare("SELECT last_seen_url FROM rss_sync_state WHERE indexer_id = ?").get(broken)) as any;
      expect(row.last_seen_url).toBe("old-url");
    });

    it("stops when the job is cancelled", async () => {
      await insertClient();
      await insertIndexer();
      await insertMovie();
      const controller = new AbortController();
      controller.abort();

      expect(await runRssSync(controller.signal)).toEqual({ releases: 0, grabbed: 0, woken: 0 });
      expect(fetchRecentReleases).not.toHaveBeenCalled();
    });
  });
});

describe("runRssSync — after the Round 10 review", () => {
  const markerRows = async (): Promise<any[]> => (await db.prepare("SELECT indexer_id, feed_key FROM rss_sync_state").all()) as any[];

  it("reads the releases again when a download client was down for part of the run", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await insertMovie();
    feeds({ "2000": [release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId)] });
    getDownloadClientAdapter.mockReturnValue({
      addDownload: vi.fn().mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" })),
      getStatus: vi.fn().mockResolvedValue([]),
    });

    expect(await runRssSync()).toMatchObject({ releases: 1, grabbed: 0 });
    expect(await markerRows()).toEqual([]);

    getDownloadClientAdapter.mockReturnValue(urlKeyedAdapter());
    expect(await runRssSync()).toMatchObject({ releases: 1, grabbed: 1 });
    expect(fetchRecentReleases.mock.calls[1][2]).toBeNull();
    expect(await markerRows()).toHaveLength(1);
  });

  it("keeps the marker of a feed that was empty when first read to nothing", async () => {
    await insertClient();
    await insertIndexer();
    await insertMovie();
    feeds({});

    await runRssSync();
    await runRssSync();

    expect(await markerRows()).toEqual([]);
    expect(fetchRecentReleases.mock.calls[1][2]).toBeNull();
  });

  it("sends a release that names two wanted episodes once", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Rss Show");
    await insertEpisode(showId, 1, 1);
    await insertEpisode(showId, 1, 2);
    const adapter = urlKeyedAdapter();
    getDownloadClientAdapter.mockReturnValue(adapter);
    feeds({ "5000": [release("Rss.Show.S01E01-E02.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ grabbed: 1 });

    expect(adapter.addDownload).toHaveBeenCalledTimes(1);
  });

  it("takes the pack of each part of a season that a scene splits in two, keeping their backoffs apart", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Rss Show");
    for (const [n, scene] of [[1, 2], [2, 2], [3, 3], [4, 3]] as const) {
      const id = await insertEpisode(showId, 1, n);
      await db.prepare("UPDATE episodes SET scene_season_number = ?, scene_episode_number = ? WHERE id = ?").run(scene, n, id);
    }
    feeds({ "5000": [release("Rss.Show.S02.1080p.WEB-DL-GRP", indexerId), release("Rss.Show.S03.1080p.WEB-DL-GRP", indexerId)] });

    expect(await runRssSync()).toMatchObject({ releases: 2, grabbed: 2 });

    expect((await queueRows()).map((r) => r.season_number)).toEqual([1, 1]);
    const seasons = (await db.prepare("SELECT season_number FROM season_searches WHERE media_item_id = ? ORDER BY season_number").all(showId)) as any[];
    expect(seasons.map((r) => Number(r.season_number))).toEqual([2, 3]);
  });
});
