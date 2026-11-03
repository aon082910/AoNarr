import fs from "node:fs";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let runHousekeeping: (typeof import("../src/services/housekeeping.js"))["runHousekeeping"];
let retentionDays: (typeof import("../src/services/housekeeping.js"))["retentionDays"];
let setSetting: (key: string, value: string) => void;
let config: (typeof import("../src/config.js"))["config"];
let ENCRYPTION_KEY_PATH: string;
let mediaItemId: number;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ runHousekeeping, retentionDays } = await import("../src/services/housekeeping.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  ({ config } = await import("../src/config.js"));
  ({ ENCRYPTION_KEY_PATH } = await import("../src/services/encryption.js"));
  mediaItemId = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'M', 'm', 1, 0, 'missing')").run()).lastInsertRowid
  );
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function count(table: string): Promise<number> {
  return Number(((await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()) as { c: number }).c);
}

beforeEach(async () => {
  for (const table of ["history", "watch_events", "audit_log", "job_runs", "sessions"]) await db.prepare(`DELETE FROM ${table}`).run();
  for (const key of ["housekeepingHistoryDays", "housekeepingWatchEventDays", "housekeepingAuditDays", "housekeepingVacuum"]) setSetting(key, "");
  setSetting("lastVacuumAt", new Date().toISOString()); // not what these tests are about
  setSetting("lastWalCheckpointAt", new Date().toISOString());
});

describe("retentionDays (RB9)", () => {
  it("defaults to a year, keeps 0 as 'forever', and never goes below 30 days", () => {
    expect(retentionDays("housekeepingHistoryDays")).toBe(365);
    setSetting("housekeepingHistoryDays", "0");
    expect(retentionDays("housekeepingHistoryDays")).toBe(0);
    setSetting("housekeepingHistoryDays", "5");
    expect(retentionDays("housekeepingHistoryDays")).toBe(30);
    setSetting("housekeepingHistoryDays", "90");
    expect(retentionDays("housekeepingHistoryDays")).toBe(90);
    setSetting("housekeepingHistoryDays", "banana");
    expect(retentionDays("housekeepingHistoryDays")).toBe(365);
  });
});

describe("runHousekeeping (RB9)", () => {
  it("deletes history, watch events, audit entries and job runs past their retention and keeps the rest", async () => {
    for (const age of [10, 400, 800]) {
      await db.prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', NULL, ?)").run(mediaItemId, daysAgo(age));
      await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, daysAgo(age));
      await db.prepare("INSERT INTO audit_log (username, event_type, created_at) VALUES ('a', 'x', ?)").run(daysAgo(age));
    }
    // Inserted oldest first, as the registry writes them (the newest run of a job is its highest id).
    await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES ('j', ?, 'success')").run(daysAgo(45));
    await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES ('j', ?, 'success')").run(daysAgo(5));

    const result = await runHousekeeping();

    expect(result.trimmed).toMatchObject({ history: 2, watch_events: 2, audit_log: 2, job_runs: 1 });
    expect(await count("history")).toBe(1);
    expect(await count("watch_events")).toBe(1);
    expect(await count("audit_log")).toBe(1);
    expect(await count("job_runs")).toBe(1);
  });

  it("matches a retention setting, and 0 keeps a table whole", async () => {
    await db.prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', NULL, ?)").run(mediaItemId, daysAgo(100));
    await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, daysAgo(100));
    setSetting("housekeepingHistoryDays", "60");
    setSetting("housekeepingWatchEventDays", "0");

    await runHousekeeping();

    expect(await count("history")).toBe(0);
    expect(await count("watch_events")).toBe(1);
  });

  it("compares correctly against both timestamp shapes the tables hold (ISO and SQLite's datetime format)", async () => {
    const sqliteShape = (d: string) => d.slice(0, 19).replace("T", " ");
    await db.prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', NULL, ?)").run(mediaItemId, sqliteShape(daysAgo(500)));
    await db.prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'grabbed', NULL, ?)").run(mediaItemId, sqliteShape(daysAgo(1)));

    await runHousekeeping();

    expect(await count("history")).toBe(1);
  });

  it("deletes an old table in chunks, not one huge statement, and gives up promptly when aborted", async () => {
    await db.transaction(async () => {
      const insert = db.prepare("INSERT INTO audit_log (username, event_type, created_at) VALUES ('a', 'x', ?)");
      for (let i = 0; i < 12_000; i++) await insert.run(daysAgo(900));
    });
    const controller = new AbortController();
    controller.abort();
    await runHousekeeping(controller.signal);
    expect(await count("audit_log")).toBe(12_000); // aborted before it started

    const result = await runHousekeeping();
    expect(result.trimmed.audit_log).toBe(12_000);
    expect(await count("audit_log")).toBe(0);
  });

  it("removes expired sessions and keeps live ones", async () => {
    const existing = (await db.prepare("SELECT id FROM users WHERE username = 'housekeeping-test'").get()) as { id: number } | undefined;
    const userId =
      existing?.id ??
      Number((await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('housekeeping-test', 'x', 'user')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('old', ?, ?)").run(userId, daysAgo(1));
    await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('live', ?, ?)").run(userId, new Date(Date.now() + 86_400_000).toISOString());

    const result = await runHousekeeping();

    expect(result.trimmed.sessions).toBe(1);
    expect(await db.prepare("SELECT token FROM sessions WHERE token = 'live'").get()).toBeTruthy();
  });

  it("deletes the files a restore leaves behind once they are a week old, and not before", async () => {
    const dbCopy = `${config.dbPath}.pre-restore`;
    const keyCopy = `${ENCRYPTION_KEY_PATH}.pre-restore`;
    fs.mkdirSync(config.configDir, { recursive: true });
    fs.writeFileSync(dbCopy, "x");
    fs.writeFileSync(keyCopy, "x");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dbCopy, old, old);

    const result = await runHousekeeping();

    expect(result.leftoversRemoved).toEqual([dbCopy]);
    expect(fs.existsSync(dbCopy)).toBe(false);
    expect(fs.existsSync(keyCopy)).toBe(true);
    fs.rmSync(keyCopy, { force: true });
  });

  it.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")("vacuums when it would give back a worthwhile share, and not again for a month", async () => {
    setSetting("lastVacuumAt", "");
    setSetting("lastWalCheckpointAt", "");
    // Fill the file and empty it again, so a large part of it is free pages.
    await db.transaction(async () => {
      const insert = db.prepare("INSERT INTO audit_log (username, event_type, detail, created_at) VALUES ('a', 'x', ?, ?)");
      for (let i = 0; i < 4000; i++) await insert.run("d".repeat(900), new Date().toISOString());
    });
    await db.prepare("DELETE FROM audit_log").run();

    const first = await runHousekeeping();
    expect(first.vacuumed).toBe(true);
    expect(first.checkpointed).toBe(true);
    expect(first.skippedVacuum).toBeNull();

    // It has just done it, so it does not do it again for a month, nor checkpoint again for a week.
    const second = await runHousekeeping();
    expect(second.vacuumed).toBe(false);
    expect(second.skippedVacuum).toBeNull();
    expect(second.checkpointed).toBe(false);
  });

  it.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")("does not vacuum a file that has little free space, and does not look again for a month", async () => {
    setSetting("lastVacuumAt", "");
    // A vacuum in the test before this one left no free pages.
    const result = await runHousekeeping();
    expect(result.vacuumed).toBe(false);
    expect(result.skippedVacuum).toBe("little to give back");
    expect((await runHousekeeping()).skippedVacuum).toBeNull();
  });

  it("can be switched off for VACUUM", async () => {
    if (process.env.AONARR_DATABASE_DRIVER === "postgres") return;
    setSetting("lastVacuumAt", "");
    setSetting("housekeepingVacuum", "0");
    expect((await runHousekeeping()).skippedVacuum).toBe("turned off");
  });
});

describe("runHousekeeping keeps what other screens still read (review F1, F13)", () => {
  it("never deletes the latest watch event of a title, however old, because that row is what 'watched' means", async () => {
    // A title marked watched two years ago and never since: its one row must survive.
    await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, daysAgo(800));

    await runHousekeeping();

    expect(await count("watch_events")).toBe(1);
  });

  it("deletes older rows of a title only when a newer one exists, per title, episode and part", async () => {
    const otherItem = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'N', 'n', 1, 0, 'missing')").run()).lastInsertRowid
    );
    const episodeId = Number(
      (await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored) VALUES (?, 1, 1, 1)").run(mediaItemId)).lastInsertRowid
    );
    // mediaItemId as a whole: two old rows and a recent one -> both old ones go.
    await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, daysAgo(900));
    await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, daysAgo(700));
    await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(mediaItemId, daysAgo(3));
    // one episode, only old rows: the newer of the two stays.
    await db.prepare("INSERT INTO watch_events (media_item_id, episode_id, watched_at) VALUES (?, ?, ?)").run(mediaItemId, episodeId, daysAgo(900));
    await db.prepare("INSERT INTO watch_events (media_item_id, episode_id, watched_at) VALUES (?, ?, ?)").run(mediaItemId, episodeId, daysAgo(500));
    // another title, one old row: stays.
    await db.prepare("INSERT INTO watch_events (media_item_id, watched_at) VALUES (?, ?)").run(otherItem, daysAgo(600));

    const result = await runHousekeeping();

    expect(result.trimmed.watch_events).toBe(3);
    const rows = (await db.prepare("SELECT media_item_id, episode_id, watched_at FROM watch_events ORDER BY id").all()) as any[];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.media_item_id === otherItem)).toHaveLength(1);
    expect(rows.filter((r) => r.episode_id === episodeId)).toHaveLength(1);
    expect(Date.parse(rows.find((r) => r.episode_id === episodeId).watched_at)).toBeGreaterThan(Date.now() - 600 * 86_400_000);
  });

  it("keeps the newest run of every job even when it is older than 30 days", async () => {
    await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES ('monthly', ?, 'success')").run(daysAgo(90));
    await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES ('monthly', ?, 'success')").run(daysAgo(60));
    await db.prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES ('weekly', ?, 'success')").run(daysAgo(2));

    await runHousekeeping();

    const rows = (await db.prepare("SELECT job_key, started_at FROM job_runs ORDER BY started_at").all()) as any[];
    expect(rows.map((r) => r.job_key)).toEqual(["monthly", "weekly"]);
    expect(Date.parse(rows[0].started_at)).toBeLessThan(Date.now() - 50 * 86_400_000); // the 60 day old one, not the 90
  });
});
