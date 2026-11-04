import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import { setupTestDb } from "./helpers/testDb.js";
import { nowExpr } from "../src/db/asyncDb.js";

// Round 30e: Sonarr's EpisodeTitleRequired. When the naming format has the episode's title in it, an automatic import of a
// recent episode that has no title yet (empty, TBA, "Episode 5") waits instead of being named after the placeholder. It
// goes ahead when the title arrives, when the episode is more than 48 hours old, or when the setting is "never".

const manualInteraction = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notifications.js")>()),
  notifyImported: vi.fn().mockResolvedValue(undefined),
  notifyUpgraded: vi.fn().mockResolvedValue(undefined),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
  notifyManualInteractionRequired: (...args: unknown[]) => manualInteraction(...args),
}));

vi.mock("../src/services/metadataExport.js", () => ({
  writeNfoSidecar: vi.fn(),
  writeEpisodeNfoSidecar: vi.fn(),
  writeTvShowNfoIfMissing: vi.fn(),
}));

vi.mock("../src/services/audioTagWriter.js", () => ({ writeAudioTags: vi.fn() }));

const unpackDownloadedArchives = vi.fn();
vi.mock("../src/services/archiveExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/archiveExtract.js")>()),
  unpackDownloadedArchives: (...args: unknown[]) => unpackDownloadedArchives(...args),
}));

vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  removeQueueItemDownload: vi.fn().mockResolvedValue(undefined),
  markDownloadImported: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/subtitleSync.js", () => ({ syncSubtitleToVideo: vi.fn().mockResolvedValue(false) }));
vi.mock("../src/services/comicImageConvert.js", () => ({ convertComicImagesBestEffort: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/services/ffprobe.js", () => ({ probeMediaInfo: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/services/subtitleClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  searchSubtitles: vi.fn().mockResolvedValue([]),
  searchCustomSubtitles: vi.fn().mockResolvedValue([]),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let app: Awaited<ReturnType<typeof setupTestDb>>["app"];
let apiKey: string;
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let config: (typeof import("../src/config.js"))["config"];
let importer: typeof import("../src/services/importer.js");
let rule: typeof import("../src/services/episodeTitleRule.js");
let scheduler: typeof import("../src/services/scheduler.js");
let templateUsesToken: (typeof import("../src/services/naming.js"))["templateUsesToken"];

let downloadsDir: string;
let libraryDir: string;

beforeAll(async () => {
  ({ db, app, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  rule = await import("../src/services/episodeTitleRule.js");
  scheduler = await import("../src/services/scheduler.js");
  ({ templateUsesToken } = await import("../src/services/naming.js"));
  await (await import("../src/services/quality.js")).loadQualityCaches();
  downloadsDir = path.join(config.downloadsDir, "test-fixtures-episode-title");
});

beforeEach(async () => {
  for (const t of ["history", "recycle_bin", "queue", "download_clients", "indexers", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  manualInteraction.mockClear();
  scheduler.__setEpisodeTitleRetryMsForTests(10 * 60_000);

  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-episode-title-"));

  setSetting("episodeTitleRequired", "");
  setSetting("namingSeriesTemplate", "");
  setSetting("namingEnabledSeries", "");
  setSetting("useScriptImport", "0");
  setSetting("enableMediaInfo", "0");
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("minimumFreeSpaceMb", "0");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeNfoOnImport", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("subtitleSyncEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe("episodeTitleHoldReason", () => {
  const NOW = Date.parse("2026-11-04T12:00:00Z");
  const episode = (n: number, title: string | null, airDate: string | null) => ({ seasonNumber: 1, episodeNumber: n, title, airDate });
  const AGES: [string, string | null, boolean][] = [
    ["aired yesterday", "2026-11-03", true],
    ["aired 47 hours ago", "2026-11-02T13:00:00Z", true],
    ["aired 49 hours ago", "2026-11-02T11:00:00Z", false],
    ["aired a month ago", "2026-10-01", false],
    ["has no air date", null, true],
  ];
  const TITLES: [string, string | null, boolean][] = [
    ["a real title", "Pilot", true],
    ["no title", null, false],
    ["an empty title", "  ", false],
    ["TBA", "TBA", false],
    ["tba in lower case", "tba", false],
    ["TBD", "TBD", false],
    ["a provider's Episode 5", "Episode 5", false],
  ];

  describe.each([
    ["always", true],
    ["bulkSeasonReleases", false],
    ["never", false],
  ] as const)("mode %s", (mode, holdsSingleEpisode) => {
    for (const [ageLabel, airDate, recent] of AGES) {
      for (const [titleLabel, title, hasTitle] of TITLES) {
        for (const requiresTitle of [true, false]) {
          const expected = holdsSingleEpisode && requiresTitle && recent && !hasTitle;
          // "bulkSeasonReleases" holds a lone episode of the season only when it has no air date to tell it from a bulk drop.
          const bulkNoDate = mode === "bulkSeasonReleases" && requiresTitle && airDate === null && !hasTitle;
          it(`${expected || bulkNoDate ? "holds" : "lets through"} an episode that ${ageLabel} with ${titleLabel}, naming format ${requiresTitle ? "with" : "without"} {episodeTitle}`, () => {
            const reason = rule.episodeTitleHoldReason({
              mode,
              requiresTitle,
              episodes: [episode(2, title, airDate)],
              seasonEpisodes: [episode(1, "One", "2026-10-27"), episode(2, title, airDate), episode(3, null, "2026-11-10")],
              now: NOW,
            });
            if (expected || bulkNoDate) expect(reason).toMatch(/^Waiting for the episode title: S01E02 /);
            else expect(reason).toBeNull();
          });
        }
      }
    }
  });

  it("says why, with the episode's code and what it is called", () => {
    const base = { mode: "always" as const, requiresTitle: true, seasonEpisodes: [], now: NOW };
    expect(rule.episodeTitleHoldReason({ ...base, episodes: [episode(5, null, "2026-11-03")] })).toBe(
      "Waiting for the episode title: S01E05 has no title yet and the naming format uses it; it is imported when the title arrives or two days after it aired"
    );
    expect(rule.episodeTitleHoldReason({ ...base, episodes: [episode(5, "TBA", "2026-11-03")] })).toContain('is still named "TBA"');
    expect(rule.episodeTitleHoldReason({ ...base, episodes: [episode(5, null, null)] })).toContain("it has no air date, so it waits for the title");
  });

  it("holds a multi-episode file for the one episode of it that is recent and untitled", () => {
    const reason = rule.episodeTitleHoldReason({
      mode: "always",
      requiresTitle: true,
      episodes: [episode(1, "TBA", "2026-10-01"), episode(2, "TBA", "2026-11-03")],
      seasonEpisodes: [],
      now: NOW,
    });
    expect(reason).toMatch(/S01E02 is still named "TBA"/);
  });

  describe("bulkSeasonReleases, which waits only for a season dropped at once (four or more episodes on the file's first day)", () => {
    const drop = (count: number, day = "2026-11-03") => Array.from({ length: count }, (_, i) => episode(i + 1, "TBA", day));
    const run = (episodes: ReturnType<typeof episode>[], seasonEpisodes: ReturnType<typeof episode>[]) =>
      rule.episodeTitleHoldReason({ mode: "bulkSeasonReleases", requiresTitle: true, episodes, seasonEpisodes, now: NOW });

    it("holds an episode of a season of ten that aired together", () => {
      expect(run([drop(10)[2]], drop(10))).toMatch(/S01E03/);
    });
    it("holds at exactly four on the day and lets three through", () => {
      expect(run([drop(4)[0]], drop(4))).not.toBeNull();
      expect(run([drop(3)[0]], drop(3))).toBeNull();
    });
    it("counts an episode with no air date as part of the day", () => {
      expect(run([drop(3)[0]], [...drop(3), episode(4, "TBA", null)])).not.toBeNull();
    });
    it("lets through a weekly show: one episode a day", () => {
      const weekly = [1, 2, 3, 4].map((n) => episode(n, "TBA", `2026-11-0${n}`));
      expect(run([weekly[2]], weekly)).toBeNull();
    });
    it("holds a file whose episodes span two days, which is not one drop", () => {
      const eps = [episode(1, "TBA", "2026-11-03"), episode(2, "TBA", "2026-11-04")];
      expect(run(eps, eps)).not.toBeNull();
    });
  });

  it("is switched off by 'never' whatever the episodes look like", () => {
    expect(rule.episodeTitleHoldReason({ mode: "never", requiresTitle: true, episodes: [episode(1, "TBA", "2026-11-04")], seasonEpisodes: [], now: NOW })).toBeNull();
  });

  it("reads the setting: never when unset or not one of the three", () => {
    expect(rule.episodeTitleRequiredMode()).toBe("never");
    setSetting("episodeTitleRequired", "always");
    expect(rule.episodeTitleRequiredMode()).toBe("always");
    setSetting("episodeTitleRequired", "bulkSeasonReleases");
    expect(rule.episodeTitleRequiredMode()).toBe("bulkSeasonReleases");
    setSetting("episodeTitleRequired", "sometimes");
    expect(rule.episodeTitleRequiredMode()).toBe("never");
  });
});

describe("templateUsesToken", () => {
  it("finds the episode title in any spelling, and in Starr's template", () => {
    expect(templateUsesToken("{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00} - {episodeTitle}", "episodeTitle")).toBe(true);
    expect(templateUsesToken("{Series Title} - S{season:00}E{episode:00} - {Episode Title}", "episodeTitle")).toBe(true);
    expect(templateUsesToken("{episode_title}", "episodeTitle")).toBe(true);
    expect(templateUsesToken("{parentTitle} - S{season:00}E{episode:00}", "episodeTitle")).toBe(false);
    expect(templateUsesToken("{Series Title}", "episodeTitle")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through the importer
// ---------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const RELEASE = "Show.S01E02.1080p.WEB-DL.x264-GRP";

async function insertRootFolder(): Promise<{ id: number; path: string }> {
  const p = path.join(libraryDir, "series");
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, "series", "series");
  return { id: Number(result.lastInsertRowid), path: p };
}

async function insertShow(folderId: number, episodes: { n: number; title: string | null; airDate: string | null }[]) {
  const showId = Number(
    (await db.prepare(`INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status) VALUES ('series','Show','show',2020,?,1,0,'missing')`).run(folderId))
      .lastInsertRowid
  );
  const ids: number[] = [];
  for (const e of episodes) {
    ids.push(
      Number(
        (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?,1,?,?,?,1,0)`).run(showId, e.n, e.title, e.airDate))
          .lastInsertRowid
      )
    );
  }
  return { showId, ids };
}

function writeDownloadFile(name: string, content = "bytes"): string {
  const p = path.join(downloadsDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function queueEpisode(showId: number, episodeId: number, downloadPath: string, extra: Record<string, unknown> = {}): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO queue (media_item_id, episode_id, title, quality, download_path, grab_source, status, import_skipped_reason) VALUES (?,?,?,?,?,NULL,?,?)`)
    .run(showId, episodeId, RELEASE, "WEBDL-1080p", downloadPath, extra.status ?? "downloaded", extra.reason ?? null);
  return Number(result.lastInsertRowid);
}

async function episodeRow(id: number) {
  return (await db.prepare("SELECT has_file, file_path, title FROM episodes WHERE id = ?").get(id)) as { has_file: number; file_path: string | null; title: string | null };
}

/** An automatic import of episode 2 of a show whose second episode is `title`, aired `airDate`. */
async function importEpisodeTwo(title: string | null, airDate: string | null, manual = false) {
  const folder = await insertRootFolder();
  const { showId, ids } = await insertShow(folder.id, [{ n: 1, title: "One", airDate: daysAgo(30) }, { n: 2, title, airDate }]);
  const download = writeDownloadFile(`${RELEASE}.mkv`);
  const queueId = await queueEpisode(showId, ids[1], download);
  const outcome = await (manual ? importer.importQueueItem(queueId, download) : importer.importQueueItem(queueId)).then(
    () => null,
    (err: Error) => err
  );
  return { outcome, row: await episodeRow(ids[1]), download, folder, showId, episodeId: ids[1], queueId };
}

describe("an automatic import and episodeTitleRequired", () => {
  it("imports a recent episode with no title yet under 'never', the default, as it always did", async () => {
    const result = await importEpisodeTwo("TBA", today());
    expect(result.outcome).toBeNull();
    expect(result.row.has_file).toBe(1);
    expect(path.basename(result.row.file_path!)).toBe("Show - S01E02 - TBA.mkv");
  });

  it("holds it under 'always': the download stays, nothing is placed, and the reason says what it waits for", async () => {
    setSetting("episodeTitleRequired", "always");

    const result = await importEpisodeTwo("TBA", today());

    expect(result.outcome).toBeInstanceOf(importer.EpisodeTitleHoldError);
    expect(result.outcome).toBeInstanceOf(importer.ImportSkippedError);
    expect(result.outcome?.message).toMatch(/^Waiting for the episode title: S01E02 is still named "TBA"/);
    expect(fs.existsSync(result.download)).toBe(true);
    expect(result.row.has_file).toBe(0);
    expect(fs.existsSync(path.join(result.folder.path, "Show"))).toBe(false); // not even its folder
    expect(await db.prepare("SELECT 1 FROM queue WHERE id = ?").get(result.queueId)).toBeTruthy();
  });

  it("imports it under 'always' once the episode has a title", async () => {
    setSetting("episodeTitleRequired", "always");
    const result = await importEpisodeTwo("Second", today());
    expect(result.outcome).toBeNull();
    expect(path.basename(result.row.file_path!)).toBe("Show - S01E02 - Second.mkv");
  });

  it("imports it under 'always' when the episode aired more than two days ago, placeholder name and all", async () => {
    setSetting("episodeTitleRequired", "always");
    const result = await importEpisodeTwo("TBA", daysAgo(3));
    expect(result.outcome).toBeNull();
    expect(path.basename(result.row.file_path!)).toBe("Show - S01E02 - TBA.mkv");
  });

  it("does not wait when the naming format does not use the title", async () => {
    setSetting("episodeTitleRequired", "always");
    setSetting("namingSeriesTemplate", "{parentTitle}/Season {season:00}/{parentTitle} - S{season:00}E{episode:00}");
    const result = await importEpisodeTwo(null, today());
    expect(result.outcome).toBeNull();
    expect(path.basename(result.row.file_path!)).toBe("Show - S01E02.mkv");
  });

  it("does not wait when naming is off for the type, so the release's own file name is kept", async () => {
    setSetting("episodeTitleRequired", "always");
    setSetting("namingEnabledSeries", "0");
    const result = await importEpisodeTwo(null, today());
    expect(result.outcome).toBeNull();
    expect(result.row.has_file).toBe(1);
  });

  it("under 'bulkSeasonReleases' lets a lone recent episode through", async () => {
    setSetting("episodeTitleRequired", "bulkSeasonReleases");
    const result = await importEpisodeTwo("TBA", today());
    expect(result.outcome).toBeNull();
    expect(result.row.has_file).toBe(1);
  });

  it("never holds a manual import: the admin chose the file", async () => {
    setSetting("episodeTitleRequired", "always");
    const result = await importEpisodeTwo("TBA", today(), true);
    expect(result.outcome).toBeNull();
    expect(result.row.has_file).toBe(1);
  });

  it("tells a manual import's preview what an automatic one would do", async () => {
    setSetting("episodeTitleRequired", "always");
    const folder = await insertRootFolder();
    const { showId, ids } = await insertShow(folder.id, [{ n: 2, title: "TBA", airDate: today() }]);
    const download = writeDownloadFile(`${RELEASE}.mkv`);

    const warnings = await importer.manualImportWarnings({ itemId: showId, episodeId: ids[0], sourceFile: download, quality: "WEBDL-1080p" });

    expect(warnings.some((w) => /^Waiting for the episode title: S01E02 .*an automatic import would wait; a manual one goes ahead\)$/.test(w))).toBe(true);
  });
});

describe("a season pack and episodeTitleRequired", () => {
  async function pack(titles: (string | null)[], airDate: string) {
    const folder = await insertRootFolder();
    const { showId, ids } = await insertShow(folder.id, titles.map((title, i) => ({ n: i + 1, title, airDate })));
    const dir = "Show.S01.1080p.WEB-DL.x264-GRP";
    const files = titles.map((_, i) => writeDownloadFile(path.join(dir, `Show.S01E0${i + 1}.mkv`), `ep${i + 1}`));
    const outcome = await importer
      .placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: files[0], quality: "WEBDL-1080p", releaseTitle: dir, verify: true })
      .then(
        () => null,
        (err: Error) => err
      );
    return { outcome, ids, files, folder };
  }

  it("holds the whole pack when one of its episodes is recent and untitled: half a season is not filed", async () => {
    setSetting("episodeTitleRequired", "always");

    const result = await pack(["One", "TBA", "Three"], today());

    expect(result.outcome).toBeInstanceOf(importer.EpisodeTitleHoldError);
    expect(result.outcome?.message).toMatch(/S01E02/);
    for (const file of result.files) expect(fs.existsSync(file)).toBe(true);
    for (const id of result.ids) expect((await episodeRow(id)).has_file).toBe(0);
  });

  it("imports the pack when every episode has its title", async () => {
    setSetting("episodeTitleRequired", "always");
    const result = await pack(["One", "Two", "Three"], today());
    expect(result.outcome).toBeNull();
    for (const id of result.ids) expect((await episodeRow(id)).has_file).toBe(1);
  });

  it("imports the pack under 'never' however many episodes are untitled", async () => {
    const result = await pack(["TBA", "TBA", "TBA"], today());
    expect(result.outcome).toBeNull();
  });

  it("holds a season dropped at once under 'bulkSeasonReleases', and not a pack of old episodes", async () => {
    setSetting("episodeTitleRequired", "bulkSeasonReleases");
    const dropped = await pack(["TBA", "TBA", "TBA", "TBA", "TBA"], today());
    expect(dropped.outcome).toBeInstanceOf(importer.EpisodeTitleHoldError);

    await db.prepare("DELETE FROM episodes").run();
    await db.prepare("DELETE FROM media_items").run();
    await db.prepare("DELETE FROM root_folders").run();
    const old = await pack(["TBA", "TBA", "TBA", "TBA", "TBA"], daysAgo(10));
    expect(old.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Waiting, and trying again
// ---------------------------------------------------------------------------

describe("a held download", () => {
  async function heldRow(title: string | null, airDate: string | null) {
    const folder = await insertRootFolder();
    const { showId, ids } = await insertShow(folder.id, [{ n: 2, title, airDate }]);
    const download = writeDownloadFile(`${RELEASE}.mkv`);
    // As the scheduler leaves it after the first refusal: completed, with the reason.
    const queueId = await queueEpisode(showId, ids[0], download, {
      status: "completed",
      reason: "Waiting for the episode title: S01E02 is still named \"TBA\" and the naming format uses it; it is imported when the title arrives or two days after it aired",
    });
    await db.prepare("UPDATE queue SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(queueId);
    return { queueId, episodeId: ids[0], download, showId };
  }

  it("is imported on the next pass once the episode has its title", async () => {
    setSetting("episodeTitleRequired", "always");
    const held = await heldRow("TBA", today());
    await db.prepare("UPDATE episodes SET title = 'Second' WHERE id = ?").run(held.episodeId); // a metadata refresh named it
    scheduler.__setEpisodeTitleRetryMsForTests(0);

    await scheduler.pollQueue();

    expect(await db.prepare("SELECT 1 FROM queue WHERE id = ?").get(held.queueId)).toBeFalsy();
    const row = await episodeRow(held.episodeId);
    expect(row.has_file).toBe(1);
    expect(path.basename(row.file_path!)).toBe("Show - S01E02 - Second.mkv");
    expect(manualInteraction).not.toHaveBeenCalled();
  });

  it("is imported on the next pass when the admin switches the setting off", async () => {
    setSetting("episodeTitleRequired", "never");
    const held = await heldRow("TBA", today());
    scheduler.__setEpisodeTitleRetryMsForTests(0);

    await scheduler.pollQueue();

    expect(await db.prepare("SELECT 1 FROM queue WHERE id = ?").get(held.queueId)).toBeFalsy();
    expect((await episodeRow(held.episodeId)).has_file).toBe(1);
  });

  it("is imported on the next pass once the episode is more than two days old", async () => {
    setSetting("episodeTitleRequired", "always");
    const held = await heldRow("TBA", today());
    await db.prepare("UPDATE episodes SET air_date = ? WHERE id = ?").run(daysAgo(3), held.episodeId);
    scheduler.__setEpisodeTitleRetryMsForTests(0);

    await scheduler.pollQueue();

    expect((await episodeRow(held.episodeId)).has_file).toBe(1);
  });

  it("waits quietly while the title is still missing: it stays parked, with a fresh reason and no notification", async () => {
    setSetting("episodeTitleRequired", "always");
    const held = await heldRow("TBA", today());
    scheduler.__setEpisodeTitleRetryMsForTests(0);

    await scheduler.pollQueue();

    const row = (await db.prepare("SELECT status, import_started_at, import_skipped_reason FROM queue WHERE id = ?").get(held.queueId)) as {
      status: string;
      import_started_at: string | null;
      import_skipped_reason: string | null;
    };
    expect(row.status).toBe("completed");
    expect(row.import_started_at).toBeNull();
    expect(row.import_skipped_reason).toMatch(/^Waiting for the episode title: S01E02/);
    expect(fs.existsSync(held.download)).toBe(true);
    expect(manualInteraction).not.toHaveBeenCalled();
  });

  it("is looked at again only every ten minutes", async () => {
    setSetting("episodeTitleRequired", "always");
    const held = await heldRow("TBA", today());
    await db.prepare(`UPDATE queue SET updated_at = ${nowExpr(db)} WHERE id = ?`).run(held.queueId);
    await db.prepare("UPDATE episodes SET title = 'Second' WHERE id = ?").run(held.episodeId);

    await scheduler.pollQueue(); // default interval: parked just now, so not yet

    expect(await db.prepare("SELECT 1 FROM queue WHERE id = ?").get(held.queueId)).toBeTruthy();
    expect((await episodeRow(held.episodeId)).has_file).toBe(0);
  });

  it("shows as Starr's importPending, not importBlocked, in the queue API", async () => {
    const held = await heldRow("TBA", today());
    await db.prepare("UPDATE queue SET download_client_id = NULL WHERE id = ?").run(held.queueId);
    const other = Number(
      (await db.prepare(`INSERT INTO queue (media_item_id, title, quality, status, import_skipped_reason) VALUES (?,?,?,?,?)`).run(held.showId, "Other.Release", "WEBDL-1080p", "completed", "A sample")).lastInsertRowid
    );

    const records = (await request(app).get("/sonarr/api/v3/queue?pageSize=50").set("X-Api-Key", apiKey)).body.records as any[];

    expect(records.find((r) => r.id === held.queueId)).toMatchObject({ trackedDownloadState: "importPending", trackedDownloadStatus: "warning" });
    expect(records.find((r) => r.id === held.queueId).statusMessages[0].messages[0]).toMatch(/^Waiting for the episode title/);
    expect(records.find((r) => r.id === other)).toMatchObject({ trackedDownloadState: "importBlocked" });
  });
});

describe("the setting", () => {
  it("takes only the three values", async () => {
    const { settingValueProblem } = await import("../src/services/settingsRegistry.js");
    for (const ok of ["always", "bulkSeasonReleases", "never", ""]) expect(settingValueProblem("episodeTitleRequired", ok), ok).toBeNull();
    expect(settingValueProblem("episodeTitleRequired", "sometimes")).toMatch(/one of: always, bulkSeasonReleases, never/);
  });
});
