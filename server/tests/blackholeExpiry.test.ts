import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";
import { nowOffsetHoursExpr } from "../src/db/asyncDb.js";

// A Blackhole release is expired after blackholeTimeoutHours when its output never shows up, but not while that output
// is still being written. Everything here is real (the scheduler, the adapter, files in the downloads folder); only the
// failure notification is stubbed so no provider is called.
const notifyFailed = vi.fn();
vi.mock("../src/services/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notifications.js")>()),
  notifyFailed: (...args: unknown[]) => notifyFailed(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let config: (typeof import("../src/config.js"))["config"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let cleanupStalledDownloads: (typeof import("../src/services/scheduler.js"))["cleanupStalledDownloads"];
let blackholeOutputBusy: (typeof import("../src/services/downloadClient.js"))["blackholeOutputBusy"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ config } = await import("../src/config.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ cleanupStalledDownloads } = await import("../src/services/scheduler.js"));
  ({ blackholeOutputBusy } = await import("../src/services/downloadClient.js"));
});

let clientId: number;
const made: string[] = [];

beforeEach(async () => {
  for (const t of ["history", "queue", "media_items", "download_clients"]) await db.prepare(`DELETE FROM ${t}`).run();
  clientId = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Watch folder', 'blackhole', 1)").run()).lastInsertRowid);
  setSetting("blackholeTimeoutHours", "");
  setSetting("stalledDownloadHours", "");
  setSetting("removeFailedDownloads", "0");
  notifyFailed.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  setSetting("blackholeTimeoutHours", "");
});

/** What an external client left in the downloads folder: a folder of files, every one last changed `ageMs` ago. */
function output(name: string, ageMs: number, files: Record<string, string> = { "movie.mkv": "x" }): string {
  const dir = path.join(config.downloadsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  made.push(dir);
  const when = new Date(Date.now() - ageMs);
  for (const [file, content] of Object.entries(files)) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, when, when);
  }
  fs.utimesSync(dir, when, when);
  return dir;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A Blackhole queue row grabbed `hoursAgo` hours ago, whose id is `<uuid>|<name>` as the adapter makes it. */
async function insertRow(name: string, hoursAgo: number, downloadId: string | null = `0f0f0f0f-0000-4000-8000-000000000000|${name}`): Promise<number> {
  const mediaItemId = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', ?, ?, 1, 0, 'missing')").run(`Movie of ${name}`, name.toLowerCase())).lastInsertRowid
  );
  const result = await db
    .prepare(`INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, added_at) VALUES (?, ?, ?, ?, 'downloading', 0, ${nowOffsetHoursExpr(db, -hoursAgo)})`)
    .run(mediaItemId, name, clientId, downloadId);
  return Number(result.lastInsertRowid);
}

const statusOf = async (id: number) => ((await db.prepare("SELECT status FROM queue WHERE id = ?").get(id)) as { status: string }).status;
const failedHistory = async () => (await db.prepare("SELECT data FROM history WHERE event_type = 'failed'").all()) as { data: string }[];

describe("blackholeOutputBusy", () => {
  it("is false when nothing of that name is in the downloads folder", () => {
    expect(blackholeOutputBusy("uuid|Nothing Like This 2020")).toBe(false);
  });

  it("is false for an id from before the name was kept in it", () => {
    output("Legacy Id Release 2020", 10 * MINUTE);
    expect(blackholeOutputBusy("0f0f0f0f-0000-4000-8000-000000000000")).toBe(false);
    expect(blackholeOutputBusy("")).toBe(false);
  });

  it("is true while something in the output changed within the last hour, and false once it is older", () => {
    output("Busy Fresh Release 2020", 10 * MINUTE);
    output("Busy Settled Release 2020", 2 * HOUR);

    expect(blackholeOutputBusy("uuid|Busy Fresh Release 2020")).toBe(true);
    expect(blackholeOutputBusy("uuid|Busy Settled Release 2020")).toBe(false);
  });

  it("takes the newest change anywhere in the output, not the folder's own", () => {
    const dir = output("Busy Nested Release 2020", 5 * HOUR, { "movie.mkv": "x" });
    const sub = path.join(dir, "Subs");
    fs.mkdirSync(sub);
    const fresh = path.join(sub, "movie.en.srt");
    fs.writeFileSync(fresh, "x"); // just written
    const old = new Date(Date.now() - 5 * HOUR);
    fs.utimesSync(sub, old, old);
    fs.utimesSync(dir, old, old);

    expect(blackholeOutputBusy("uuid|Busy Nested Release 2020")).toBe(true);
  });

  // Busy means something in the output changed lately: a partial file alone does not make it so (Round 30b, M1).
  it.each(["movie.mkv.part", "movie.mkv.!qb", "movie.mkv.!ut", "movie.mkv.crdownload"])("is false for an old partial file (%s): the client that wrote it gave up", (partial) => {
    const name = `Busy Old Partial ${partial.split(".").pop()} 2020`;
    output(name, 3 * 24 * HOUR, { [partial]: "x" });

    expect(blackholeOutputBusy(`uuid|${name}`)).toBe(false);
  });

  it.each(["movie.mkv.part", "movie.mkv.!qb", "movie.mkv.!ut", "movie.mkv.crdownload"])("is true for a partial file (%s) that was touched within the hour: it is still growing", (partial) => {
    const name = `Busy Growing Partial ${partial.split(".").pop()} 2020`;
    output(name, 5 * MINUTE, { [partial]: "x" });

    expect(blackholeOutputBusy(`uuid|${name}`)).toBe(true);
  });

  it("is true for a growing partial file beside old complete ones, and false when the partial is the old one", () => {
    const dir = output("Busy Mixed Release 2020", 3 * 24 * HOUR, { "movie.mkv": "x", "movie.nfo": "x" });
    const growing = path.join(dir, "extras.mkv.part");
    fs.writeFileSync(growing, "x"); // just written
    const old = new Date(Date.now() - 3 * 24 * HOUR);
    fs.utimesSync(dir, old, old);
    expect(blackholeOutputBusy("uuid|Busy Mixed Release 2020")).toBe(true);

    fs.utimesSync(growing, old, old);
    expect(blackholeOutputBusy("uuid|Busy Mixed Release 2020")).toBe(false);
  });

  it("is false for an old, complete output with ordinary files only", () => {
    output("Complete Release 2020", 3 * 24 * HOUR, { "movie.mkv": "x", "movie.nfo": "x" });

    expect(blackholeOutputBusy("uuid|Complete Release 2020")).toBe(false);
  });

  it("uses the window it is given", () => {
    output("Window Release 2020", 30 * MINUTE);

    expect(blackholeOutputBusy("uuid|Window Release 2020", 10 * MINUTE)).toBe(false);
    expect(blackholeOutputBusy("uuid|Window Release 2020", 45 * MINUTE)).toBe(true);
    expect(blackholeOutputBusy("uuid|Window Release 2020")).toBe(true); // the default is an hour
  });

  it("finds a single file named after the release, and does not take the watch-folder drop for the output", () => {
    const file = path.join(config.downloadsDir, "Single File Release 2020.mkv");
    fs.writeFileSync(file, "x");
    made.push(file);
    const drop = path.join(config.downloadsDir, "Only A Drop 2020.nzb");
    fs.writeFileSync(drop, "<nzb/>");
    made.push(drop);

    expect(blackholeOutputBusy("uuid|Single File Release 2020")).toBe(true);
    expect(blackholeOutputBusy("uuid|Only A Drop 2020")).toBe(false);
  });
});

describe("a Blackhole release past blackholeTimeoutHours (cleanupStalledDownloads)", () => {
  it("is expired as before when its output never appeared, after the default week, and a younger row is left", async () => {
    const old = await insertRow("Never Appeared 2020", 24 * 8);
    const young = await insertRow("Young Release 2020", 24);

    await cleanupStalledDownloads();

    expect(await statusOf(old)).toBe("failed");
    expect(await statusOf(young)).toBe("downloading");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
    const history = await failedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].data).toMatch(/within 168h/);
  });

  it("goes by the configured number of hours", async () => {
    setSetting("blackholeTimeoutHours", "48");
    const threeDays = await insertRow("Three Days Old 2020", 72);
    const oneDay = await insertRow("One Day Old 2020", 24);

    await cleanupStalledDownloads();

    expect(await statusOf(threeDays)).toBe("failed");
    expect(await statusOf(oneDay)).toBe("downloading");
    expect((await failedHistory())[0].data).toMatch(/within 48h/);
  });

  it("is not expired while a partial file in its output is still growing (touched within the hour)", async () => {
    output("Still Partial 2020", 5 * MINUTE, { "movie.mkv.part": "x" });
    output("Still Qbit Partial 2020", 10 * MINUTE, { "movie.mkv.!qb": "x" });
    const part = await insertRow("Still Partial 2020", 24 * 30);
    const qb = await insertRow("Still Qbit Partial 2020", 24 * 30);

    await cleanupStalledDownloads();

    expect(await statusOf(part)).toBe("downloading");
    expect(await statusOf(qb)).toBe("downloading");
    expect(notifyFailed).not.toHaveBeenCalled();
    expect(await failedHistory()).toEqual([]);
  });

  it("is expired when the only thing in its output is an old partial file: the client gave up on it", async () => {
    output("Abandoned Partial 2020", 30 * 24 * HOUR, { "movie.mkv.part": "x" });
    output("Abandoned Qbit Partial 2020", 30 * 24 * HOUR, { "movie.mkv.!qb": "x" });
    const part = await insertRow("Abandoned Partial 2020", 24 * 30);
    const qb = await insertRow("Abandoned Qbit Partial 2020", 24 * 30);

    await cleanupStalledDownloads();

    expect(await statusOf(part)).toBe("failed");
    expect(await statusOf(qb)).toBe("failed");
    expect(notifyFailed).toHaveBeenCalledTimes(2);
    expect(await failedHistory()).toHaveLength(2);
  });

  it("is not expired while its output changed within the last hour, however old the grab is", async () => {
    output("Still Growing 2020", 5 * MINUTE);
    const id = await insertRow("Still Growing 2020", 24 * 20);

    await cleanupStalledDownloads();

    expect(await statusOf(id)).toBe("downloading");
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("is expired once the output has been quiet for more than an hour and holds no partial file", async () => {
    output("Quiet And Complete 2020", 3 * HOUR);
    const id = await insertRow("Quiet And Complete 2020", 24 * 20);

    await cleanupStalledDownloads();

    expect(await statusOf(id)).toBe("failed");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("expires the release whose output is gone and keeps the busy one in the same run", async () => {
    output("Busy One 2020", HOUR / 6);
    const busy = await insertRow("Busy One 2020", 24 * 10);
    const gone = await insertRow("Gone One 2020", 24 * 10);

    await cleanupStalledDownloads();

    expect(await statusOf(busy)).toBe("downloading");
    expect(await statusOf(gone)).toBe("failed");
  });

  it("is expired by age when its id has no name in it to look up", async () => {
    const legacy = await insertRow("Legacy 2020", 24 * 10, "0f0f0f0f-0000-4000-8000-000000000000");

    await cleanupStalledDownloads();

    expect(await statusOf(legacy)).toBe("failed");
  });
});
