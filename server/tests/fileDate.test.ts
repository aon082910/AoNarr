import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

let setSetting: (key: string, value: string) => void;
let fileDate: typeof import("../src/services/fileDate.js");
let log: (typeof import("../src/services/logger.js"))["log"];
let tmp: string;

beforeAll(async () => {
  await setupTestDb();
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  fileDate = await import("../src/services/fileDate.js");
  ({ log } = await import("../src/services/logger.js"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-filedate-"));
});

afterAll(() => {
  setSetting("fileDate", "");
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  setSetting("fileDate", "");
});

function newFile(name: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "x");
  return file;
}

describe("dating a file by its air date (round 30c)", () => {
  it("dates a file by a day from 1971 on, at noon", async () => {
    setSetting("fileDate", "utcAirDate");
    const file = newFile("recent.mkv");

    await fileDate.applyFileDate(file, "1971-01-01");

    expect(fs.statSync(file).mtime.toISOString()).toBe("1971-01-01T12:00:00.000Z");
  });

  it("leaves a file from before 1971 with its own date, and says so in the log", async () => {
    setSetting("fileDate", "utcAirDate");
    const file = newFile("old.mkv");
    const before = fs.statSync(file).mtimeMs;
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await fileDate.applyFileDate(file, "1950-06-15");

    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/keeps its own date: 1950-06-15 is before 1971/));
  });

  it("does the same for a placeholder date far in the future", async () => {
    setSetting("fileDate", "localAirDate");
    const file = newFile("future.mkv");
    const before = fs.statSync(file).mtimeMs;
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await fileDate.applyFileDate(file, "2999-12-31");

    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/2999-12-31 is after 2100/));
  });

  it("says nothing when the setting is off or the day is not a day", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    setSetting("fileDate", "");
    await fileDate.applyFileDate(newFile("off.mkv"), "1950-06-15");
    setSetting("fileDate", "utcAirDate");
    await fileDate.applyFileDate(newFile("blank.mkv"), null);
    await fileDate.applyFileDate(newFile("garbage.mkv"), "sometime");

    expect(info).not.toHaveBeenCalled();
  });

  it("never gives a negative time, whatever the zone", () => {
    for (const day of ["1970-01-01", "1969-12-31", "0001-01-01", "1900-02-28"]) {
      expect(fileDate.mtimeFor(day, "localAirDate")).toBeNull();
      expect(fileDate.mtimeFor(day, "utcAirDate")).toBeNull();
    }
    expect(fileDate.mtimeFor("1971-01-01", "localAirDate")!.getTime()).toBeGreaterThan(0);
  });

  it("does not fail the import when the file cannot be dated", async () => {
    setSetting("fileDate", "utcAirDate");

    await expect(fileDate.applyFileDate(path.join(tmp, "missing.mkv"), "2020-01-01")).resolves.toBeUndefined();
  });
});
