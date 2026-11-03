import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let log: (typeof import("../src/services/logger.js"))["log"];
let getRecentLogs: (typeof import("../src/services/logger.js"))["getRecentLogs"];
let listLogFiles: (typeof import("../src/services/logger.js"))["listLogFiles"];
let resolveLogFilePath: (typeof import("../src/services/logger.js"))["resolveLogFilePath"];
let closeLogStream: (typeof import("../src/services/logger.js"))["closeLogStream"];
let MAX_LOG_FILE_BYTES: (typeof import("../src/services/logger.js"))["MAX_LOG_FILE_BYTES"];

beforeAll(async () => {
  await setupTestDb();
  ({ log, getRecentLogs, listLogFiles, resolveLogFilePath, closeLogStream, MAX_LOG_FILE_BYTES } = await import("../src/services/logger.js"));
});

afterEach(async () => {
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("logLevel", "info");
});

function uniqueTag(): string {
  return `marker-${Math.random().toString(36).slice(2)}`;
}

describe("log / getRecentLogs", () => {
  it("records an info-level entry retrievable by its own unique message", () => {
    const tag = uniqueTag();
    log.info(`hello ${tag}`);

    const entry = getRecentLogs().find((e) => e.message.includes(tag));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("info");
  });

  it("tags warn and error entries with their own level", () => {
    const warnTag = uniqueTag();
    const errorTag = uniqueTag();
    log.warn(`careful ${warnTag}`);
    log.error(`broken ${errorTag}`);

    expect(getRecentLogs().find((e) => e.message.includes(warnTag))!.level).toBe("warn");
    expect(getRecentLogs().find((e) => e.message.includes(errorTag))!.level).toBe("error");
  });

  it("serializes an Error argument's stack/message instead of [object Object]", () => {
    const tag = uniqueTag();
    log.error(`failed for ${tag}:`, new Error(`boom-${tag}`));

    const entry = getRecentLogs().find((e) => e.message.includes(tag) && e.message.includes("boom"));
    expect(entry).toBeDefined();
    expect(entry!.message).not.toContain("[object Object]");
  });

  it("filters by level, excluding entries at other levels", () => {
    const tag = uniqueTag();
    log.info(`info variant ${tag}`);
    log.error(`error variant ${tag}`);

    const errorsOnly = getRecentLogs({ level: "error" }).filter((e) => e.message.includes(tag));
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0].message).toContain("error variant");
  });

  it("filters by a case-insensitive search substring", () => {
    const tag = uniqueTag();
    log.info(`SearchableCONTENT-${tag}`);

    expect(getRecentLogs({ search: `searchablecontent-${tag}` })).toHaveLength(1);
    expect(getRecentLogs({ search: `nothing-matches-${tag}` })).toHaveLength(0);
  });

  it("filters out everything older than a future 'since' timestamp", () => {
    const tag = uniqueTag();
    log.info(`will be excluded ${tag}`);

    const future = new Date(Date.now() + 60_000).toISOString();
    const matches = getRecentLogs({ since: future }).filter((e) => e.message.includes(tag));
    expect(matches).toHaveLength(0);
  });

  it("keeps everything at or after a past 'since' timestamp", () => {
    const tag = uniqueTag();
    const past = new Date(Date.now() - 60_000).toISOString();
    log.info(`will be included ${tag}`);

    const matches = getRecentLogs({ since: past }).filter((e) => e.message.includes(tag));
    expect(matches).toHaveLength(1);
  });

  it("returns matching entries newest-first", () => {
    const tag = uniqueTag();
    log.info(`first-${tag}`);
    log.info(`second-${tag}`);

    const matches = getRecentLogs().filter((e) => e.message.includes(tag));
    expect(matches.map((e) => e.message)).toEqual([`second-${tag}`, `first-${tag}`]);
  });

  it("stops persisting info-level entries once logLevel is raised to error", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("logLevel", "error");
    const infoTag = uniqueTag();
    const errorTag = uniqueTag();

    log.info(`should be dropped ${infoTag}`);
    log.error(`should still persist ${errorTag}`);

    expect(getRecentLogs().find((e) => e.message.includes(infoTag))).toBeUndefined();
    expect(getRecentLogs().find((e) => e.message.includes(errorTag))).toBeDefined();
  });
});

describe("listLogFiles / resolveLogFilePath", () => {
  it("lists today's log file with a non-zero size, since startup has already logged something", async () => {
    log.info("ensure at least one line is flushed before listing");
    // fs.createWriteStream opens its fd asynchronously — give it a tick to actually create the
    // file on disk before listing the directory, rather than relying on incidental startup timing.
    await new Promise((r) => setTimeout(r, 50));
    const files = listLogFiles();
    const today = new Date().toISOString().slice(0, 10);

    const todayFile = files.find((f) => f.name === `aonarr-${today}.log`);
    expect(todayFile).toBeDefined();
    expect(todayFile!.sizeBytes).toBeGreaterThan(0);
  });

  it("resolves a validly-formatted log filename to a path", () => {
    const today = new Date().toISOString().slice(0, 10);
    const resolved = resolveLogFilePath(`aonarr-${today}.log`);
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(`aonarr-${today}.log`);
  });

  it("rejects a path-traversal attempt instead of resolving it", () => {
    expect(resolveLogFilePath("../../../../etc/passwd")).toBeNull();
    expect(resolveLogFilePath("aonarr-2024-01-01.log/../../../etc/passwd")).toBeNull();
    expect(resolveLogFilePath("not-a-log-file.txt")).toBeNull();
  });
});

describe("log robustness and levels (audit RB14)", () => {
  it("does not throw, and still records the line, when an argument is a circular object", () => {
    const tag = uniqueTag();
    const circular: Record<string, unknown> = { name: tag };
    circular.self = circular;

    expect(() => log.warn(`circular ${tag}`, circular)).not.toThrow();

    const entry = getRecentLogs().find((e) => e.message.includes(`circular ${tag}`));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(tag);
  });

  it("formats undefined and functions instead of printing 'undefined' by accident or throwing", () => {
    const tag = uniqueTag();
    expect(() => log.info(`odd ${tag}`, undefined, () => 1)).not.toThrow();
    expect(getRecentLogs().find((e) => e.message.includes(`odd ${tag}`))).toBeDefined();
  });

  it("keeps debug entries out unless the log level is debug", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    const quietTag = uniqueTag();
    const loudTag = uniqueTag();

    log.debug(`debug while info ${quietTag}`);
    setSetting("logLevel", "debug");
    log.debug(`debug while debug ${loudTag}`);

    expect(getRecentLogs().find((e) => e.message.includes(quietTag))).toBeUndefined();
    const entry = getRecentLogs().find((e) => e.message.includes(loudTag));
    expect(entry?.level).toBe("debug");
  });

  it("still persists info entries when the level is debug, and drops debug at warn", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("logLevel", "debug");
    const infoTag = uniqueTag();
    log.info(`info at debug ${infoTag}`);
    expect(getRecentLogs().find((e) => e.message.includes(infoTag))).toBeDefined();

    setSetting("logLevel", "warn");
    const debugTag = uniqueTag();
    log.debug(`debug at warn ${debugTag}`);
    expect(getRecentLogs().find((e) => e.message.includes(debugTag))).toBeUndefined();
  });

  it("writes the last lines to the file before closeLogStream resolves", async () => {
    const fs = await import("node:fs");
    const tag = uniqueTag();
    log.info(`last words ${tag}`);

    await closeLogStream();

    const today = new Date().toISOString().slice(0, 10);
    const file = resolveLogFilePath(`aonarr-${today}.log`)!;
    expect(fs.readFileSync(file, "utf-8")).toContain(`last words ${tag}`);
    // and logging after a close opens the file again
    const after = uniqueTag();
    log.info(`after close ${after}`);
    await closeLogStream();
    expect(fs.readFileSync(file, "utf-8")).toContain(`after close ${after}`);
  });

  it("starts a numbered file when a day's file reaches the size limit", async () => {
    const tag = uniqueTag();
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {}); // the big line must not flood the test output
    log.info(`before the big line ${tag}`);
    // One line big enough to fill the current file by itself.
    log.info("x".repeat(MAX_LOG_FILE_BYTES + 10));
    log.info(`after the big line ${tag}`);
    quiet.mockRestore();
    await closeLogStream();

    const today = new Date().toISOString().slice(0, 10);
    const names = listLogFiles().map((f) => f.name);
    expect(names).toContain(`aonarr-${today}.log`);
    expect(names.some((n) => new RegExp(`^aonarr-${today}\\.\\d+\\.log$`).test(n))).toBe(true);
    // newest first: a numbered file sorts before the day's base file
    const numbered = names.findIndex((n) => /\.\d+\.log$/.test(n));
    expect(numbered).toBeLessThan(names.indexOf(`aonarr-${today}.log`));
    expect(resolveLogFilePath(`aonarr-${today}.1.log`)).not.toBeNull();
  }, 60_000);
});
