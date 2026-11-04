import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

// Round 30e: the custom import script (Sonarr's and Radarr's UseScriptImport / ScriptImportPath). The script runs in place
// of the move; "MoveComplete" (the default), "DeferMove" and "RenameRequested" are what it can say; any other exit code, a
// timeout, or a file that is not where it says is a failed import that leaves the download, and the library file being
// replaced, as they were. The scripts here are small /bin/sh files written into a temp folder by each test.
// The review of the round added: a script's own process group is stopped as a whole (M4), the replaced file is recycled at
// once when the script left something at its place and a journal settles it after a restart (M3), RenameRequested does not
// take another entry's file (M2), the reported file may not be a link (L7), the script gets an allow-list environment (L8)
// and a season pack whose later file fails is still closed off for the files before it (L9).

vi.mock("../src/services/notifications.js", () => ({
  notifyImported: vi.fn(),
  notifyUpgraded: vi.fn(),
  notifyManualInteractionRequired: vi.fn().mockResolvedValue(undefined),
  notifyRenamed: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../src/services/downloadClient.js", () => ({
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
let script: typeof import("../src/services/importScript.js");
let setAside: typeof import("../src/services/importScriptSetAside.js");
let notifications: typeof import("../src/services/notifications.js");
let settingValueProblem: (typeof import("../src/services/settingsRegistry.js"))["settingValueProblem"];
let importScriptIssues: (typeof import("../src/services/healthReport.js"))["importScriptIssues"];

let downloadsDir: string;
let libraryDir: string;
let scriptDir: string;

beforeAll(async () => {
  ({ db, app, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  importer = await import("../src/services/importer.js");
  script = await import("../src/services/importScript.js");
  setAside = await import("../src/services/importScriptSetAside.js");
  notifications = await import("../src/services/notifications.js");
  ({ settingValueProblem } = await import("../src/services/settingsRegistry.js"));
  ({ importScriptIssues } = await import("../src/services/healthReport.js"));
  await (await import("../src/services/quality.js")).loadQualityCaches();
  downloadsDir = path.join(config.downloadsDir, "test-fixtures-import-script");
});

beforeEach(async () => {
  for (const t of ["history", "recycle_bin", "queue", "download_clients", "tracks", "episodes", "sub_items", "media_items", "root_folders"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  unpackDownloadedArchives.mockReset().mockResolvedValue({ extracted: [], failed: [] });
  script.__setImportScriptTimeoutMsForTests(null);
  fs.rmSync(setAside.setAsideJournalPath(), { force: true });
  vi.mocked(notifications.notifyImported).mockClear();
  vi.mocked(notifications.notifyUpgraded).mockClear();

  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-import-script-lib-"));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-import-script-bin-"));

  setSetting("useScriptImport", "");
  setSetting("scriptImportPath", "");
  setSetting("enableMediaInfo", "0");
  setSetting("skipFreeSpaceCheck", "1");
  setSetting("minimumFreeSpaceMb", "0");
  setSetting("removeCompletedDownloads", "0");
  setSetting("writeNfoOnImport", "0");
  setSetting("setPermissionsEnabled", "0");
  setSetting("subtitleSyncEnabled", "0");
  setSetting("importStrategy", "move");
  setSetting("importExtraFiles", "");
  setSetting("fileDate", "");
  setSetting("recycleBinEnabled", "1");
  setSetting("recycleBinDir", path.join(libraryDir, ".recycle-bin"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(libraryDir, { recursive: true, force: true });
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

/** Writes an executable /bin/sh script and returns its path. */
function writeScript(name: string, lines: string[], mode = 0o755): string {
  const p = path.join(scriptDir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${lines.join("\n")}\n`);
  fs.chmodSync(p, mode);
  return p;
}

function useScript(p: string): void {
  setSetting("useScriptImport", "1");
  setSetting("scriptImportPath", p);
}

async function insertRootFolder(mediaType: string): Promise<{ id: number; path: string }> {
  const p = path.join(libraryDir, mediaType);
  fs.mkdirSync(p, { recursive: true });
  const result = await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, ?, ?)").run(p, mediaType, mediaType);
  return { id: Number(result.lastInsertRowid), path: p };
}

function writeDownloadFile(name: string, content = "new"): string {
  const p = path.join(downloadsDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

async function insertMovie(rootFolderId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const row = { has_file: 0, path: null, quality: null, ...overrides };
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, quality, monitored, status, external_ids)
       VALUES ('movie', 'The Matrix', 'the matrix', 1999, ?, ?, ?, ?, 1, 'missing', '{"tmdb":"603","imdb":"tt0133093"}')`
    )
    .run(rootFolderId, row.has_file, row.path, row.quality);
  return Number(result.lastInsertRowid);
}

const RELEASE = "The.Matrix.1999.1080p.WEB-DL.x264-GRP";

async function queueRow(mediaItemId: number, downloadPath: string, quality = "WEBDL-1080p"): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO queue (media_item_id, title, quality, download_path, grab_source, status) VALUES (?,?,?,?,NULL, 'downloaded')`)
    .run(mediaItemId, RELEASE, quality, downloadPath);
  return Number(result.lastInsertRowid);
}

/** An automatic import of a download of the movie, and what is left of it. */
async function importMovie(options: { existing?: boolean } = {}) {
  const folder = await insertRootFolder("movie");
  const dest = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
  let movieId: number;
  if (options.existing) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "old");
    movieId = await insertMovie(folder.id, { has_file: 1, path: dest, quality: "HDTV-720p" });
  } else {
    movieId = await insertMovie(folder.id);
  }
  const download = writeDownloadFile(`${RELEASE}.mkv`);
  const queueId = await queueRow(movieId, download);
  const outcome = await importer.importQueueItem(queueId).then(
    () => null,
    (err: Error) => err
  );
  const row = (await db.prepare("SELECT has_file, path FROM media_items WHERE id = ?").get(movieId)) as { has_file: number; path: string | null };
  const queued = await db.prepare("SELECT id FROM queue WHERE id = ?").get(queueId);
  return { outcome, row, dest, download, folder, movieId, queued };
}

function envFrom(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

describe("the script's output, as Starr reads it", () => {
  it("defaults to MoveComplete when it prints no status, and reads every marker", () => {
    expect(script.parseScriptOutput("")).toEqual({ status: "MoveComplete", mediaFile: null, extraFiles: [], importExtraFiles: true });
    expect(script.parseScriptOutput("chatter\r\n[MoveStatus] DeferMove\r\n").status).toBe("DeferMove");
    expect(script.parseScriptOutput("[MoveStatus]RenameRequested").status).toBe("RenameRequested");
    const full = script.parseScriptOutput("[MediaFile] /lib/a b.mkv\n[ExtraFile] /lib/a b.srt\n[ExtraFile] /lib/a b.en.srt\n[PreventExtraImport]\n[MoveStatus] MoveComplete\n");
    expect(full).toEqual({ status: "MoveComplete", mediaFile: "/lib/a b.mkv", extraFiles: ["/lib/a b.srt", "/lib/a b.en.srt"], importExtraFiles: false });
  });

  it("refuses two media files", () => {
    expect(() => script.parseScriptOutput("[MediaFile] /a.mkv\n[MediaFile] /b.mkv\n")).toThrow(script.ImportScriptError);
  });
});

describe("the path setting", () => {
  it("is checked when it is saved: it must exist, be a file and be executable", () => {
    const ok = writeScript("ok.sh", ["exit 0"]);
    expect(settingValueProblem("scriptImportPath", ok)).toBeNull();
    expect(settingValueProblem("scriptImportPath", "")).toBeNull(); // clearing it
    expect(settingValueProblem("scriptImportPath", path.join(scriptDir, "missing.sh"))).toMatch(/does not exist/);
    expect(settingValueProblem("scriptImportPath", scriptDir)).toMatch(/is not a file/);
    expect(settingValueProblem("scriptImportPath", writeScript("plain.sh", ["exit 0"], 0o644))).toMatch(/not executable/);
    expect(settingValueProblem("scriptImportPath", "relative/run.sh")).toMatch(/absolute path/);
    expect(settingValueProblem("useScriptImport", "maybe")).toMatch(/one of: 1, 0/);
  });

  it("is refused by PUT /api/settings with the reason", async () => {
    const request = (await import("supertest")).default;
    const res = await request(app).put("/api/settings/scriptImportPath").set("X-Api-Key", apiKey).send({ value: path.join(scriptDir, "nope.sh") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
    const good = await request(app).put("/api/settings/scriptImportPath").set("X-Api-Key", apiKey).send({ value: writeScript("good.sh", ["exit 0"]) });
    expect(good.status).toBe(200);
  });

  it("shows up in Health as an error while the script is on and cannot run, and not otherwise", async () => {
    expect(await importScriptIssues()).toEqual([]);
    setSetting("useScriptImport", "1");
    setSetting("scriptImportPath", path.join(scriptDir, "gone.sh"));
    const issues = await importScriptIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ source: "import-script", severity: "error" });
    expect(issues[0].message).toMatch(/does not exist/);
    useScript(writeScript("here.sh", ["exit 0"]));
    expect(await importScriptIssues()).toEqual([]);
    setSetting("useScriptImport", "0");
    setSetting("scriptImportPath", path.join(scriptDir, "gone.sh"));
    expect(await importScriptIssues()).toEqual([]);
  });
});

describe("runImportScript", () => {
  const request = (overrides: Partial<import("../src/services/importScript.js").ImportScriptRequest> = {}) => ({
    sourcePath: path.join(downloadsDir, "a.mkv"),
    destinationPath: path.join(libraryDir, "movie", "a.mkv"),
    env: { ...process.env },
    rootFolderPath: path.join(libraryDir, "movie"),
    mediaExtensions: [".mkv"],
    ...overrides,
  });

  beforeEach(() => fs.mkdirSync(path.join(libraryDir, "movie"), { recursive: true }));

  it("hands the two paths over as two arguments and nothing else, never through a shell", async () => {
    // A name that a shell would act on: it stays one argument, and nothing it spells out is run.
    const nasty = path.join(downloadsDir, "x $(touch HACKED1); touch HACKED2 `touch HACKED3` 'q\" y.mkv");
    const dest = path.join(libraryDir, "movie", "d.mkv");
    const record = path.join(scriptDir, "args.txt");
    useScript(writeScript("args.sh", [`printf '%s\\n' "$#" "$1" "$2" > "${record}"`, 'printf x > "$2"']));

    const result = await script.runImportScript(request({ sourcePath: nasty, destinationPath: dest }));

    expect(fs.readFileSync(record, "utf-8").split("\n").slice(0, 3)).toEqual(["2", nasty, dest]);
    expect(result).toMatchObject({ status: "MoveComplete", finalPath: dest });
    for (const marker of ["HACKED1", "HACKED2", "HACKED3"]) expect(fs.existsSync(path.join(process.cwd(), marker))).toBe(false);
  });

  it("fails on a non-zero exit code, naming it and the script's last words", async () => {
    useScript(writeScript("fail.sh", ["echo 'disk quota exceeded' >&2", "exit 7"]));
    await expect(script.runImportScript(request())).rejects.toThrow(/exited with code 7 \(disk quota exceeded\)/);
  });

  it("stops a script that runs past the timeout, at once, without waiting for it", async () => {
    script.__setImportScriptTimeoutMsForTests(300);
    useScript(writeScript("hang.sh", ["exec sleep 30"]));
    const started = Date.now();
    await expect(script.runImportScript(request())).rejects.toThrow(/ran for more than \d+ seconds and was stopped/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  describe("a script that is stopped takes everything it started with it", () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("kills the whole process group on a timeout: a background child never writes its file", async () => {
      script.__setImportScriptTimeoutMsForTests(300);
      const late = path.join(scriptDir, "late.txt");
      // The shell is killed at 300 ms; the subshell it started would write at 1 s if only the shell were stopped.
      useScript(writeScript("background.sh", [`(sleep 1; echo late > "${late}") &`, "sleep 30"]));

      await expect(script.runImportScript(request())).rejects.toThrow(/ran for more than \d+ seconds and was stopped/);
      await pause(2000);

      expect(fs.existsSync(late)).toBe(false);
    });

    it("kills it at the output limit too, at once, even while a child it started holds the pipes", async () => {
      const late = path.join(scriptDir, "late.txt");
      useScript(writeScript("flood.sh", [`(sleep 1; echo late > "${late}") &`, "head -c 6000000 /dev/zero | tr '\\0' x", "sleep 30"]));
      const started = Date.now();

      await expect(script.runImportScript(request())).rejects.toThrow(/printed too much output/);
      expect(Date.now() - started).toBeLessThan(10_000);
      await pause(2000);

      expect(fs.existsSync(late)).toBe(false);
    });

    it("kills what a script that exits with an error left running", async () => {
      const late = path.join(scriptDir, "late.txt");
      useScript(writeScript("leaves.sh", [`(sleep 1; echo late > "${late}") &`, "echo 'gave up' >&2", "exit 3"]));

      await expect(script.runImportScript(request())).rejects.toThrow(/exited with code 3 \(gave up\)/);
      await pause(2000);

      expect(fs.existsSync(late)).toBe(false);
    });
  });

  it("fails on a script it cannot start", async () => {
    const bad = writeScript("bad.sh", ["exit 0"]);
    fs.writeFileSync(bad, "not a program\n"); // executable, but with no shebang and not a binary
    useScript(bad);
    await expect(script.runImportScript(request())).rejects.toThrow(script.ImportScriptError);
  });

  it("refuses a reported file that is not a media file, does not exist, or lies outside the root folder", async () => {
    const root = path.join(libraryDir, "movie");
    fs.writeFileSync(path.join(root, "note.txt"), "x");
    fs.writeFileSync(path.join(libraryDir, "outside.mkv"), "x");
    fs.writeFileSync(path.join(root, "in.mkv"), "x");
    const reply = (file: string) => {
      useScript(writeScript("reply.sh", [`echo '[MediaFile] ${file}'`]));
      return script.runImportScript(request());
    };
    await expect(reply(path.join(root, "note.txt"))).rejects.toThrow(/not a media file/);
    await expect(reply(path.join(root, "missing.mkv"))).rejects.toThrow(/does not exist/);
    await expect(reply(path.join(libraryDir, "outside.mkv"))).rejects.toThrow(/outside the root folder/);
    await expect(reply("in.mkv")).rejects.toThrow(/not an absolute path/);
    await expect(reply(path.join(root, "in.mkv"))).resolves.toMatchObject({ finalPath: path.join(root, "in.mkv") });
  });

  it("refuses a reported file that is a link unless the symlink strategy is in use, and any file that really lies outside the root folder", async () => {
    const root = path.join(libraryDir, "movie");
    const elsewhere = path.join(libraryDir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "real.mkv"), "x");
    fs.symlinkSync(path.join(elsewhere, "real.mkv"), path.join(elsewhere, "inner-link.mkv"));
    fs.symlinkSync(path.join(elsewhere, "real.mkv"), path.join(root, "link.mkv"));
    fs.symlinkSync(elsewhere, path.join(root, "linked-dir"));
    const reply = (file: string, allowSymlink?: boolean) => {
      useScript(writeScript("reply.sh", [`echo '[MediaFile] ${file}'`]));
      return script.runImportScript(request({ allowSymlink }));
    };

    // A link to a file that is inside the root folder or not: refused, whatever it points at.
    await expect(reply(path.join(root, "link.mkv"))).rejects.toThrow(/symbolic link/);
    // The symlink strategy keeps links in the library: the link's own place is what has to be inside the root folder.
    await expect(reply(path.join(root, "link.mkv"), true)).resolves.toMatchObject({ finalPath: path.join(root, "link.mkv") });
    // A real file reached through a link to a folder outside the root is outside it, though its name is inside.
    await expect(reply(path.join(root, "linked-dir", "real.mkv"))).rejects.toThrow(/resolves to .*outside the root folder/);
    // And a link made inside that outside folder is outside as well, even where links are allowed.
    await expect(reply(path.join(root, "linked-dir", "inner-link.mkv"), true)).rejects.toThrow(/resolves to .*outside the root folder/);
  });

  it("asks for a file at the destination when it reports none and prints no DeferMove", async () => {
    useScript(writeScript("nothing.sh", ["exit 0"]));
    await expect(script.runImportScript(request())).rejects.toThrow(/finished without putting a file/);
    useScript(writeScript("defer.sh", ["echo '[MoveStatus] DeferMove'"]));
    await expect(script.runImportScript(request())).resolves.toMatchObject({ status: "DeferMove", finalPath: null });
  });

  it("gives the script the variables a program needs and none of the server's own configuration", () => {
    const wanted = { PATH: "/usr/bin", HOME: "/home/aonarr", LANG: "C.UTF-8", LC_ALL: "C", TZ: "Europe/Oslo", TMPDIR: "/tmp", PUID: "99", PGID: "100", USER: "nobody" };
    const secrets = {
      AONARR_ADMIN_PASSWORD: "canary-admin-password",
      AONARR_DATABASE_URL: "postgres://aonarr:canary@db/aonarr",
      AONARR_API_KEY_FILE: "/run/secrets/canary",
      AONARR_CANARY_TOKEN: "canary-token",
      SOME_SERVICE_TOKEN: "canary-service-token",
    };
    const saved = { ...process.env };
    try {
      Object.assign(process.env, wanted, secrets);
      const env = script.scriptEnvironment({
        shape: "single",
        sourcePath: "/dl/a.mkv",
        destinationPath: "/lib/a.mkv",
        transferMode: "move",
        mediaType: "movie",
        item: { id: 1, title: "A", year: 2000, folder: "/lib", externalIds: {}, seriesType: null },
        season: null,
        episodes: [],
        quality: null,
        releaseTitle: null,
        releaseGroup: null,
        downloadId: null,
        downloadClientId: null,
        deletedPaths: [],
      });
      expect(env).toMatchObject(wanted);
      for (const name of Object.keys(secrets)) expect(env[name], name).toBeUndefined();
      expect(Object.values(env).join("\n")).not.toContain("canary");
      expect(env.AONARR_SOURCE_PATH).toBe("/dl/a.mkv"); // the names the module defines are still there
      expect(env.Radarr_Movie_Title).toBe("A");
    } finally {
      for (const name of Object.keys({ ...wanted, ...secrets })) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  it("builds the environment with AONARR_ names and Starr's, for a film and for a show", () => {
    const base = {
      sourcePath: "/dl/a.mkv",
      destinationPath: "/lib/a.mkv",
      transferMode: "hardlink",
      mediaType: "movie",
      item: { id: 7, title: "The Matrix", year: 1999, folder: "/lib/The Matrix (1999)", externalIds: { tmdb: "603", imdb: "tt0133093", tvdb: "290" }, seriesType: null },
      season: null,
      episodes: [],
      quality: "WEBDL-1080p",
      releaseTitle: "The.Matrix.1999.1080p.WEB-DL.x264-GRP",
      releaseGroup: "GRP",
      downloadId: "abc123",
      downloadClientId: 4,
      deletedPaths: ["/lib/old.mkv"],
    };
    const film = script.scriptEnvironment({ ...base, shape: "single" });
    expect(film).toMatchObject({
      AONARR_SOURCE_PATH: "/dl/a.mkv",
      AONARR_DESTINATION_PATH: "/lib/a.mkv",
      AONARR_TRANSFER_MODE: "hardlink",
      AONARR_ITEM_TITLE: "The Matrix",
      AONARR_ITEM_YEAR: "1999",
      AONARR_TMDB_ID: "603",
      AONARR_IMDB_ID: "tt0133093",
      AONARR_QUALITY: "WEBDL-1080p",
      AONARR_RELEASE_GROUP: "GRP",
      AONARR_DOWNLOAD_ID: "abc123",
      AONARR_DELETED_PATHS: "/lib/old.mkv",
      Radarr_Movie_Title: "The Matrix",
      Radarr_Movie_TmdbId: "603",
      Radarr_MovieFile_ReleaseGroup: "GRP",
      Radarr_TransferMode: "HardLinkOrCopy",
      Radarr_DeletedPaths: "/lib/old.mkv",
    });
    expect(film.Sonarr_Series_Title).toBeUndefined();

    const show = script.scriptEnvironment({
      ...base,
      shape: "episodic",
      mediaType: "series",
      item: { ...base.item, title: "Show", seriesType: "anime" },
      season: 2,
      episodes: [
        { id: 11, number: 3, airDate: "2026-01-02", title: "Three" },
        { id: 12, number: 4, airDate: "2026-01-09", title: "Four|Pipe" },
      ],
      deletedPaths: [],
    });
    expect(show).toMatchObject({
      AONARR_SEASON_NUMBER: "2",
      AONARR_EPISODE_COUNT: "2",
      AONARR_EPISODE_IDS: "11,12",
      AONARR_EPISODE_NUMBERS: "3,4",
      AONARR_EPISODE_AIR_DATES: "2026-01-02,2026-01-09",
      AONARR_EPISODE_TITLES: "Three|Four|Pipe",
      AONARR_SERIES_TYPE: "anime",
      Sonarr_Series_Title: "Show",
      Sonarr_Series_Type: "Anime",
      Sonarr_EpisodeFile_SeasonNumber: "2",
      Sonarr_EpisodeFile_EpisodeNumbers: "3,4",
      Sonarr_EpisodeFile_Quality: "WEBDL-1080p",
    });
    expect(show.Sonarr_DeletedPaths).toBe("");
    expect(show.Radarr_Movie_Title).toBeUndefined();
  });
});

describe("an import through the script", () => {
  it("lets the script move the file (MoveComplete is the default), tells it everything, and records the destination", async () => {
    const envFile = path.join(scriptDir, "env.txt");
    useScript(writeScript("move.sh", [`env > "${envFile}"`, 'mv "$1" "$2"']));

    process.env.AONARR_ADMIN_PASSWORD = "canary-admin-password";
    process.env.AONARR_CANARY_API_KEY = "canary-api-key";
    let result: Awaited<ReturnType<typeof importMovie>>;
    try {
      result = await importMovie();
    } finally {
      delete process.env.AONARR_ADMIN_PASSWORD;
      delete process.env.AONARR_CANARY_API_KEY;
    }

    expect(result.outcome).toBeNull();
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("new");
    expect(fs.existsSync(result.download)).toBe(false); // the script moved it
    // The server's own configuration stays out of the script's environment; what a program needs to run is in it.
    const seen = fs.readFileSync(envFile, "utf-8");
    expect(seen).not.toContain("canary-admin-password");
    expect(seen).not.toContain("canary-api-key");
    expect(seen).toMatch(/^PATH=/m);
    expect(result.row).toMatchObject({ has_file: 1, path: result.dest });
    expect(result.queued).toBeFalsy();
    const history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'imported'").all(result.movieId)) as { data: string }[];
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0].data)).toMatchObject({ destPath: result.dest, quality: "WEBDL-1080p" });

    const env = envFrom(envFile);
    expect(env).toMatchObject({
      AONARR_SOURCE_PATH: result.download,
      AONARR_DESTINATION_PATH: result.dest,
      AONARR_TRANSFER_MODE: "move",
      AONARR_MEDIA_TYPE: "movie",
      AONARR_ITEM_TITLE: "The Matrix",
      AONARR_ITEM_YEAR: "1999",
      AONARR_TMDB_ID: "603",
      AONARR_IMDB_ID: "tt0133093",
      AONARR_QUALITY: "WEBDL-1080p",
      AONARR_RELEASE_GROUP: "GRP",
      AONARR_RELEASE_TITLE: RELEASE,
      Radarr_Movie_Title: "The Matrix",
      Radarr_MovieFile_Quality: "WEBDL-1080p",
      Radarr_SourcePath: result.download,
    });
  });

  it("moves the file itself when the script defers (DeferMove), with the usual rules", async () => {
    const marker = path.join(scriptDir, "ran.txt");
    useScript(writeScript("defer.sh", [`echo ran > "${marker}"`, "echo '[MoveStatus] DeferMove'"]));

    const result = await importMovie();

    expect(result.outcome).toBeNull();
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("new");
    expect(fs.existsSync(result.download)).toBe(false);
    expect(result.row).toMatchObject({ has_file: 1, path: result.dest });
  });

  it("renames the file to the destination when the script asks for it (RenameRequested)", async () => {
    const root = path.join(libraryDir, "movie");
    const filedAs = path.join(root, "Scripted Name.mkv");
    useScript(writeScript("rename.sh", [`mv "$1" "${filedAs}"`, `echo '[MediaFile] ${filedAs}'`, "echo '[MoveStatus] RenameRequested'"]));

    const result = await importMovie();

    expect(result.outcome).toBeNull();
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("new");
    expect(fs.existsSync(filedAs)).toBe(false);
    expect(result.row).toMatchObject({ has_file: 1, path: result.dest });
  });

  it("records the path the script reports when it filed the video somewhere of its own inside the root folder", async () => {
    const filedAs = path.join(libraryDir, "movie", "Custom", "Matrix.mkv");
    useScript(writeScript("elsewhere.sh", [`mkdir -p "${path.dirname(filedAs)}"`, `mv "$1" "${filedAs}"`, `echo '[MediaFile] ${filedAs}'`]));

    const result = await importMovie();

    expect(result.outcome).toBeNull();
    expect(result.row).toMatchObject({ has_file: 1, path: filedAs });
    expect(fs.existsSync(result.dest)).toBe(false);
    const history = (await db.prepare("SELECT data FROM history WHERE media_item_id = ? AND event_type = 'imported'").get(result.movieId)) as { data: string };
    expect(JSON.parse(history.data).destPath).toBe(filedAs);
  });

  it("fails the import when the script fails, leaving the download in place and nothing in the library", async () => {
    useScript(writeScript("fail.sh", ["echo 'could not reach the NAS' >&2", "exit 3"]));

    const result = await importMovie();

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(/exited with code 3 \(could not reach the NAS\)/);
    expect(result.outcome).not.toBeInstanceOf(importer.ImportSkippedError);
    expect(fs.readFileSync(result.download, "utf-8")).toBe("new");
    expect(result.row).toMatchObject({ has_file: 0, path: null });
    expect(result.queued).toBeTruthy(); // the row stays for a retry
    expect(fs.existsSync(path.dirname(result.dest))).toBe(false); // the folder the import made is gone again
    expect(await db.prepare("SELECT 1 FROM history WHERE media_item_id = ? AND event_type = 'imported'").get(result.movieId)).toBeFalsy();
  });

  it("fails the import, with the download untouched, when the script runs past the timeout", async () => {
    script.__setImportScriptTimeoutMsForTests(300);
    useScript(writeScript("hang.sh", ["exec sleep 30"]));

    const result = await importMovie();

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(/ran for more than/);
    expect(fs.readFileSync(result.download, "utf-8")).toBe("new");
    expect(result.row.has_file).toBe(0);
  });

  it("fails the import when the script says it moved the file and no file is there", async () => {
    useScript(writeScript("liar.sh", ["exit 0"]));

    const result = await importMovie();

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(/finished without putting a file/);
    expect(fs.readFileSync(result.download, "utf-8")).toBe("new"); // not touched by AoNarr
    expect(result.row.has_file).toBe(0);
  });

  it("fails the import, leaving the script's file alone, when it files the video outside the root folder", async () => {
    const outside = path.join(libraryDir, "elsewhere.mkv");
    useScript(writeScript("outside.sh", [`mv "$1" "${outside}"`, `echo '[MediaFile] ${outside}'`]));

    const result = await importMovie();

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(/outside the root folder/);
    expect(result.row.has_file).toBe(0);
    expect(fs.existsSync(outside)).toBe(true); // nothing of the script's is deleted
  });

  it("refuses a link as the reported file after a move-style import: it would dangle when the download is cleared", async () => {
    const root = path.join(libraryDir, "movie");
    const link = path.join(root, "linked.mkv");
    useScript(writeScript("link.sh", [`ln -s "$1" "${link}"`, `echo '[MediaFile] ${link}'`]));

    const result = await importMovie();

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(/symbolic link/);
    expect(result.row.has_file).toBe(0);
    expect(fs.existsSync(result.download)).toBe(true);
  });

  it("keeps the link a script makes when the import strategy is symlink", async () => {
    setSetting("importStrategy", "symlink");
    useScript(writeScript("link.sh", ['ln -s "$1" "$2"']));

    const result = await importMovie();

    expect(result.outcome).toBeNull();
    expect(fs.lstatSync(result.dest).isSymbolicLink()).toBe(true);
    expect(result.row).toMatchObject({ has_file: 1, path: result.dest });
    expect(fs.existsSync(result.download)).toBe(true); // a link needs its target
  });

  it("does not move another title's file when the script asks for RenameRequested on it", async () => {
    const folder = await insertRootFolder("movie");
    const theirs = path.join(folder.path, "Other Movie (2000)", "Other Movie (2000).mkv");
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, "theirs");
    await db
      .prepare(`INSERT INTO media_items (type, title, sort_title, year, root_folder_id, has_file, path, monitored, status) VALUES ('movie', 'Other Movie', 'other movie', 2000, ?, 1, ?, 1, 'missing')`)
      .run(folder.id, theirs);
    useScript(writeScript("take.sh", [`echo '[MediaFile] ${theirs}'`, "echo '[MoveStatus] RenameRequested'"]));
    const movieId = await insertMovie(folder.id);
    const queueId = await queueRow(movieId, writeDownloadFile(`${RELEASE}.mkv`));

    const err = await importer.importQueueItem(queueId).catch((e: Error) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect((err as Error).message).toMatch(/already another library entry's file/);
    expect(fs.readFileSync(theirs, "utf-8")).toBe("theirs"); // not moved
    expect(fs.existsSync(path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv"))).toBe(false);
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(movieId)) as { has_file: number }).has_file).toBe(0);
  });

  it("runs nothing while the script is off, however it is configured", async () => {
    const marker = path.join(scriptDir, "ran.txt");
    setSetting("scriptImportPath", writeScript("never.sh", [`echo ran > "${marker}"`, "exit 9"]));
    setSetting("useScriptImport", "0");

    const result = await importMovie();

    expect(result.outcome).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("new");
  });

  it.each([
    ["no path", "", /no script path is set/],
    ["a path that is not there", "MISSING", /does not exist/],
    ["a file that is not executable", "PLAIN", /not executable/],
  ])("runs nothing and fails the import when the script is on with %s", async (_label, which, expected) => {
    const marker = path.join(scriptDir, "ran.txt");
    const target = which === "" ? "" : which === "MISSING" ? path.join(scriptDir, "missing.sh") : writeScript("plain.sh", [`echo ran > "${marker}"`], 0o644);
    setSetting("useScriptImport", "1");
    setSetting("scriptImportPath", target);

    const result = await importMovie();

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(expected);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(result.download, "utf-8")).toBe("new");
    expect(result.row.has_file).toBe(0);
    expect(fs.existsSync(path.dirname(result.dest))).toBe(false); // it did not even make the folder
  });
});

describe("an upgrade through the script keeps the library file being replaced safe", () => {
  it("recycles the old file under its own path once the script has put the new one in its place", async () => {
    useScript(writeScript("overwrite.sh", ['mv -f "$1" "$2"'])); // overwrites its destination, as scripts do

    const result = await importMovie({ existing: true });

    expect(result.outcome).toBeNull();
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("new");
    const recycled = (await db.prepare("SELECT original_path, recycle_path FROM recycle_bin").all()) as { original_path: string; recycle_path: string }[];
    expect(recycled).toHaveLength(1);
    expect(recycled[0].original_path).toBe(result.dest);
    expect(fs.readFileSync(recycled[0].recycle_path, "utf-8")).toBe("old");
    expect(fs.readdirSync(path.dirname(result.dest))).toEqual(["The Matrix (1999).mkv"]); // no set-aside folder left behind
  });

  it("puts the old file back when the script fails", async () => {
    useScript(writeScript("fail.sh", ["exit 4"]));

    const result = await importMovie({ existing: true });

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("old");
    expect(fs.readdirSync(path.dirname(result.dest))).toEqual(["The Matrix (1999).mkv"]);
    expect(fs.readFileSync(result.download, "utf-8")).toBe("new");
    expect(await db.prepare("SELECT 1 FROM recycle_bin").get()).toBeFalsy();
  });

  it("recycles the old file at once, under its own path, and says so, when the script failed after writing something to its place", async () => {
    useScript(writeScript("partial.sh", ['printf partial > "$2"', "exit 1"]));

    const result = await importMovie({ existing: true });

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    // Nothing is left in a hidden folder: the script's file is at the destination, the old one is in the bin.
    expect(fs.readdirSync(path.dirname(result.dest))).toEqual(["The Matrix (1999).mkv"]);
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("partial");
    const recycled = (await db.prepare("SELECT original_path, recycle_path FROM recycle_bin").all()) as { original_path: string; recycle_path: string }[];
    expect(recycled).toHaveLength(1);
    expect(recycled[0].original_path).toBe(result.dest);
    expect(fs.readFileSync(recycled[0].recycle_path, "utf-8")).toBe("old");
    expect(result.outcome?.message).toContain(`something is at "${result.dest}", so the file it replaces was moved to the recycle bin`);
    expect(fs.readFileSync(result.download, "utf-8")).toBe("new");
    expect(fs.existsSync(setAside.setAsideJournalPath())).toBe(false); // settled, so struck out
  });

  it("recycles the old file at once when the script's link at the destination is refused, so a retry has nothing hidden to miss", async () => {
    useScript(writeScript("link.sh", ['ln -s "$1" "$2"']));

    const result = await importMovie({ existing: true });

    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(result.outcome?.message).toMatch(/symbolic link/);
    expect(fs.readdirSync(path.dirname(result.dest)).filter((name) => name.startsWith(".aonarr-replaced-"))).toEqual([]);
    const recycled = (await db.prepare("SELECT original_path, recycle_path FROM recycle_bin").all()) as { original_path: string; recycle_path: string }[];
    expect(recycled.map((r) => r.original_path)).toEqual([result.dest]);
    expect(fs.readFileSync(recycled[0].recycle_path, "utf-8")).toBe("old");
  });

  it("writes the replaced file down before the script runs, and strikes it out once the import is settled", async () => {
    const during = path.join(scriptDir, "journal-during.json");
    useScript(writeScript("peek.sh", [`cp "${setAside.setAsideJournalPath()}" "${during}"`, 'mv -f "$1" "$2"']));

    const result = await importMovie({ existing: true });

    expect(result.outcome).toBeNull();
    const listed = JSON.parse(fs.readFileSync(during, "utf-8")) as { original: string; dir: string; file: string; mediaType: string; title: string; mediaItemId: number }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ original: result.dest, mediaType: "movie", title: "The Matrix", mediaItemId: result.movieId });
    expect(path.basename(listed[0].dir)).toMatch(/^\.aonarr-replaced-/);
    expect(listed[0].file).toBe(path.join(listed[0].dir, "The Matrix (1999).mkv"));
    expect(fs.existsSync(setAside.setAsideJournalPath())).toBe(false);
  });

  it("strikes the journal entry out when the old file is put back too", async () => {
    useScript(writeScript("fail.sh", ["exit 4"]));
    const result = await importMovie({ existing: true });
    expect(result.outcome).toBeInstanceOf(script.ImportScriptError);
    expect(fs.existsSync(setAside.setAsideJournalPath())).toBe(false);
  });

  it("leaves the replacing to AoNarr when the script defers", async () => {
    useScript(writeScript("defer.sh", ["echo '[MoveStatus] DeferMove'"]));

    const result = await importMovie({ existing: true });

    expect(result.outcome).toBeNull();
    expect(fs.readFileSync(result.dest, "utf-8")).toBe("new");
    const recycled = (await db.prepare("SELECT recycle_path FROM recycle_bin").all()) as { recycle_path: string }[];
    expect(recycled).toHaveLength(1);
    expect(fs.readFileSync(recycled[0].recycle_path, "utf-8")).toBe("old");
  });

  it("still refuses a destination that holds a file no row owns, without running the script", async () => {
    const marker = path.join(scriptDir, "ran.txt");
    useScript(writeScript("never.sh", [`echo ran > "${marker}"`, 'mv "$1" "$2"']));
    const folder = await insertRootFolder("movie");
    const dest = path.join(folder.path, "The Matrix (1999)", "The Matrix (1999).mkv");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "somebody else's, and of another size");
    const movieId = await insertMovie(folder.id);
    const queueId = await queueRow(movieId, writeDownloadFile(`${RELEASE}.mkv`));

    const err = await importer.importQueueItem(queueId).catch((e: Error) => e);

    expect(err).toBeInstanceOf(importer.ImportSkippedError);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(dest, "utf-8")).toBe("somebody else's, and of another size");
  });
});

describe("a restart in the middle of a script run", () => {
  /** A library file set aside as the importer does it, and its journal entry: what a process stopped mid-script leaves behind. */
  function leftBehind(original: string, content = "old") {
    const dir = path.join(path.dirname(original), ".aonarr-replaced-deadbeef");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(original));
    fs.writeFileSync(file, content);
    const entry = { original, dir, file, mediaType: "movie", title: "The Matrix", mediaItemId: null };
    setAside.recordSetAside(entry);
    return entry;
  }

  it("puts the old file back at the next start when nothing is at its place", async () => {
    const original = path.join(libraryDir, "movie", "The Matrix (1999)", "The Matrix (1999).mkv");
    const entry = leftBehind(original);

    const tally = await setAside.sweepSetAside();

    expect(tally).toEqual({ restored: 1, recycled: 0, kept: 0, gone: 0 });
    expect(fs.readFileSync(original, "utf-8")).toBe("old");
    expect(fs.existsSync(entry.dir)).toBe(false);
    expect(fs.existsSync(setAside.setAsideJournalPath())).toBe(false);
  });

  it("recycles it, under its original path, when something is there: the script's file is never overwritten", async () => {
    const original = path.join(libraryDir, "movie", "The Matrix (1999)", "The Matrix (1999).mkv");
    const entry = leftBehind(original);
    fs.writeFileSync(original, "the script's");

    const tally = await setAside.sweepSetAside();

    expect(tally).toEqual({ restored: 0, recycled: 1, kept: 0, gone: 0 });
    expect(fs.readFileSync(original, "utf-8")).toBe("the script's");
    expect(fs.existsSync(entry.dir)).toBe(false);
    const recycled = (await db.prepare("SELECT original_path, recycle_path FROM recycle_bin").all()) as { original_path: string; recycle_path: string }[];
    expect(recycled).toHaveLength(1);
    expect(recycled[0].original_path).toBe(original);
    expect(fs.readFileSync(recycled[0].recycle_path, "utf-8")).toBe("old");
    expect(fs.existsSync(setAside.setAsideJournalPath())).toBe(false);
  });

  it("settles each entry on its own, and ignores one whose set-aside file is gone", async () => {
    const free = path.join(libraryDir, "movie", "A (2000)", "A (2000).mkv");
    const taken = path.join(libraryDir, "movie", "B (2001)", "B (2001).mkv");
    const vanished = path.join(libraryDir, "movie", "C (2002)", "C (2002).mkv");
    leftBehind(free, "a");
    leftBehind(taken, "b");
    fs.writeFileSync(taken, "script b");
    const gone = leftBehind(vanished, "c");
    fs.rmSync(gone.file);

    const tally = await setAside.sweepSetAside();

    expect(tally).toEqual({ restored: 1, recycled: 1, kept: 0, gone: 1 });
    expect(fs.readFileSync(free, "utf-8")).toBe("a");
    expect(fs.existsSync(vanished)).toBe(false);
    expect(fs.existsSync(gone.dir)).toBe(false);
    expect(fs.existsSync(setAside.setAsideJournalPath())).toBe(false);
  });

  it("does nothing with no journal, and never throws on a journal it cannot read", async () => {
    await expect(setAside.sweepSetAside()).resolves.toEqual({ restored: 0, recycled: 0, kept: 0, gone: 0 });
    fs.writeFileSync(setAside.setAsideJournalPath(), "{ this is not json");
    await expect(setAside.sweepSetAside()).resolves.toEqual({ restored: 0, recycled: 0, kept: 0, gone: 0 });
    fs.writeFileSync(setAside.setAsideJournalPath(), JSON.stringify([{ original: 7 }, "x", null]));
    await expect(setAside.sweepSetAside()).resolves.toEqual({ restored: 0, recycled: 0, kept: 0, gone: 0 });
  });

  it("keeps an entry it could not settle for the next start, and goes on with the others", async () => {
    const original = path.join(libraryDir, "movie", "A (2000)", "A (2000).mkv");
    const stuck = leftBehind(original, "a");
    fs.writeFileSync(original, "script a"); // so it has to be recycled
    // The recycle bin's folder cannot be made: its parent is a file.
    fs.writeFileSync(path.join(libraryDir, "not-a-folder"), "x");
    setSetting("recycleBinDir", path.join(libraryDir, "not-a-folder", "bin"));
    const other = path.join(libraryDir, "movie", "B (2001)", "B (2001).mkv");
    leftBehind(other, "b");

    const tally = await setAside.sweepSetAside();

    expect(tally).toEqual({ restored: 1, recycled: 0, kept: 1, gone: 0 });
    expect(fs.readFileSync(stuck.file, "utf-8")).toBe("a");
    expect(fs.readFileSync(other, "utf-8")).toBe("b");
    const left = JSON.parse(fs.readFileSync(setAside.setAsideJournalPath(), "utf-8")) as { original: string }[];
    expect(left.map((e) => e.original)).toEqual([original]);
  });
});

describe("a show's episodes through the script", () => {
  async function insertShow(folderId: number) {
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status, series_type, external_ids) VALUES ('series','Show','show',2020,?,1,0,'missing','standard','{"tvdb":"777"}')`)
          .run(folderId)
      ).lastInsertRowid
    );
    const episode = async (n: number, title: string) =>
      Number(
        (await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?,1,?,?,?,1,0)`).run(showId, n, title, `2020-01-0${n}`))
          .lastInsertRowid
      );
    return { showId, ep1: await episode(1, "Pilot"), ep2: await episode(2, "Second") };
  }

  it("tells the script about the episode, and records the file it placed", async () => {
    const folder = await insertRootFolder("series");
    const { showId, ep2 } = await insertShow(folder.id);
    const envFile = path.join(scriptDir, "env.txt");
    useScript(writeScript("move.sh", [`env > "${envFile}"`, 'mv "$1" "$2"']));
    const src = writeDownloadFile("Show.S01E02.1080p.WEB-DL.x264-GRP.mkv");

    const placed = await importer.placeFile({ itemId: showId, episodeId: ep2, subItemId: null, sourceFile: src, quality: "WEBDL-1080p", releaseTitle: "Show.S01E02.1080p.WEB-DL.x264-GRP" });

    const row = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(ep2)) as { has_file: number; file_path: string };
    expect(row).toMatchObject({ has_file: 1, file_path: placed.destPath });
    expect(fs.readFileSync(placed.destPath, "utf-8")).toBe("new");
    expect(fs.existsSync(src)).toBe(false);
    expect(envFrom(envFile)).toMatchObject({
      AONARR_SEASON_NUMBER: "1",
      AONARR_EPISODE_NUMBERS: "2",
      AONARR_EPISODE_TITLES: "Second",
      AONARR_EPISODE_AIR_DATES: "2020-01-02",
      AONARR_TVDB_ID: "777",
      AONARR_ITEM_FOLDER: path.join(folder.path, "Show"),
      Sonarr_Series_Title: "Show",
      Sonarr_Series_TvdbId: "777",
      Sonarr_EpisodeFile_SeasonNumber: "1",
      Sonarr_EpisodeFile_EpisodeNumbers: "2",
      Sonarr_EpisodeFile_ReleaseGroup: "GRP",
    });
  });

  it("runs the script for each file of a season pack, and fails the pack without placing a file when it fails", async () => {
    const folder = await insertRootFolder("series");
    const { showId, ep1, ep2 } = await insertShow(folder.id);
    const log = path.join(scriptDir, "calls.txt");
    useScript(writeScript("move.sh", [`echo "$Sonarr_EpisodeFile_EpisodeNumbers" >> "${log}"`, 'mv "$1" "$2"']));
    const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"), "one");
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E02.mkv"), "two");

    const result = await importer.placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: "WEBDL-1080p", releaseTitle: "Show.S01.1080p.WEB-DL.x264-GRP" });

    expect(result.episodeCount).toBe(2);
    expect(fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).sort()).toEqual(["1", "2"]);
    for (const [id, content] of [[ep1, "one"], [ep2, "two"]] as const) {
      const row = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(id)) as { has_file: number; file_path: string };
      expect(row.has_file).toBe(1);
      expect(fs.readFileSync(row.file_path, "utf-8")).toBe(content);
    }
    expect(fs.readdirSync(path.join(downloadsDir, "Show.S01.PACK"))).toEqual([]);
  });

  it("fails a season pack whose script fails, with every file still in the download", async () => {
    const folder = await insertRootFolder("series");
    const { showId, ep1 } = await insertShow(folder.id);
    useScript(writeScript("fail.sh", ["exit 2"]));
    const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"), "one");
    writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E02.mkv"), "two");

    const err = await importer.placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: null }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(script.ImportScriptError);
    expect(fs.readdirSync(path.join(downloadsDir, "Show.S01.PACK")).sort()).toEqual(["Show.S01E01.mkv", "Show.S01E02.mkv"]);
    expect(((await db.prepare("SELECT has_file FROM episodes WHERE id = ?").get(ep1)) as { has_file: number }).has_file).toBe(0);
  });
});

describe("a season pack whose later file fails", () => {
  it("still closes off the files placed before it: the show has a file, the file they replaced is recycled, the arrival is announced", async () => {
    const folder = await insertRootFolder("series");
    const showId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, year, root_folder_id, monitored, has_file, status, series_type, external_ids) VALUES ('series','Show','show',2020,?,1,0,'missing','standard','{"tvdb":"777"}')`)
          .run(folder.id)
      ).lastInsertRowid
    );
    const episode = async (n: number, title: string) =>
      Number((await db.prepare(`INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored, has_file) VALUES (?,1,?,?,?,1,0)`).run(showId, n, title, `2020-01-0${n}`)).lastInsertRowid);
    const ep1 = await episode(1, "Pilot");
    const ep2 = await episode(2, "Second");
    // Episode 1 has a lower-quality file under another name: the pack replaces it, so the old file has to be recycled.
    const oldFile = path.join(folder.path, "Show", "Season 01", "old name.mkv");
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, "old one");
    await db.prepare("UPDATE episodes SET has_file = 1, file_path = ?, quality = 'HDTV-720p' WHERE id = ?").run(oldFile, ep1);
    useScript(writeScript("second-fails.sh", ['if [ "$Sonarr_EpisodeFile_EpisodeNumbers" = "2" ]; then exit 5; fi', 'mv "$1" "$2"']));
    const anchor = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E01.mkv"), "one");
    const second = writeDownloadFile(path.join("Show.S01.PACK", "Show.S01E02.mkv"), "two");

    const err = await importer
      .placeSeasonPackFiles({ itemId: showId, seasonNumber: 1, anchorFile: anchor, quality: "WEBDL-1080p", releaseTitle: "Show.S01.1080p.WEB-DL.x264-GRP" })
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(script.ImportScriptError); // the failure is still what the caller gets
    const first = (await db.prepare("SELECT has_file, file_path FROM episodes WHERE id = ?").get(ep1)) as { has_file: number; file_path: string };
    expect(first.has_file).toBe(1);
    expect(fs.readFileSync(first.file_path, "utf-8")).toBe("one");
    expect(((await db.prepare("SELECT has_file FROM episodes WHERE id = ?").get(ep2)) as { has_file: number }).has_file).toBe(0);
    expect(fs.readFileSync(second, "utf-8")).toBe("two"); // still in the download
    // The wrap-up of the file that was placed:
    expect(((await db.prepare("SELECT has_file FROM media_items WHERE id = ?").get(showId)) as { has_file: number }).has_file).toBe(1);
    const recycled = (await db.prepare("SELECT original_path, recycle_path FROM recycle_bin").all()) as { original_path: string; recycle_path: string }[];
    expect(recycled.map((r) => r.original_path)).toEqual([oldFile]);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.readFileSync(recycled[0].recycle_path, "utf-8")).toBe("old one");
    expect(notifications.notifyImported).toHaveBeenCalledTimes(0); // it was an upgrade, not a new episode
    expect(notifications.notifyUpgraded).toHaveBeenCalledTimes(1);
  });
});

describe("books are not given to the script", () => {
  it("places a book itself, as Readarr (like Lidarr) has no import script", async () => {
    const marker = path.join(scriptDir, "ran.txt");
    useScript(writeScript("never.sh", [`echo ran > "${marker}"`, "exit 9"]));
    const folder = await insertRootFolder("author");
    const bookId = Number(
      (await db.prepare(`INSERT INTO media_items (type, title, sort_title, root_folder_id, monitored, has_file, status) VALUES ('author','Author','author',?,1,0,'missing')`).run(folder.id)).lastInsertRowid
    );
    const childId = Number((await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'A Book', 1, 0)`).run(bookId)).lastInsertRowid);
    const src = writeDownloadFile("A Book.epub");

    await importer.placeFile({ itemId: bookId, episodeId: null, subItemId: childId, sourceFile: src, quality: null });

    expect(fs.existsSync(marker)).toBe(false);
    expect(((await db.prepare("SELECT has_file FROM sub_items WHERE id = ?").get(childId)) as { has_file: number }).has_file).toBe(1);
  });
});
