import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLIENT_LIMITS,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  limitsFor,
  normalizeClientLimits,
  normalizeSettings,
  parseSettings,
} from "../src/services/throttlearr/settings.js";

const srcDbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db");

describe("Throttlearr settings", () => {
  it("is off by default, so a grab goes to the client at once", () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(parseSettings(null).enabled).toBe(false);
    expect(parseSettings(null)).toEqual({ ...DEFAULT_SETTINGS, version: SETTINGS_VERSION });
  });

  it("falls back to the defaults for garbage, never throwing", () => {
    for (const stored of ["", "not json", "null", "[]", "42", '"x"', "{"]) {
      expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("keeps valid values and replaces wrong types one field at a time", () => {
    const s = normalizeSettings({ enabled: true, dryRun: "yes", maxHeldAgeHours: 12, bypassManual: false, holdAll: 1 });
    expect(s.enabled).toBe(true);
    expect(s.dryRun).toBe(false);
    expect(s.holdAll).toBe(false);
    expect(s.maxHeldAgeHours).toBe(12);
    expect(s.bypassManual).toBe(false);
  });

  it("clamps the held-age limit to 1 hour..30 days and truncates fractions", () => {
    expect(normalizeSettings({ maxHeldAgeHours: 0 }).maxHeldAgeHours).toBe(1);
    expect(normalizeSettings({ maxHeldAgeHours: -5 }).maxHeldAgeHours).toBe(1);
    expect(normalizeSettings({ maxHeldAgeHours: 1e9 }).maxHeldAgeHours).toBe(720);
    expect(normalizeSettings({ maxHeldAgeHours: 36.9 }).maxHeldAgeHours).toBe(36);
    expect(normalizeSettings({ maxHeldAgeHours: Number.NaN }).maxHeldAgeHours).toBe(72);
    expect(normalizeSettings({ maxHeldAgeHours: "9" }).maxHeldAgeHours).toBe(72);
  });

  it("reads a limit under 1, or not a number, as no limit", () => {
    const c = normalizeClientLimits({ maxActive: 0, maxActiveBytes: -1, addsPerHour: "60", minFreeBytes: null });
    expect(c).toEqual(DEFAULT_CLIENT_LIMITS);
    expect(normalizeClientLimits({ maxActive: 3.7, addsPerHour: 60, maxActiveBytes: 5e11, minFreeBytes: 1e10 })).toMatchObject({
      maxActive: 3,
      addsPerHour: 60,
      maxActiveBytes: 5e11,
      minFreeBytes: 1e10,
    });
  });

  it("keeps only clients keyed by a numeric id", () => {
    const s = normalizeSettings({ clients: { "4": { maxActive: 3 }, abc: { maxActive: 9 }, "-1": { maxActive: 2 }, "7": "bad" } });
    expect(Object.keys(s.clients).sort()).toEqual(["4", "7"]);
    expect(limitsFor(s, 4).maxActive).toBe(3);
    expect(limitsFor(s, 7)).toEqual(DEFAULT_CLIENT_LIMITS);
    expect(limitsFor(s, 99)).toEqual(DEFAULT_CLIENT_LIMITS);
  });

  it("validates windows: HH:MM times, days 0-6, no valid day means every day", () => {
    const c = normalizeClientLimits({
      windows: [
        { days: [1, 1, 3, 9, -1, "x"], from: "21:00", to: "07:00" },
        { days: [], from: "00:00", to: "06:30" },
        { from: "25:00", to: "07:00" },
        { from: "9:00", to: "10:00" },
        { days: [2], from: "08:00" },
        "bad",
      ],
    });
    expect(c.windows).toEqual([
      { days: [1, 3], from: "21:00", to: "07:00" },
      { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "06:30" },
    ]);
  });

  it("is stable: normalizing normalized settings changes nothing", () => {
    const once = normalizeSettings({
      enabled: true,
      clients: { "2": { maxActive: 3, windows: [{ days: [6, 0], from: "22:00", to: "06:00" }] } },
      priority: { movies: 5000, recentTv: -5000, backlogOnlyAtNight: true },
    });
    expect(once.priority).toMatchObject({ movies: 1000, recentTv: -1000, backlogOnlyAtNight: true });
    expect(normalizeSettings(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe("queue gate columns in the base schemas", () => {
  it("are in schema.sql and schema.postgres.sql", () => {
    for (const file of ["schema.sql", "schema.postgres.sql"]) {
      const sql = fs.readFileSync(path.join(srcDbDir, file), "utf-8");
      for (const col of ["gate_state TEXT", "gate_held_at TEXT", "gate_reason TEXT", "gate_payload TEXT", "gate_priority INTEGER NOT NULL DEFAULT 0"]) {
        expect(sql, `${file} lacks ${col}`).toContain(col);
      }
    }
  });
});
