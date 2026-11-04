import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
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

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let runRssSync: (typeof import("../src/services/rssSync.js"))["runRssSync"];
let decisionsStore: typeof import("../src/services/rssDecisions.js");

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ runRssSync } = await import("../src/services/rssSync.js"));
  decisionsStore = await import("../src/services/rssDecisions.js");
});

beforeEach(async () => {
  for (const t of ["rss_decisions", "rss_sync_state", "media_item_titles", "history", "blocklist", "queue", "delay_profiles", "episodes", "sub_items", "media_items", "download_clients", "indexers"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  fetchRecentReleases.mockReset().mockResolvedValue({ results: [], newest: null });
  getDownloadClientAdapter.mockReset().mockReturnValue({ addDownload: vi.fn(async (_c: unknown, url: string) => ({ downloadId: url })), getStatus: vi.fn().mockResolvedValue([]) });
  setSetting("autoUpgradeEnabled", "0");
  setSetting("downloadPropersAndRepacks", "preferAndUpgrade");
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

async function insertClient(): Promise<number> {
  return Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Test Client', 'qbittorrent', 1)").run()).lastInsertRowid);
}

async function insertIndexer(): Promise<number> {
  return Number((await db.prepare("INSERT INTO indexers (name, protocol, url, enabled, media_types) VALUES ('Idx', 'torznab', 'http://idx.example.com', 1, 'movie,series,anime')").run()).lastInsertRowid);
}

async function insertProfile(allowed: string[], cutoff: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)").run(`Profile ${Math.random()}`, JSON.stringify(allowed), cutoff)).lastInsertRowid
  );
}

async function insertMovie(title: string, year: number, profileId: number | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, quality_profile_id, status) VALUES ('movie', ?, ?, ?, 1, 0, ?, 'missing')")
        .run(title, title.toLowerCase(), year, profileId)
    ).lastInsertRowid
  );
}

async function insertSeries(title: string, profileId: number | null = null): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, quality_profile_id, status) VALUES ('series', ?, ?, 1, 0, ?, 'missing')").run(title, title.toLowerCase(), profileId))
      .lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number, over: { quality?: string | null; releaseTitle?: string | null } = {}): Promise<number> {
  const quality = over.quality ?? null;
  return Number(
    (
      await db
        .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, monitored, has_file, quality, air_date, file_release_title) VALUES (?, ?, ?, 'Ep', 1, ?, ?, '2020-01-01', ?)")
        .run(showId, season, episode, quality ? 1 : 0, quality, over.releaseTitle ?? null)
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

function feeds(byCats: Record<string, any[]>) {
  fetchRecentReleases.mockImplementation(async (_indexer: unknown, group: { cats: string }) => {
    const results = byCats[group.cats] ?? [];
    return { results, newest: results[0] ? { url: results[0].downloadUrl, at: results[0].publishDate } : null };
  });
}

const queueTitles = async (): Promise<string[]> => ((await db.prepare("SELECT title FROM queue ORDER BY id").all()) as { title: string }[]).map((r) => r.title);

describe("RSS season packs are judged by the upgrade rules (Round 30c)", () => {
  async function finishedSeason(): Promise<number> {
    const profileId = await insertProfile(["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "WEBDL-1080p");
    const showId = await insertSeries("Pack Show", profileId);
    for (let n = 1; n <= 3; n++) await insertEpisode(showId, 1, n, { quality: "WEBDL-1080p", releaseTitle: `Pack.Show.S01E0${n}.1080p.WEB-DL.x264-GRPA` });
    return showId;
  }

  it("takes a PROPER pack at the quality the season already has, once automatic upgrades are on", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await finishedSeason();
    setSetting("autoUpgradeEnabled", "1");
    feeds({ "5000": [release("Pack.Show.S01.PROPER.1080p.WEB-DL.x264-GRPB", indexerId)] });

    expect(await runRssSync()).toMatchObject({ grabbed: 1 });

    expect(await queueTitles()).toEqual(["Pack.Show.S01.PROPER.1080p.WEB-DL.x264-GRPB"]);
    expect(((await db.prepare("SELECT media_item_id, season_number, grab_source FROM queue").get()) as any)).toEqual({ media_item_id: showId, season_number: 1, grab_source: "rss" });
  });

  it("still refuses a same-quality pack that is no later revision, another group's REPACK, and any pack when revisions are not upgrades", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await finishedSeason();
    setSetting("autoUpgradeEnabled", "1");
    feeds({ "5000": [release("Pack.Show.S01.1080p.WEB-DL.x264-GRPB", indexerId), release("Pack.Show.S01.REPACK.1080p.WEB-DL.x264-GRPC", indexerId)] });
    expect(await runRssSync()).toMatchObject({ grabbed: 0 });

    setSetting("downloadPropersAndRepacks", "doNotUpgrade");
    await db.prepare("DELETE FROM rss_sync_state").run();
    feeds({ "5000": [release("Pack.Show.S01.PROPER.1080p.WEB-DL.x264-GRPB", indexerId)] });
    expect(await runRssSync()).toMatchObject({ grabbed: 0 });
    expect(await queueTitles()).toEqual([]);
  });

  it("still takes a better-quality pack for a season below the cutoff, and leaves a season at the cutoff to revisions only", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const profileId = await insertProfile(["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"], "Bluray-1080p");
    const showId = await insertSeries("Lower Show", profileId);
    for (let n = 1; n <= 3; n++) await insertEpisode(showId, 1, n, { quality: "WEBDL-720p", releaseTitle: `Lower.Show.S01E0${n}.720p.WEB-DL-GRPA` });
    setSetting("autoUpgradeEnabled", "1");
    feeds({ "5000": [release("Lower.Show.S01.1080p.WEB-DL.x264-GRPB", indexerId)] });

    expect(await runRssSync()).toMatchObject({ grabbed: 1 });
    expect(await queueTitles()).toEqual(["Lower.Show.S01.1080p.WEB-DL.x264-GRPB"]);
  });
});

describe("RSS decisions (SR14)", () => {
  it("keeps what was decided about each release, with the reason, and lists them newest first without the download link", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    await insertMovie("The Matrix", 1999, profileId);
    await insertMovie("Heat", 1995, profileId);
    const queuedId = await insertMovie("Alien", 1979, profileId);
    await db.prepare("INSERT INTO queue (media_item_id, title, status, download_id) VALUES (?, 'Alien.1979.1080p.WEB-DL-GRP', 'downloading', 'x')").run(queuedId);
    feeds({
      "2000": [
        release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId, { downloadUrl: "http://idx/dl?apikey=SECRET1" }),
        release("Heat.1995.720p.WEB-DL-GRP", indexerId),
        release("Alien.1979.1080p.WEB-DL-OTHER", indexerId),
        release("Some.Unrelated.Thing.2020.1080p.WEB-DL-GRP", indexerId),
      ],
    });

    expect(await runRssSync()).toMatchObject({ releases: 4, grabbed: 1 });

    const res = await authed(request(app).get("/api/activity/rss-decisions"));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    const byTitle = Object.fromEntries(res.body.items.map((i: any) => [i.title, i]));
    expect(byTitle["The.Matrix.1999.1080p.WEB-DL-GRP"]).toMatchObject({ outcome: "grabbed", mediaTitle: "The Matrix", indexerName: "Idx", protocol: "torrent" });
    expect(byTitle["Heat.1995.720p.WEB-DL-GRP"]).toMatchObject({ outcome: "rejected", mediaTitle: "Heat" });
    expect(byTitle["Heat.1995.720p.WEB-DL-GRP"].reason).toContain("isn't allowed by this quality profile");
    expect(byTitle["Alien.1979.1080p.WEB-DL-OTHER"]).toMatchObject({ outcome: "skipped", mediaTitle: "Alien", reason: "already queued" });
    expect(byTitle["Some.Unrelated.Thing.2020.1080p.WEB-DL-GRP"]).toMatchObject({ outcome: "unmatched", mediaItemId: null });
    expect(byTitle["Some.Unrelated.Thing.2020.1080p.WEB-DL-GRP"].reason).toContain("no wanted title is named");
    // The download link of a release can carry an indexer key and never leaves the server.
    expect(JSON.stringify(res.body)).not.toContain("SECRET1");

    const grabbedOnly = await authed(request(app).get("/api/activity/rss-decisions?outcome=grabbed&limit=1"));
    expect(grabbedOnly.body.items.map((i: any) => i.title)).toEqual(["The.Matrix.1999.1080p.WEB-DL-GRP"]);
    expect(grabbedOnly.body.total).toBe(1);
  });

  it("records a release held back by a delay profile as held, and reads a feed again without duplicating rows", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    await insertMovie("The Matrix", 1999);
    await db.prepare("INSERT INTO delay_profiles (tag_id, usenet_delay_minutes, torrent_delay_minutes) VALUES (NULL, 0, 600)").run();
    feeds({ "2000": [release("The.Matrix.1999.1080p.WEB-DL-GRP", indexerId, { publishDate: new Date(Date.now() - 60_000).toISOString() })] });

    expect(await runRssSync()).toMatchObject({ woken: 1, grabbed: 0 });
    await db.prepare("DELETE FROM rss_sync_state").run();
    await runRssSync();

    const rows = (await db.prepare("SELECT title, outcome, reason FROM rss_decisions").all()) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "The.Matrix.1999.1080p.WEB-DL-GRP", outcome: "held" });
  });

  it("keeps the newest 200 judged releases and the newest 100 unmatched, and caps the unmatched a run adds", async () => {
    const mk = (n: number) => release(`Release.${n}.1080p.WEB-DL-GRP`, null);
    await decisionsStore.recordRssDecisions(Array.from({ length: 230 }, (_, i) => ({ release: mk(i), outcome: "rejected" as const, reason: "x" })));
    await decisionsStore.recordRssDecisions(Array.from({ length: 130 }, (_, i) => ({ release: mk(1000 + i), outcome: "unmatched" as const, reason: "y" })));

    const judged = (await db.prepare("SELECT title FROM rss_decisions WHERE outcome = 'rejected' ORDER BY id").all()) as { title: string }[];
    expect(judged).toHaveLength(decisionsStore.RSS_DECISIONS_KEPT);
    expect(judged[0].title).toBe("Release.30.1080p.WEB-DL-GRP");
    expect(judged[judged.length - 1].title).toBe("Release.229.1080p.WEB-DL-GRP");
    const unmatched = (await db.prepare("SELECT title FROM rss_decisions WHERE outcome = 'unmatched' ORDER BY id").all()) as { title: string }[];
    expect(unmatched).toHaveLength(decisionsStore.RSS_UNMATCHED_KEPT);
    expect(unmatched[0].title).toBe("Release.1030.1080p.WEB-DL-GRP");

    // A run records at most 50 unmatched releases (the feed lists thousands that name nothing wanted).
    await insertClient();
    const indexerId = await insertIndexer();
    await insertMovie("The Matrix", 1999);
    feeds({ "2000": Array.from({ length: 80 }, (_, i) => release(`Nothing.Wanted.${i}.2020.1080p.WEB-DL-GRP`, indexerId)) });
    await db.prepare("DELETE FROM rss_decisions").run();
    await runRssSync();
    expect(Number(((await db.prepare("SELECT COUNT(*) AS c FROM rss_decisions").get()) as { c: number }).c)).toBe(decisionsStore.RSS_UNMATCHED_PER_RUN);
  });

  it("housekeeping drops decisions older than two weeks", async () => {
    const { runHousekeeping } = await import("../src/services/housekeeping.js");
    await decisionsStore.recordRssDecisions([
      { release: release("Old.One.1080p.WEB-DL-GRP", null), outcome: "rejected", reason: "x" },
      { release: release("New.One.1080p.WEB-DL-GRP", null), outcome: "rejected", reason: "x" },
    ]);
    await db.prepare("UPDATE rss_decisions SET created_at = '2020-01-01 00:00:00' WHERE title LIKE 'Old.%'").run();
    await runHousekeeping();
    expect(((await db.prepare("SELECT title FROM rss_decisions").all()) as { title: string }[]).map((r) => r.title)).toEqual(["New.One.1080p.WEB-DL-GRP"]);
  });
});

describe("POST /api/activity/rss-decisions/:id/map (SR14)", () => {
  const SEN = "Sen.to.Chihiro.no.Kamikakushi.2001.1080p.WEB-DL-GRP";

  async function unmatchedSpiritedAway() {
    await insertClient();
    const indexerId = await insertIndexer();
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    const movieId = await insertMovie("Spirited Away", 2001, profileId);
    feeds({ "2000": [release(SEN, indexerId, { downloadUrl: "http://idx/dl?apikey=SECRET2" })] });
    expect(await runRssSync()).toMatchObject({ releases: 1, grabbed: 0 });
    const row = (await db.prepare("SELECT id, outcome FROM rss_decisions").get()) as { id: number; outcome: string };
    expect(row.outcome).toBe("unmatched");
    return { movieId, decisionId: row.id };
  }

  it("teaches the title the release's name, judges that release again and grabs it", async () => {
    const { movieId, decisionId } = await unmatchedSpiritedAway();

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${decisionId}/map`).send({ mediaItemId: movieId }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: decisionId, outcome: "grabbed", mediaItemId: movieId, mediaTitle: "Spirited Away", aliasAdded: true });
    expect(JSON.stringify(res.body)).not.toContain("SECRET2");
    expect(await queueTitles()).toEqual([SEN]);
    const alias = (await db.prepare("SELECT title, source FROM media_item_titles WHERE media_item_id = ? AND source = 'user'").get(movieId)) as { title: string; source: string };
    expect(alias.title.toLowerCase()).toContain("sen to chihiro");
    // The row now shows what became of it.
    const listed = await authed(request(app).get("/api/activity/rss-decisions?outcome=grabbed"));
    expect(listed.body.items.map((i: any) => i.title)).toEqual([SEN]);
  });

  it("holds the release to the episode the admin names but still judges its numbering, and says why it was refused", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const showId = await insertSeries("Tiny Show");
    const epId = await insertEpisode(showId, 1, 1);
    feeds({ "5000": [release("Tiny.Show.Alternate.Name.S05E09.1080p.WEB-DL-GRP", indexerId)] });
    await runRssSync();
    const row = (await db.prepare("SELECT id, outcome FROM rss_decisions").get()) as { id: number; outcome: string };
    expect(row.outcome).toBe("unmatched");

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${row.id}/map`).send({ mediaItemId: showId, episodeId: epId }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "rejected", mediaItemId: showId, episodeId: epId });
    expect(res.body.reason).toContain("doesn't match the target episode");
    expect(await queueTitles()).toEqual([]);
  });

  it("answers 404 for an unknown release, title or episode of another title, and 400 for an episode with a sub-item", async () => {
    const { movieId, decisionId } = await unmatchedSpiritedAway();
    const showId = await insertSeries("Other Show");
    const otherEp = await insertEpisode(showId, 1, 1);

    expect((await authed(request(app).post("/api/activity/rss-decisions/999999/map").send({ mediaItemId: movieId }))).status).toBe(404);
    expect((await authed(request(app).post(`/api/activity/rss-decisions/${decisionId}/map`).send({ mediaItemId: 999999 }))).status).toBe(404);
    expect((await authed(request(app).post(`/api/activity/rss-decisions/${decisionId}/map`).send({ mediaItemId: movieId, episodeId: otherEp }))).status).toBe(404);
    expect((await authed(request(app).post(`/api/activity/rss-decisions/${decisionId}/map`).send({ mediaItemId: movieId, episodeId: otherEp, subItemId: 1 }))).status).toBe(400);
    expect(await queueTitles()).toEqual([]);
  });

  it("answers unmatched, not an error, when the title still wants nothing the release names", async () => {
    await insertClient();
    const indexerId = await insertIndexer();
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    const heatId = await insertMovie("Heat", 1995, profileId);
    await db.prepare("UPDATE media_items SET has_file = 1, quality = 'WEBDL-1080p' WHERE id = ?").run(heatId);
    await insertMovie("Something Else Wanted", 2000, profileId); // the sync reads feeds only while something is wanted
    feeds({ "2000": [release("Heat.1995.1080p.WEB-DL-GRP", indexerId)] });
    await runRssSync();
    const row = (await db.prepare("SELECT id FROM rss_decisions").get()) as { id: number };

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${row.id}/map`).send({ mediaItemId: heatId }));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("unmatched");
    expect(res.body.reason).toContain("still not matched");
  });
});

describe("POST /api/activity/rss-decisions/:id/map refuses names that are too generic or another title's (L5)", () => {
  async function unmatched(releaseName: string) {
    await insertClient();
    const indexerId = await insertIndexer();
    feeds({ "2000": [release(releaseName, indexerId)] });
    await runRssSync();
    return (await db.prepare("SELECT id FROM rss_decisions ORDER BY id DESC").get()) as { id: number };
  }

  it("refuses a release name under three letters", async () => {
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    const movieId = await insertMovie("Spirited Away", 2001, profileId);
    const row = await unmatched("Za.2001.1080p.WEB-DL-GRP");

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${row.id}/map`).send({ mediaItemId: movieId }));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("shorter than 3 letters");
    expect(res.body.error).toContain("Za");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM media_item_titles WHERE source = 'user'").get() as { n: number }).n).toBe(0);
  });

  it("refuses a name another title of the library has, whatever its case or punctuation", async () => {
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    const movieId = await insertMovie("Spirited Away", 2001, profileId);
    await insertMovie("Sen To Chihiro", 2001, profileId);
    const row = await unmatched("Sen.to.Chihiro.2001.1080p.WEB-DL-GRP");

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${row.id}/map`).send({ mediaItemId: movieId }));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Sen to Chihiro");
    expect(res.body.error).toContain("already the name of");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM media_item_titles WHERE source = 'user'").get() as { n: number }).n).toBe(0);
  });

  it("refuses a name another title already has as an alias", async () => {
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    const movieId = await insertMovie("Spirited Away", 2001, profileId);
    const otherId = await insertMovie("Something Else", 2001, profileId);
    await db.prepare("INSERT INTO media_item_titles (media_item_id, title, clean_title, source) VALUES (?, 'Sen to Chihiro', 'sentochihiro', 'user')").run(otherId);
    const row = await unmatched("Sen.to.Chihiro.2001.1080p.WEB-DL-GRP");

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${row.id}/map`).send({ mediaItemId: movieId }));

    expect(res.status).toBe(409);
  });

  it("answers with the alias it added", async () => {
    const profileId = await insertProfile(["WEBDL-1080p"], "WEBDL-1080p");
    const movieId = await insertMovie("Spirited Away", 2001, profileId);
    const row = await unmatched("Sen.to.Chihiro.2001.1080p.WEB-DL-GRP");

    const res = await authed(request(app).post(`/api/activity/rss-decisions/${row.id}/map`).send({ mediaItemId: movieId }));

    expect(res.status).toBe(200);
    expect(res.body.aliasAdded).toBe(true);
    expect(String(res.body.alias).toLowerCase()).toContain("sen to chihiro");
  });
});
