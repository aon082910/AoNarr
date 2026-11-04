import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { isKnownSettingKey, settingValueProblem, suggestSettingKey } from "../src/services/settingsRegistry.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
});

const put = (key: string, value: unknown) => request(app).put(`/api/settings/${encodeURIComponent(key)}`).set("X-Api-Key", apiKey).send({ value });

describe("PUT /api/settings/:key refuses what nothing reads (ST18)", () => {
  it("answers 400 for a key that does not exist, names the closest real key, and stores nothing", async () => {
    const res = await put("recycleBinRetentionDay", "10");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown setting "recycleBinRetentionDay"');
    expect(res.body.error).toContain('Did you mean "recycleBinRetentionDays"?');
    expect(await db.prepare("SELECT 1 FROM settings WHERE key = 'recycleBinRetentionDay'").get()).toBeFalsy();
  });

  it("gives no suggestion when nothing is close", async () => {
    const res = await put("zzzzzzzzzzzzzzzz", "x");
    expect(res.status).toBe(400);
    expect(res.body.error).not.toContain("Did you mean");
  });

  it("still saves a real key, and the keys the server builds at run time", async () => {
    expect((await put("recycleBinRetentionDays", "14")).status).toBe(200);
    for (const key of ["namingMovieTemplate", "namingEnabledSeries", "discordEvents", "notifyTemplateGrabbed", "jobSchedule_libraryScan", "strictReleaseIdentity.movie", "defaultMovieProvider"]) {
      expect((await put(key, key === "namingMovieTemplate" ? "{title} ({year})" : "x")).status, key).toBe(200);
    }
  });

  it("checks the value of a setting whose values are fixed", async () => {
    expect((await put("sizeLimitMode", "weekly")).status).toBe(400);
    expect((await put("sizeLimitMode", "perMinute")).status).toBe(200);
    expect((await put("tlsRejectUnauthorized", "maybe")).status).toBe(400);
    expect((await put("tlsRejectUnauthorized", "local")).status).toBe(200);
    expect((await put("housekeepingHistoryDays", "-5")).status).toBe(400);
    expect((await put("housekeepingHistoryDays", "180")).status).toBe(200);
    expect((await put("backupKeepCount", "0")).status).toBe(400);
    expect((await put("defaultMinimumAvailability", "tomorrow")).status).toBe(400);
  });

  it("accepts an empty value for any key: that is how the page resets a field", async () => {
    expect((await put("sizeLimitMode", "")).status).toBe(200);
    expect((await put("housekeepingHistoryDays", "")).status).toBe(200);
  });

  // The scheduler reads blackholeTimeoutHours with parseInt and falls back to a week for anything else (Round 30b, L5).
  it("takes blackholeTimeoutHours as a whole number of hours, at least one", async () => {
    for (const bad of ["abc", "1.5", "0", "-3", "1e1", "24h"]) {
      const res = await put("blackholeTimeoutHours", bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.error, bad).toContain("blackholeTimeoutHours");
      expect(res.body.error, bad).toContain("whole number of at least 1");
    }
    expect(await db.prepare("SELECT value FROM settings WHERE key = 'blackholeTimeoutHours'").get()).toBeFalsy();

    expect((await put("blackholeTimeoutHours", "24")).status).toBe(200);
    // The setting is written to the database after the request has answered (a round trip against Postgres): look for it for a moment.
    let stored: { value: string } | undefined;
    for (let i = 0; i < 80 && !stored; i++) {
      stored = (await db.prepare("SELECT value FROM settings WHERE key = 'blackholeTimeoutHours'").get()) as { value: string } | undefined;
      if (!stored) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(stored).toMatchObject({ value: "24" });
    expect((await put("blackholeTimeoutHours", "")).status).toBe(200);
  });
});

describe("the registry matches the keys the code uses (ST18)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = path.join(here, "..", "src");
  const webSrc = path.join(here, "..", "..", "web", "src");

  function sourceFiles(dir: string, exts: string[]): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(full, exts));
      else if (exts.some((e) => entry.name.endsWith(e))) found.push(full);
    }
    return found;
  }

  function keysUsedBy(files: string[], pattern: RegExp): Map<string, string> {
    const keys = new Map<string, string>();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      for (const match of text.matchAll(pattern)) if (!keys.has(match[1])) keys.set(match[1], path.relative(here, file));
    }
    return keys;
  }

  it("lists every key the server reads or writes by name", () => {
    const used = keysUsedBy(
      sourceFiles(serverSrc, [".ts"]).filter((f) => !f.endsWith("settingKeyList.ts") && !f.endsWith("settingsRegistry.ts")),
      /\b(?:getSetting|setSetting|requireSetting|deleteSetting|ruleOn|wholeSetting)\(\s*"([A-Za-z0-9_.]+)"/g
    );
    const missing = [...used].filter(([key]) => !isKnownSettingKey(key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it.skipIf(!fs.existsSync(webSrc) && process.env.AONARR_REQUIRE_REPO_FILES !== "1")("lists every key the Settings page and the System page write or read", () => {
    expect(fs.existsSync(webSrc), "AONARR_REQUIRE_REPO_FILES=1 needs the whole repository mounted").toBe(true);
    const files = sourceFiles(webSrc, [".ts", ".tsx"]);
    const written = keysUsedBy(files, /\b(?:saveSetting|saveSettingOrThrow)\(\s*"([A-Za-z0-9_.]+)"/g);
    const read = keysUsedBy(files, /\bsettings\.([A-Za-z][A-Za-z0-9_]*)\b/g);
    const missing = [...written, ...read].filter(([key]) => !isKnownSettingKey(key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });
});

describe("settingsRegistry helpers", () => {
  it("suggests the nearest key for a typo and nothing for a stranger", () => {
    expect(suggestSettingKey("tmdbApiky")).toBe("tmdbApiKey");
    expect(suggestSettingKey("completelyUnrelatedName")).toBeNull();
  });

  it("explains a value that does not fit", () => {
    expect(settingValueProblem("sizeLimitMode", "x")).toContain("absolute, perMinute");
    expect(settingValueProblem("recycleBinRetentionDays", "1.5")).toContain("whole number");
    expect(settingValueProblem("blackholeTimeoutHours", "1.5")).toBe('"blackholeTimeoutHours" must be a whole number of at least 1');
    expect(settingValueProblem("blackholeTimeoutHours", "abc")).not.toBeNull();
    expect(settingValueProblem("blackholeTimeoutHours", "24")).toBeNull();
    expect(settingValueProblem("someOtherKey", "anything")).toBeNull();
  });
});

describe("GET /api/settings keeps the server's own working state out of the answer", () => {
  const PENDING = "deletedFilePendingUnmonitor";
  const EMPTY_ALBUMS = "albumBackfillEmpty";
  const get = () => request(app).get("/api/settings").set("X-Api-Key", apiKey);

  it("leaves out the deleted-file job's pending ids and the album backfill memory, and still returns every other setting", async () => {
    const { setSetting, getSetting } = await import("../src/services/settingsStore.js");
    const pending = JSON.stringify({ mediaItems: [1, 2, 3], episodes: [4, 5], subItems: [6] });
    const albums = JSON.stringify({ "17": 1760000000000 });
    setSetting(PENDING, pending);
    setSetting(EMPTY_ALBUMS, albums);
    setSetting("recycleBinRetentionDays", "21");
    setSetting("namingMovieTemplate", "{title} ({year})");

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty(PENDING);
    expect(res.body).not.toHaveProperty(EMPTY_ALBUMS);
    expect(res.body.recycleBinRetentionDays).toBe("21");
    expect(res.body.namingMovieTemplate).toBe("{title} ({year})");
    expect(res.body.apiKey).toBe(apiKey);
    // Only the answer is trimmed: the stored state is still there for the jobs that use it.
    expect(getSetting(PENDING)).toBe(pending);
    expect(getSetting(EMPTY_ALBUMS)).toBe(albums);
    expect(Object.keys((await get()).body)).not.toContain(PENDING);
  });

  it("leaves them out when they have been cleared to an empty value too", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting(PENDING, "");
    setSetting(EMPTY_ALBUMS, "");

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty(PENDING);
    expect(res.body).not.toHaveProperty(EMPTY_ALBUMS);
  });
});
