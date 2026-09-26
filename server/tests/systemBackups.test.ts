import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import AdmZip from "adm-zip";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const restorePostgres = vi.fn();
/** Every key decision the restore route kicked off, so a test can wait for it to settle. */
const keyDecisions: Promise<boolean>[] = [];
vi.mock("../src/services/scheduledBackup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/scheduledBackup.js")>();
  return {
    ...actual,
    restorePostgres: (...args: unknown[]) => restorePostgres(...args),
    restoredDbNeedsBundleKey: (...args: Parameters<typeof actual.restoredDbNeedsBundleKey>) => {
      const decision = actual.restoredDbNeedsBundleKey(...args);
      keyDecisions.push(decision);
      return decision;
    },
  };
});

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;
let backupDir: string;
let keyPath: string;
let encryptValue: (plaintext: string) => string;
let reloadEncryptionKey: () => void;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-test-backups-"));
  const encryption = await import("../src/services/encryption.js");
  ({ encryptValue, reloadEncryptionKey } = encryption);
  keyPath = encryption.ENCRYPTION_KEY_PATH;
  encryptValue("make sure a key file exists"); // generated lazily on first use
});

afterEach(() => {
  setSetting("backupDir", "");
  for (const f of fs.readdirSync(backupDir)) fs.unlinkSync(path.join(backupDir, f));
});

describe("GET /api/system/backups", () => {
  it("returns an empty list when no backup directory is configured", async () => {
    const res = await request(app).get("/api/system/backups").set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ backups: [] });
  });

  it("returns an empty list when the configured directory doesn't exist yet", async () => {
    setSetting("backupDir", path.join(backupDir, "does-not-exist"));
    const res = await request(app).get("/api/system/backups").set("X-Api-Key", apiKey);
    expect(res.body).toEqual({ backups: [] });
  });

  it("lists every backup-shaped file in the directory, newest first, ignoring unrelated files", async () => {
    setSetting("backupDir", backupDir);
    fs.writeFileSync(path.join(backupDir, "aonarr-backup-2020-01-01.aonarrbackup"), "a");
    fs.writeFileSync(path.join(backupDir, "aonarr-backup-2021-01-01.db"), "bb");
    fs.writeFileSync(path.join(backupDir, "not-a-backup.txt"), "ignored");

    const res = await request(app).get("/api/system/backups").set("X-Api-Key", apiKey);

    expect(res.body.backups.map((b: any) => b.fileName).sort()).toEqual(["aonarr-backup-2020-01-01.aonarrbackup", "aonarr-backup-2021-01-01.db"].sort());
    const bundle = res.body.backups.find((b: any) => b.fileName.endsWith(".aonarrbackup"));
    expect(bundle.sizeBytes).toBe(1);
    expect(typeof bundle.createdAt).toBe("string");
  });
});

describe("GET /api/system/backups/:fileName", () => {
  it("downloads an existing backup file", async () => {
    setSetting("backupDir", backupDir);
    fs.writeFileSync(path.join(backupDir, "aonarr-backup-x.db"), "hello");

    const res = await request(app).get("/api/system/backups/aonarr-backup-x.db").set("X-Api-Key", apiKey).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("aonarr-backup-x.db");
    expect((res.body as Buffer).toString()).toBe("hello");
  });

  it("404s for a file that doesn't exist", async () => {
    setSetting("backupDir", backupDir);
    const res = await request(app).get("/api/system/backups/aonarr-backup-missing.db").set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal attempt rather than reading outside the backup directory", async () => {
    setSetting("backupDir", backupDir);
    const res = await request(app).get("/api/system/backups/..%2F..%2Fetc%2Fpasswd.db").set("X-Api-Key", apiKey);
    expect(res.status).toBe(400);
  });

  it("rejects a file name with an extension this app never writes", async () => {
    setSetting("backupDir", backupDir);
    fs.writeFileSync(path.join(backupDir, "not-a-backup.txt"), "x");
    const res = await request(app).get("/api/system/backups/not-a-backup.txt").set("X-Api-Key", apiKey);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/system/backups/:fileName", () => {
  it("deletes an existing backup file", async () => {
    setSetting("backupDir", backupDir);
    const filePath = path.join(backupDir, "aonarr-backup-delete-me.db");
    fs.writeFileSync(filePath, "x");

    const res = await request(app).delete("/api/system/backups/aonarr-backup-delete-me.db").set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("404s for a file that doesn't exist", async () => {
    setSetting("backupDir", backupDir);
    const res = await request(app).delete("/api/system/backups/aonarr-backup-missing.db").set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal attempt rather than deleting outside the backup directory", async () => {
    setSetting("backupDir", backupDir);
    const res = await request(app).delete("/api/system/backups/..%2F..%2Fetc%2Fpasswd.db").set("X-Api-Key", apiKey);
    expect(res.status).toBe(400);
  });
});

/** A backup bundle as writeBackupBundle lays it out, carrying a key that isn't this instance's. */
function bundleWith(dbBuffer: Buffer, keyHex: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(process.env.AONARR_DATABASE_DRIVER === "postgres" ? "db.dump" : "db.db", dbBuffer);
  zip.addFile("encryption.key", Buffer.from(keyHex));
  return zip.toBuffer();
}

describe("POST /api/system/backup/restore — encryption key", () => {
  const otherKey = "ab".repeat(32);

  it.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "keeps the key being replaced as encryption.key.pre-restore, next to the pre-restore DB copy",
    async () => {
      const originalKey = fs.readFileSync(keyPath, "utf-8");
      const { config } = await import("../src/config.js");
      // The route swaps the DB file and exits on a 250ms timer — fake it so it never fires here.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        const sqliteHeader = Buffer.concat([Buffer.from("SQLite format 3\0", "utf-8"), Buffer.alloc(84)]);
        const res = await request(app)
          .post("/api/system/backup/restore")
          .set("X-Api-Key", apiKey)
          .set("Content-Type", "application/octet-stream")
          .send(bundleWith(sqliteHeader, otherKey));

        expect(res.status).toBe(200);
        expect(fs.existsSync(`${config.dbPath}.pre-restore`)).toBe(true);
        expect(fs.readFileSync(`${keyPath}.pre-restore`, "utf-8")).toBe(originalKey);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        exit.mockRestore();
        fs.rmSync(`${keyPath}.pre-restore`, { force: true });
        fs.rmSync(`${config.dbPath}.pre-restore`, { force: true });
      }
    }
  );

  /** Posts `upload` as a Postgres restore and waits for the route to finish with it, which ends in a
   * process exit (stubbed here) once any bundled key has been dealt with. */
  async function restorePostgresUpload(upload: Buffer): Promise<{ message: string }> {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const res = await request(app)
        .post("/api/system/backup/restore")
        .set("X-Api-Key", apiKey)
        .set("Content-Type", "application/octet-stream")
        .send(upload);
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 3000 });
      return res.body;
    } finally {
      exit.mockRestore();
    }
  }

  /** Posts a Postgres bundle carrying otherKey and waits until the route has decided on the key. */
  async function restorePostgresBundle(): Promise<void> {
    keyDecisions.length = 0;
    await restorePostgresUpload(bundleWith(Buffer.from("PGDMP-not-really-a-dump"), otherKey));
    expect(keyDecisions).toHaveLength(1);
    await keyDecisions[0];
  }

  // pg_restore --clean swaps every table under the running process, so its settings/quality caches
  // and schema migrations would otherwise stay pre-restore until some unrelated restart.
  it.runIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "restarts the process after a Postgres restore, whether pg_restore succeeded or reported errors",
    async () => {
      restorePostgres.mockReset().mockResolvedValue(undefined);
      const succeeded = await restorePostgresUpload(Buffer.from("PGDMP-legacy-single-file-dump"));
      expect(succeeded.message).toMatch(/restart/);

      restorePostgres.mockReset().mockRejectedValue(new Error("pg_restore: error: could not execute query: ERROR:  relation already exists"));
      await restorePostgresUpload(Buffer.from("PGDMP-legacy-single-file-dump"));
    }
  );

  it.runIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "leaves the current key in place when pg_restore fails before touching the database",
    async () => {
      const originalKey = fs.readFileSync(keyPath, "utf-8");
      restorePostgres.mockReset().mockRejectedValue(new Error("pg_restore: error: unsupported version (1.16) in file header"));

      await withOnlyEncryptedSetting(encryptValue("still the old database"), restorePostgresBundle);

      expect(fs.readFileSync(keyPath, "utf-8")).toBe(originalKey);
      expect(fs.existsSync(`${keyPath}.pre-restore`)).toBe(false);
    }
  );

  it.runIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "installs the bundle's key when pg_restore reports errors after the other install's data is already in",
    async () => {
      const originalKey = fs.readFileSync(keyPath, "utf-8");
      restorePostgres.mockReset().mockRejectedValue(new Error('pg_restore: error: could not execute query: ERROR:  role "other_install" does not exist'));
      try {
        await withOnlyEncryptedSetting(encryptWithKey(otherKey, "restored credential"), restorePostgresBundle);

        expect(fs.readFileSync(keyPath, "utf-8")).toBe(otherKey);
        expect(fs.readFileSync(`${keyPath}.pre-restore`, "utf-8")).toBe(originalKey);
      } finally {
        fs.writeFileSync(keyPath, originalKey);
        fs.rmSync(`${keyPath}.pre-restore`, { force: true });
        reloadEncryptionKey();
      }
    }
  );

  it.runIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "swaps in the bundle's key after a successful pg_restore of a database with nothing encrypted in it",
    async () => {
      const originalKey = fs.readFileSync(keyPath, "utf-8");
      restorePostgres.mockReset().mockResolvedValue(undefined);
      try {
        await withOnlyEncryptedSetting(null, restorePostgresBundle);

        expect(fs.readFileSync(keyPath, "utf-8")).toBe(otherKey);
        expect(fs.readFileSync(`${keyPath}.pre-restore`, "utf-8")).toBe(originalKey);
      } finally {
        fs.writeFileSync(keyPath, originalKey);
        fs.rmSync(`${keyPath}.pre-restore`, { force: true });
        reloadEncryptionKey();
      }
    }
  );
});

describe("POST /api/system/backup/restore — running imports", () => {
  /** Holds an import of `queueId` under the queue import lock until the returned function is called. */
  async function holdImport(queueId: number): Promise<{ finish: () => void; done: Promise<boolean> }> {
    const { withQueueImportLock } = await import("../src/services/downloadClient.js");
    let finish!: () => void;
    const done = withQueueImportLock(queueId, () => new Promise<void>((resolve) => (finish = resolve)));
    return { finish: () => finish(), done };
  }

  /** Runs a "queuePoll" job that, like pollQueue, imports `queueIds` one after another under the lock
   * with a database call and an I/O round trip (the next client's status call) after each, and
   * ignores cancellation. Each import runs until `finishNext`. */
  async function runQueuePoll(queueIds: number[]) {
    const { registerJob, runJobNow, isJobRunning, startAllJobs } = await import("../src/services/jobRegistry.js");
    const { withQueueImportLock } = await import("../src/services/downloadClient.js");
    const pending: (() => void)[] = [];
    let started = 0;
    registerJob({
      key: "queuePoll",
      name: "Queue poll",
      scheduleType: "interval",
      defaultSchedule: "20",
      run: async () => {
        for (const id of queueIds) {
          await withQueueImportLock(id, () => {
            started++;
            return new Promise<void>((resolve) => pending.push(resolve));
          });
          await db.prepare("SELECT COUNT(*) AS n FROM queue").get();
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
    });
    // An earlier restore in this file stopped every job; the restore under test stops them again.
    startAllJobs();
    expect(runJobNow("queuePoll")).toBe("started");
    return {
      started: () => started,
      finishNext: () => pending.shift()?.(),
      finishAll: () => pending.splice(0).forEach((resolve) => resolve()),
      running: () => isJobRunning("queuePoll"),
    };
  }

  it.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "waits for a running import to settle before closing and replacing the SQLite database, refreshing the rollback copy first",
    async () => {
      const { config } = await import("../src/config.js");
      const { db: sqliteDb } = await import("../src/db/client.js");
      const Database = (await import("better-sqlite3")).default;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      // Stops the restore at its destructive step, so this file's own database survives the test.
      const close = vi.spyOn(sqliteDb, "close").mockImplementation(() => {
        throw new Error("stopped before the file swap");
      });
      const importing = await holdImport(9001);
      try {
        const sqliteHeader = Buffer.concat([Buffer.from("SQLite format 3\0", "utf-8"), Buffer.alloc(84)]);
        const res = await request(app)
          .post("/api/system/backup/restore")
          .set("X-Api-Key", apiKey)
          .set("Content-Type", "application/octet-stream")
          .send(sqliteHeader);
        expect(res.status).toBe(200);

        await vi.advanceTimersByTimeAsync(1000);
        expect(close).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();

        // Committed by the import after the route's first rollback copy.
        await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("importedDuringRestoreWait", "1");
        importing.finish();
        expect(await importing.done).toBe(true);
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(close).toHaveBeenCalledTimes(1);

        const rollback = new Database(`${config.dbPath}.pre-restore`, { readonly: true });
        try {
          expect(rollback.prepare("SELECT value FROM settings WHERE key = ?").get("importedDuringRestoreWait")).toEqual({ value: "1" });
        } finally {
          rollback.close();
        }
      } finally {
        importing.finish();
        vi.clearAllTimers();
        vi.useRealTimers();
        exit.mockRestore();
        close.mockRestore();
        await db.prepare("DELETE FROM settings WHERE key = ?").run("importedDuringRestoreWait");
        fs.rmSync(`${keyPath}.pre-restore`, { force: true });
        fs.rmSync(`${config.dbPath}.pre-restore`, { force: true });
      }
    }
  );

  it.skipIf(process.env.AONARR_DATABASE_DRIVER === "postgres")(
    "waits out a queue poll between its imports before replacing the SQLite database",
    async () => {
      const { config } = await import("../src/config.js");
      const { db: sqliteDb } = await import("../src/db/client.js");
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const close = vi.spyOn(sqliteDb, "close").mockImplementation(() => {
        throw new Error("stopped before the file swap");
      });
      const poll = await runQueuePoll([9101, 9102]);
      try {
        const sqliteHeader = Buffer.concat([Buffer.from("SQLite format 3\0", "utf-8"), Buffer.alloc(84)]);
        const res = await request(app)
          .post("/api/system/backup/restore")
          .set("X-Api-Key", apiKey)
          .set("Content-Type", "application/octet-stream")
          .send(sqliteHeader);
        expect(res.status).toBe(200);
        await vi.advanceTimersByTimeAsync(1000);

        poll.finishNext();
        await vi.waitFor(() => expect(poll.started()).toBe(2));
        await vi.advanceTimersByTimeAsync(1000);
        expect(close).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();

        poll.finishNext();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(poll.running()).toBe(false);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        poll.finishAll();
        vi.clearAllTimers();
        vi.useRealTimers();
        exit.mockRestore();
        close.mockRestore();
        fs.rmSync(`${keyPath}.pre-restore`, { force: true });
        fs.rmSync(`${config.dbPath}.pre-restore`, { force: true });
      }
    }
  );

  it.runIf(process.env.AONARR_DATABASE_DRIVER === "postgres")("waits out a queue poll between its imports before running pg_restore", async () => {
    restorePostgres.mockReset().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const poll = await runQueuePoll([9201, 9202]);
    try {
      const res = await request(app)
        .post("/api/system/backup/restore")
        .set("X-Api-Key", apiKey)
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("PGDMP-legacy-single-file-dump"));
      expect(res.status).toBe(200);

      poll.finishNext();
      await vi.waitFor(() => expect(poll.started()).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(restorePostgres).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      poll.finishNext();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 3000 });
      expect(poll.running()).toBe(false);
      expect(restorePostgres).toHaveBeenCalledTimes(1);
    } finally {
      poll.finishAll();
      exit.mockRestore();
    }
  });

  it.runIf(process.env.AONARR_DATABASE_DRIVER === "postgres")("waits for a running import to settle before running pg_restore", async () => {
    restorePostgres.mockReset().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const importing = await holdImport(9002);
    try {
      const res = await request(app)
        .post("/api/system/backup/restore")
        .set("X-Api-Key", apiKey)
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("PGDMP-legacy-single-file-dump"));
      expect(res.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(restorePostgres).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      importing.finish();
      expect(await importing.done).toBe(true);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 3000 });
      expect(restorePostgres).toHaveBeenCalledTimes(1);
    } finally {
      importing.finish();
      exit.mockRestore();
    }
  });
});

/** encryptValue under a key other than the installed one, via the real encryption.ts format. */
function encryptWithKey(keyHex: string, plaintext: string): string {
  const originalKey = fs.readFileSync(keyPath, "utf-8");
  fs.writeFileSync(keyPath, keyHex);
  reloadEncryptionKey();
  try {
    return encryptValue(plaintext);
  } finally {
    fs.writeFileSync(keyPath, originalKey);
    reloadEncryptionKey();
  }
}

/** Runs `fn` with `value` as the database's only encrypted settings row (none when null). */
async function withOnlyEncryptedSetting(value: string | null, fn: () => Promise<void>): Promise<void> {
  const saved = (await db.prepare("SELECT key, value FROM settings WHERE value LIKE ?").all("enc1:%")) as { key: string; value: string }[];
  await db.prepare("DELETE FROM settings WHERE value LIKE ?").run("enc1:%");
  if (value) await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("restoredIndexerApiKey", value);
  try {
    await fn();
  } finally {
    await db.prepare("DELETE FROM settings WHERE key = ?").run("restoredIndexerApiKey");
    for (const row of saved) await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(row.key, row.value);
  }
}

describe("restoredDbNeedsBundleKey", () => {
  const otherKey = "cd".repeat(32);
  let restoredDbNeedsBundleKey: (keyBuffer: Buffer, restoreSucceeded: boolean) => Promise<boolean>;

  beforeAll(async () => {
    ({ restoredDbNeedsBundleKey } = await import("../src/services/scheduledBackup.js"));
  });

  it("picks the bundle's key when the data now in the database only decrypts with it, whether or not pg_restore reported errors", async () => {
    await withOnlyEncryptedSetting(encryptWithKey(otherKey, "restored credential"), async () => {
      expect(await restoredDbNeedsBundleKey(Buffer.from(otherKey), false)).toBe(true);
      expect(await restoredDbNeedsBundleKey(Buffer.from(`${otherKey}\n`), true)).toBe(true);
      expect(await restoredDbNeedsBundleKey(Buffer.from("not a key"), true)).toBe(false);
    });
  });

  it("keeps the current key while the database still decrypts with it, including when the bundle carries that same key", async () => {
    const currentKey = fs.readFileSync(keyPath, "utf-8").trim();
    await withOnlyEncryptedSetting(encryptValue("still the old database"), async () => {
      expect(await restoredDbNeedsBundleKey(Buffer.from(otherKey), false)).toBe(false);
      expect(await restoredDbNeedsBundleKey(Buffer.from(otherKey), true)).toBe(false);
      expect(await restoredDbNeedsBundleKey(Buffer.from(currentKey), true)).toBe(false);
    });
  });

  it("follows pg_restore's own result when nothing in the database is encrypted", async () => {
    await withOnlyEncryptedSetting(null, async () => {
      expect(await restoredDbNeedsBundleKey(Buffer.from(otherKey), true)).toBe(true);
      expect(await restoredDbNeedsBundleKey(Buffer.from(otherKey), false)).toBe(false);
    });
  });
});
