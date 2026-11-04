import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_FAILED_RESTORE_STARTS,
  checkRestoreAtStart,
  confirmRestoreStarted,
  failedRestoreSuffix,
  markRestorePending,
  readRolledBackNotice,
  uncountRestoreStart,
  type RestoreFiles,
} from "../src/restoreGuard.js";

let dir: string;
let files: RestoreFiles;
let pendingFile: string;
let noticeFile: string;
const log = vi.fn();

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-restoreguard-"));
  files = { dbPath: path.join(dir, "aonarr.db"), keyPath: path.join(dir, "encryption.key") };
  pendingFile = path.join(dir, "restore-pending.json");
  noticeFile = path.join(dir, "restore-rolled-back.json");
  log.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (file: string) => fs.readFileSync(file, "utf-8");
const readPendingMarker = () => JSON.parse(read(pendingFile)) as { at: string; starts: number };

/** The state a restore leaves: the uploaded file in place, the previous one beside it, the marker written. */
function afterRestore(options: { previousKey?: boolean; currentKey?: boolean; previousDb?: boolean } = {}): void {
  fs.writeFileSync(files.dbPath, "restored database (broken)");
  if (options.previousDb !== false) fs.writeFileSync(`${files.dbPath}.pre-restore`, "previous database (good)");
  if (options.currentKey !== false) fs.writeFileSync(files.keyPath, "restored key");
  if (options.previousKey !== false) fs.writeFileSync(`${files.keyPath}.pre-restore`, "previous key");
  markRestorePending(files);
}

/** Runs the starts that fail, and returns the verdicts of each. */
function failedStarts(count: number) {
  return Array.from({ length: count }, () => checkRestoreAtStart(files, log));
}

describe("markRestorePending / checkRestoreAtStart", () => {
  it("says 'none' and touches nothing when no restore is on probation", () => {
    fs.writeFileSync(files.dbPath, "the database");

    expect(checkRestoreAtStart(files, log)).toBe("none");

    expect(read(files.dbPath)).toBe("the database");
    expect(fs.readdirSync(dir)).toEqual(["aonarr.db"]);
    expect(log).not.toHaveBeenCalled();
  });

  it("writes a marker with no starts counted yet", () => {
    markRestorePending(files);

    const marker = readPendingMarker();
    expect(marker.starts).toBe(0);
    expect(Number.isFinite(Date.parse(marker.at))).toBe(true);
  });

  it("puts the first two starts on probation and counts each in the marker", () => {
    afterRestore();

    expect(checkRestoreAtStart(files, log)).toBe("on-probation");
    expect(readPendingMarker().starts).toBe(1);
    expect(checkRestoreAtStart(files, log)).toBe("on-probation");
    expect(readPendingMarker().starts).toBe(2);

    expect(MAX_FAILED_RESTORE_STARTS).toBe(2);
    expect(read(files.dbPath)).toBe("restored database (broken)"); // still the restored file
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps the original time of the restore in the marker while counting starts", () => {
    afterRestore();
    const before = readPendingMarker();

    checkRestoreAtStart(files, log);

    expect(readPendingMarker().at).toBe(before.at);
  });

  describe("the third start after a restore that never came up", () => {
    it("puts the previous database back and keeps the failed one aside", () => {
      afterRestore();
      fs.writeFileSync(`${files.dbPath}-wal`, "wal of the restored file");
      fs.writeFileSync(`${files.dbPath}-shm`, "shm of the restored file");

      const verdicts = failedStarts(3);

      expect(verdicts).toEqual(["on-probation", "on-probation", "rolled-back"]);
      expect(read(files.dbPath)).toBe("previous database (good)");
      expect(read(`${files.dbPath}${failedRestoreSuffix()}`)).toBe("restored database (broken)");
      expect(failedRestoreSuffix()).toBe(".failed-restore");
      expect(fs.existsSync(`${files.dbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${files.dbPath}-shm`)).toBe(false);
    });

    it("puts the previous encryption key back too and keeps the restored one aside", () => {
      afterRestore();

      failedStarts(3);

      expect(read(files.keyPath)).toBe("previous key");
      expect(read(`${files.keyPath}.failed-restore`)).toBe("restored key");
    });

    it("writes a notice, removes the marker, and tells the log what happened", () => {
      afterRestore();

      failedStarts(3);

      expect(fs.existsSync(pendingFile)).toBe(false);
      const notice = JSON.parse(read(noticeFile));
      expect(notice).toMatchObject({ failedDatabase: `${files.dbPath}.failed-restore`, startsTried: 2 });
      expect(Number.isFinite(Date.parse(notice.at))).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(`${files.dbPath}.failed-restore`);
    });

    it("leaves no temporary copy behind: the previous database is staged under .rollback-tmp and renamed into place", () => {
      afterRestore();

      expect(failedStarts(3)[2]).toBe("rolled-back");

      expect(fs.existsSync(`${files.dbPath}.rollback-tmp`)).toBe(false);
      expect(fs.readdirSync(dir).filter((name) => name.includes("rollback-tmp"))).toEqual([]);
      expect(read(files.dbPath)).toBe("previous database (good)");
      expect(read(`${files.dbPath}.pre-restore`)).toBe("previous database (good)"); // the original copy stays too
    });

    it("never leaves the database path empty when the final rename fails after the restored file was moved aside", () => {
      afterRestore();
      failedStarts(2);
      const realRename = fs.renameSync;
      let failed = false;
      const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        if (!failed && String(from).endsWith(".rollback-tmp")) {
          failed = true;
          throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);
      try {
        expect(checkRestoreAtStart(files, log)).toBe("none");

        expect(failed).toBe(true);
        expect(read(files.dbPath)).toBe("previous database (good)"); // put back by the recovery, not missing
        expect(read(`${files.dbPath}.failed-restore`)).toBe("restored database (broken)");
        expect(fs.existsSync(`${files.dbPath}.rollback-tmp`)).toBe(false);
        expect(log.mock.calls[0][0]).toMatch(/Could not check the restore marker.*EIO/);
        expect(readPendingMarker().starts).toBe(MAX_FAILED_RESTORE_STARTS);
      } finally {
        rename.mockRestore();
      }
    });

    it("leaves later starts alone: the marker is gone", () => {
      afterRestore();
      failedStarts(3);

      expect(failedStarts(3)).toEqual(["none", "none", "none"]);
      expect(read(files.dbPath)).toBe("previous database (good)");
    });

    it("replaces a failed-restore file left by an earlier rollback", () => {
      fs.writeFileSync(`${files.dbPath}.failed-restore`, "older failed file");
      afterRestore();

      failedStarts(3);

      expect(read(`${files.dbPath}.failed-restore`)).toBe("restored database (broken)");
    });

    it("leaves the current key alone when the restore left no previous key", () => {
      afterRestore({ previousKey: false });

      expect(failedStarts(3)[2]).toBe("rolled-back");

      expect(read(files.keyPath)).toBe("restored key");
      expect(fs.existsSync(`${files.keyPath}.failed-restore`)).toBe(false);
    });

    it("puts the previous key back even when the current key file is gone", () => {
      afterRestore({ currentKey: false });

      expect(failedStarts(3)[2]).toBe("rolled-back");

      expect(read(files.keyPath)).toBe("previous key");
      expect(fs.existsSync(`${files.keyPath}.failed-restore`)).toBe(false);
    });
  });

  describe("when there is no way back", () => {
    it("says 'no-way-back' at the third start, removes the marker and names the missing file in the log", () => {
      afterRestore({ previousDb: false });

      const verdicts = failedStarts(3);

      expect(verdicts).toEqual(["on-probation", "on-probation", "no-way-back"]);
      expect(fs.existsSync(pendingFile)).toBe(false);
      expect(read(files.dbPath)).toBe("restored database (broken)"); // untouched
      expect(fs.existsSync(`${files.dbPath}.failed-restore`)).toBe(false);
      expect(fs.existsSync(noticeFile)).toBe(false); // nothing was rolled back, so there is no notice
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(`${files.dbPath}.pre-restore`);
    });

    it("leaves later starts alone", () => {
      afterRestore({ previousDb: false });
      failedStarts(3);

      expect(failedStarts(2)).toEqual(["none", "none"]);
    });
  });

  describe("an unreadable marker", () => {
    it("is read as no marker, and the start goes ahead", () => {
      fs.writeFileSync(files.dbPath, "the database");
      fs.writeFileSync(pendingFile, "{ this is not json");

      expect(checkRestoreAtStart(files, log)).toBe("none");

      expect(read(files.dbPath)).toBe("the database");
    });

    it("counts a marker with no usable count as zero starts", () => {
      fs.writeFileSync(pendingFile, JSON.stringify({ at: "2026-11-01T00:00:00.000Z", starts: "many" }));

      expect(checkRestoreAtStart(files, log)).toBe("on-probation");

      expect(readPendingMarker()).toEqual({ at: "2026-11-01T00:00:00.000Z", starts: 1 });
    });
  });

  it("never throws: when putting the previous database back fails it logs, reports none and keeps the marker for the next start", () => {
    afterRestore();
    failedStarts(2);
    const realCopy = fs.copyFileSync;
    const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike, ...rest: unknown[]) => {
      if (String(to).endsWith(".rollback-tmp")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return (realCopy as (...args: unknown[]) => void)(from, to, ...rest);
    }) as typeof fs.copyFileSync);
    try {
      let verdict: string | undefined;
      expect(() => {
        verdict = checkRestoreAtStart(files, log);
      }).not.toThrow();

      expect(verdict).toBe("none");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(/Could not check the restore marker.*ENOSPC/);
      expect(readPendingMarker().starts).toBe(MAX_FAILED_RESTORE_STARTS);
      expect(fs.existsSync(noticeFile)).toBe(false);
      // The restored file stays where it was: a failed copy of the previous database loses nothing.
      expect(fs.existsSync(files.dbPath)).toBe(true);
      expect(fs.existsSync(`${files.dbPath}.rollback-tmp`)).toBe(false);
      expect(fs.existsSync(`${files.dbPath}.failed-restore`)).toBe(false);
    } finally {
      copy.mockRestore();
    }
  });
});

describe("confirmRestoreStarted", () => {
  it("ends the probation: later starts do nothing and count nothing", () => {
    afterRestore();
    expect(checkRestoreAtStart(files, log)).toBe("on-probation");

    confirmRestoreStarted(files);

    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(failedStarts(5)).toEqual(["none", "none", "none", "none", "none"]);
    expect(read(files.dbPath)).toBe("restored database (broken)"); // never swapped back
    expect(fs.existsSync(`${files.dbPath}.failed-restore`)).toBe(false);
  });

  it("does nothing, and does not throw, when there is no marker", () => {
    expect(() => confirmRestoreStarted(files)).not.toThrow();
  });

  it("does not remove a rollback notice", () => {
    afterRestore();
    failedStarts(3);

    confirmRestoreStarted(files);

    expect(readRolledBackNotice(files)).not.toBeNull();
  });
});

describe("readRolledBackNotice", () => {
  it("returns null when no rollback happened", () => {
    expect(readRolledBackNotice(files)).toBeNull();
  });

  it("returns what the rollback recorded", () => {
    afterRestore();
    failedStarts(3);

    expect(readRolledBackNotice(files)).toMatchObject({ failedDatabase: `${files.dbPath}.failed-restore`, startsTried: 2 });
  });

  it("returns null once the notice is seven days old, and still returns it just before", () => {
    const notice = (ageMs: number) =>
      fs.writeFileSync(noticeFile, JSON.stringify({ at: new Date(Date.now() - ageMs).toISOString(), failedDatabase: "x.failed-restore", startsTried: 2 }));

    notice(7 * DAY_MS - 60_000);
    expect(readRolledBackNotice(files)).toMatchObject({ failedDatabase: "x.failed-restore" });

    notice(7 * DAY_MS + 60_000);
    expect(readRolledBackNotice(files)).toBeNull();
  });

  it("goes by the clock: a notice from a rollback eight days ago has expired", () => {
    afterRestore();
    failedStarts(3);
    expect(readRolledBackNotice(files)).not.toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * DAY_MS);

    expect(readRolledBackNotice(files)).toBeNull();
  });

  it("takes a different number of days when asked", () => {
    fs.writeFileSync(noticeFile, JSON.stringify({ at: new Date(Date.now() - 2 * DAY_MS).toISOString(), failedDatabase: "x", startsTried: 2 }));

    expect(readRolledBackNotice(files, 1)).toBeNull();
    expect(readRolledBackNotice(files, 3)).not.toBeNull();
  });

  it("returns null for a notice that cannot be read or has no valid time", () => {
    fs.writeFileSync(noticeFile, "not json");
    expect(readRolledBackNotice(files)).toBeNull();

    fs.writeFileSync(noticeFile, JSON.stringify({ at: "never", failedDatabase: "x", startsTried: 2 }));
    expect(readRolledBackNotice(files)).toBeNull();
  });

  it("is cleared by the next restore", () => {
    afterRestore();
    failedStarts(3);
    expect(readRolledBackNotice(files)).not.toBeNull();

    markRestorePending(files);

    expect(readRolledBackNotice(files)).toBeNull();
    expect(fs.existsSync(noticeFile)).toBe(false);
  });
});

describe("uncountRestoreStart", () => {
  it("takes one start back out of the count, one call at a time", () => {
    afterRestore();
    checkRestoreAtStart(files, log);
    checkRestoreAtStart(files, log);
    expect(readPendingMarker().starts).toBe(2);

    uncountRestoreStart(files);
    expect(readPendingMarker().starts).toBe(1);
    uncountRestoreStart(files);
    expect(readPendingMarker().starts).toBe(0);
  });

  it("keeps the time of the restore in the marker", () => {
    afterRestore();
    checkRestoreAtStart(files, log);
    const before = readPendingMarker();

    uncountRestoreStart(files);

    expect(readPendingMarker()).toEqual({ at: before.at, starts: 0 });
  });

  it("does not count a start that was stopped on purpose against the restored database, however often that happens", () => {
    afterRestore();

    for (let i = 0; i < 6; i++) {
      expect(checkRestoreAtStart(files, log)).toBe("on-probation");
      uncountRestoreStart(files); // stopped by SIGTERM before it reached listening
    }

    expect(read(files.dbPath)).toBe("restored database (broken)"); // never swapped back
    expect(fs.existsSync(`${files.dbPath}.failed-restore`)).toBe(false);
    expect(readPendingMarker().starts).toBe(0);
  });

  it("gives a restore one more try for each start that was stopped on purpose, and still rolls back after the failed ones", () => {
    afterRestore();

    const verdicts: string[] = [];
    verdicts.push(checkRestoreAtStart(files, log)); // fails
    verdicts.push(checkRestoreAtStart(files, log)); // stopped on purpose
    uncountRestoreStart(files);
    verdicts.push(checkRestoreAtStart(files, log)); // fails
    verdicts.push(checkRestoreAtStart(files, log)); // the third start that really failed

    expect(verdicts).toEqual(["on-probation", "on-probation", "on-probation", "rolled-back"]);
    expect(read(files.dbPath)).toBe("previous database (good)");
  });

  it("does nothing, and creates no marker, when there is none", () => {
    expect(() => uncountRestoreStart(files)).not.toThrow();

    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does nothing when no start has been counted yet, and never goes below zero", () => {
    markRestorePending(files);
    const untouched = read(pendingFile);

    uncountRestoreStart(files);
    uncountRestoreStart(files);

    expect(read(pendingFile)).toBe(untouched);
    expect(readPendingMarker().starts).toBe(0);
  });

  it("does nothing after the restore was confirmed", () => {
    afterRestore();
    checkRestoreAtStart(files, log);
    confirmRestoreStarted(files);

    uncountRestoreStart(files);

    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  it("leaves a marker it cannot read as it was, without throwing", () => {
    fs.writeFileSync(pendingFile, "{ not json");

    expect(() => uncountRestoreStart(files)).not.toThrow();

    expect(read(pendingFile)).toBe("{ not json");
  });

  it("never throws, even when the marker cannot be written", () => {
    afterRestore();
    checkRestoreAtStart(files, log);
    const realWrite = fs.writeFileSync;
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target) === pendingFile) throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      return (realWrite as (...args: unknown[]) => void)(target, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => uncountRestoreStart(files)).not.toThrow();
    } finally {
      write.mockRestore();
    }

    expect(readPendingMarker().starts).toBe(1); // unchanged
  });
});
