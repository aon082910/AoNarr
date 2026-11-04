import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
// The date helper is plain TypeScript with no browser API, so the server's test runner covers it (the web package has none).
import * as dateFormat from "../../web/src/utils/dateFormat.js";

let app: Express;
let apiKey: string;
let sessionToken: string;
let settings: typeof import("../src/services/settingsStore.js");
let prefsModule: typeof import("../src/services/displayPreferences.js");

beforeAll(async () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  ({ app, apiKey, db } = await setupTestDb());
  settings = await import("../src/services/settingsStore.js");
  prefsModule = await import("../src/services/displayPreferences.js");
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('display-household', ?, 'user')").run(hashPassword("x"))).lastInsertRowid
  );
  ({ token: sessionToken } = await createSession(userId));
});

const KEYS = ["uiWeekStart", "uiDateFormat", "uiTimeFormat", "uiTimeZone", "uiRelativeDates"];
beforeEach(() => {
  for (const key of KEYS) settings.deleteSetting(key);
});

const put = (key: string, value: string) => request(app).put(`/api/settings/${key}`).set("X-Api-Key", apiKey).send({ value });

describe("the display preference settings", () => {
  it("accepts the listed values and an empty one (the page's reset), and refuses anything else", async () => {
    for (const [key, good, bad] of [
      ["uiWeekStart", "monday", "friday"],
      ["uiDateFormat", "DD/MM/YYYY", "dd.mm.yyyy"],
      ["uiTimeFormat", "24h", "36h"],
      ["uiRelativeDates", "1", "yes"],
    ]) {
      expect((await put(key, good)).status, `${key}=${good}`).toBe(200);
      const refused = await put(key, bad);
      expect(refused.status, `${key}=${bad}`).toBe(400);
      expect(refused.body.error).toContain(key);
      expect((await put(key, "")).status, `${key} reset`).toBe(200);
    }
  });

  it("checks a time zone against the names this Node knows", async () => {
    expect((await put("uiTimeZone", "Europe/Berlin")).status).toBe(200);
    expect((await put("uiTimeZone", "America/New_York")).status).toBe(200);
    expect((await put("uiTimeZone", "UTC")).status).toBe(200);
    for (const bad of ["Mars/Olympus_Mons", "europe/berlin", "CET+1", "Berlin"]) {
      const refused = await put("uiTimeZone", bad);
      expect(refused.status, bad).toBe(400);
      expect(refused.body.error).toContain("IANA time zone");
    }
    expect(prefsModule.timeZoneProblem("Asia/Tokyo")).toBeNull();
    expect(prefsModule.timeZoneProblem("Asia/Atlantis")).not.toBeNull();
  });
});

describe("GET /api/display-preferences", () => {
  it("answers the browser's own way (everything unset) on a fresh install", async () => {
    const res = await request(app).get("/api/display-preferences").set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ weekStart: "", dateFormat: "", timeFormat: "", timeZone: "", relativeDates: false });
  });

  it("serves what the admin set to a household account too, but needs a login", async () => {
    await put("uiWeekStart", "saturday");
    await put("uiDateFormat", "MMM D, YYYY");
    await put("uiTimeFormat", "12h");
    await put("uiTimeZone", "Europe/Berlin");
    await put("uiRelativeDates", "1");
    const expected = { weekStart: "saturday", dateFormat: "MMM D, YYYY", timeFormat: "12h", timeZone: "Europe/Berlin", relativeDates: true };

    const asUser = await request(app).get("/api/display-preferences").set("X-Session-Token", sessionToken);
    expect(asUser.status).toBe(200);
    expect(asUser.body).toEqual(expected);

    expect((await request(app).get("/api/display-preferences")).status).toBe(401);
  });

  it("treats a stored value this version does not know as unset", () => {
    settings.setSetting("uiWeekStart", "tuesday");
    settings.setSetting("uiDateFormat", "dd.mm.yy");
    settings.setSetting("uiTimeFormat", "13h");
    settings.setSetting("uiTimeZone", "Nowhere/Land");
    settings.setSetting("uiRelativeDates", "maybe");
    expect(prefsModule.displayPreferences()).toEqual({ weekStart: "", dateFormat: "", timeFormat: "", timeZone: "", relativeDates: false });
  });
});

describe("the web date helper lists what the server accepts", () => {
  it("has the same week starts, date formats and time formats", () => {
    expect([...dateFormat.UI_WEEK_STARTS]).toEqual([...prefsModule.UI_WEEK_STARTS]);
    expect([...dateFormat.UI_DATE_FORMATS]).toEqual([...prefsModule.UI_DATE_FORMATS]);
    expect([...dateFormat.UI_TIME_FORMATS]).toEqual([...prefsModule.UI_TIME_FORMATS]);
  });
});

// ---------------------------------------------------------------------------
// web/src/utils/dateFormat.ts
// ---------------------------------------------------------------------------

const set = (next: Partial<Record<keyof typeof dateFormat.DEFAULT_DISPLAY_PREFERENCES, unknown>>) => dateFormat.setDisplayPreferences({ ...dateFormat.DEFAULT_DISPLAY_PREFERENCES, ...next });
const english = Intl.DateTimeFormat().resolvedOptions().locale.startsWith("en");
// A fixed local noon, far from any day boundary, so "today" is the same day in every time zone the tests pick.
const NOON = new Date(2026, 2, 5, 12, 0, 0);

describe("dateFormat with nothing chosen (the display before the preferences existed)", () => {
  beforeEach(() => dateFormat.setDisplayPreferences(null));

  it("writes dates and times exactly as the browser does", () => {
    const instant = new Date("2026-03-05T23:30:09Z");
    expect(dateFormat.formatDateTime("2026-03-05 23:30:09")).toBe(instant.toLocaleString());
    expect(dateFormat.formatDateTime("2026-03-05T23:30:09Z")).toBe(instant.toLocaleString());
    expect(dateFormat.formatDate("2026-03-05 23:30:09")).toBe(instant.toLocaleDateString());
    expect(dateFormat.formatTime("2026-03-05T23:30:09Z")).toBe(instant.toLocaleTimeString());
    expect(dateFormat.formatCalendarDate("2026-03-15", { year: "numeric", month: "short", day: "numeric" })).toBe(
      new Date(2026, 2, 15).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    );
    expect(dateFormat.formatCalendarDate("2026-03-15")).toBe(new Date(2026, 2, 15).toLocaleDateString());
    expect(dateFormat.formatLongDate("2026-03-15")).toBe(new Date(2026, 2, 15).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
  });

  it("shows a bare year and a year-month without inventing a day, and nothing for rubbish", () => {
    expect(dateFormat.formatCalendarDate("1999")).toBe("1999");
    expect(dateFormat.formatCalendarDate("2024-03")).toBe(new Date(2024, 2, 1).toLocaleDateString(undefined, { year: "numeric", month: "short" }));
    expect(dateFormat.formatCalendarDate("2024-02-30")).toBe("");
    expect(dateFormat.formatCalendarDate(null)).toBe("");
    expect(dateFormat.formatDateTime(null)).toBe("");
    expect(dateFormat.formatDateTime("not a date")).toBe("");
  });

  it("prints the stored text where the page always printed it, and starts the week on Sunday", () => {
    expect(dateFormat.formatIsoDate("2026-03-05")).toBe("2026-03-05");
    expect(dateFormat.formatIsoDateTime("2026-03-05 23:30:09")).toBe("2026-03-05 23:30:09");
    expect(dateFormat.formatIsoDate(null)).toBe("");
    expect(dateFormat.weekStartsOn()).toBe(0);
  });
});

describe("dateFormat with preferences", () => {
  it("writes a day in each fixed date format, for a calendar date and for a timestamp", () => {
    const expected: Record<string, string> = {
      "YYYY-MM-DD": "2026-03-05",
      "DD/MM/YYYY": "05/03/2026",
      "MM/DD/YYYY": "03/05/2026",
      "D MMM YYYY": `5 ${new Date(2026, 2, 5).toLocaleDateString(undefined, { month: "short" })} 2026`,
      "MMM D, YYYY": `${new Date(2026, 2, 5).toLocaleDateString(undefined, { month: "short" })} 5, 2026`,
    };
    for (const format of dateFormat.UI_DATE_FORMATS) {
      set({ dateFormat: format });
      expect(dateFormat.formatDate("2026-03-05"), format).toBe(expected[format]);
      expect(dateFormat.formatCalendarDate("2026-03-05", { year: "numeric", month: "short", day: "numeric" }), format).toBe(expected[format]);
      expect(dateFormat.formatIsoDate("2026-03-05"), format).toBe(expected[format]);
      expect(dateFormat.formatDate(new Date(2026, 2, 5, 9, 0, 0)), format).toBe(expected[format]);
    }
  });

  it("keeps a partial date (year, year-month) as the browser writes it whatever date format is chosen", () => {
    set({ dateFormat: "DD/MM/YYYY" });
    expect(dateFormat.formatDate("1999")).toBe("1999");
    expect(dateFormat.formatDate("2024-03")).toBe(new Date(2024, 2, 1).toLocaleDateString(undefined, { year: "numeric", month: "short" }));
  });

  it("moves a timestamp into the chosen time zone, with its date, but never moves a calendar date", () => {
    const instant = "2026-03-05T23:30:00Z";
    set({ dateFormat: "YYYY-MM-DD", timeZone: "Asia/Tokyo" });
    expect(dateFormat.formatDate(instant)).toBe("2026-03-06");
    expect(dateFormat.formatDateTime(instant)).toMatch(/^2026-03-06, 0?8:30:00/);
    set({ dateFormat: "YYYY-MM-DD", timeZone: "America/Los_Angeles" });
    expect(dateFormat.formatDate(instant)).toBe("2026-03-05");
    expect(dateFormat.formatDateTime(instant)).toMatch(/^2026-03-05, (0?3|15):30:00/);
    // A release date is that day for everyone.
    set({ dateFormat: "YYYY-MM-DD", timeZone: "Pacific/Kiritimati" });
    expect(dateFormat.formatDate("2026-03-05")).toBe("2026-03-05");
    expect(dateFormat.formatCalendarDate("2026-03-05")).toBe("2026-03-05");
    // A server timestamp is UTC text, not the viewer's local time.
    set({ timeZone: "UTC", dateFormat: "YYYY-MM-DD" });
    expect(dateFormat.formatDateTime("2026-03-05 23:30:00")).toMatch(/^2026-03-05, /);
  });

  it.skipIf(!english)("switches the clock between 12 and 24 hours", () => {
    const instant = "2026-03-05T15:05:09Z";
    set({ timeFormat: "24h", timeZone: "UTC" });
    expect(dateFormat.formatTime(instant)).toBe("15:05:09");
    expect(dateFormat.formatDateTime(instant)).toMatch(/15:05:09$/);
    set({ timeFormat: "12h", timeZone: "UTC" });
    // ICU writes a narrow no-break space before PM in newer versions, a plain one in older ones.
    expect(dateFormat.formatTime(instant)).toMatch(/^3:05:09\sPM$/);
    expect(dateFormat.formatDateTime(instant)).toMatch(/3:05:09\sPM$/);
    // Midnight is 00:..., not 24:... on the 24-hour clock.
    set({ timeFormat: "24h", timeZone: "UTC" });
    expect(dateFormat.formatTime("2026-03-05T00:05:09Z")).toMatch(/^0?0:05:09$/);
  });

  it("leaves the browser's date and time order alone when only the clock or zone is chosen", () => {
    set({ timeZone: "UTC" });
    expect(dateFormat.formatDateTime("2026-03-05T15:05:09Z")).toBe(new Date("2026-03-05T15:05:09Z").toLocaleString(undefined, { timeZone: "UTC" }));
  });

  it("reads the week start", () => {
    set({ weekStart: "monday" });
    expect(dateFormat.weekStartsOn()).toBe(1);
    set({ weekStart: "saturday" });
    expect(dateFormat.weekStartsOn()).toBe(6);
    set({ weekStart: "sunday" });
    expect(dateFormat.weekStartsOn()).toBe(0);
  });

  it("ignores a value it does not know, and a time zone the browser does not have", () => {
    dateFormat.setDisplayPreferences({ weekStart: "tuesday", dateFormat: "dd.mm", timeFormat: "13h", timeZone: "Nowhere/Land", relativeDates: "yes" });
    expect(dateFormat.getDisplayPreferences()).toEqual(dateFormat.DEFAULT_DISPLAY_PREFERENCES);
    dateFormat.setDisplayPreferences({ weekStart: "monday", relativeDates: true, timeZone: " Europe/Paris " });
    expect(dateFormat.getDisplayPreferences()).toMatchObject({ weekStart: "monday", relativeDates: true, timeZone: "Europe/Paris" });
  });
});

describe("dateFormat relative dates", () => {
  const word = (offset: number) => {
    const text = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(offset, "day");
    return text.charAt(0).toLocaleUpperCase() + text.slice(1);
  };

  it("says Today, Yesterday and Tomorrow for those days only", () => {
    set({ relativeDates: true });
    expect(dateFormat.formatDate("2026-03-05", NOON)).toBe(word(0));
    expect(dateFormat.formatDate("2026-03-04", NOON)).toBe(word(-1));
    expect(dateFormat.formatDate("2026-03-06", NOON)).toBe(word(1));
    expect(dateFormat.formatDate("2026-03-07", NOON)).toBe(new Date(2026, 2, 7).toLocaleDateString());
    expect(dateFormat.formatIsoDate("2026-03-06", NOON)).toBe(word(1));
    expect(dateFormat.formatIsoDate("2026-03-20", NOON)).toBe(new Date(2026, 2, 20).toLocaleDateString());
    expect(dateFormat.formatDateTime(new Date(2026, 2, 5, 9, 0, 0), NOON)).toBe(`${word(0)}, ${new Date(2026, 2, 5, 9, 0, 0).toLocaleTimeString()}`);
    expect(dateFormat.formatLongDate("2026-03-06", NOON)).toBe(`${word(1)}, ${new Date(2026, 2, 6).toLocaleDateString(undefined, { weekday: "long" })}`);
  });

  it("falls back to the chosen date format outside those days, and judges 'today' in the chosen time zone", () => {
    set({ relativeDates: true, dateFormat: "YYYY-MM-DD" });
    expect(dateFormat.formatDate("2026-03-10", NOON)).toBe("2026-03-10");
    // 2026-03-05 23:30 UTC is already the 6th in Tokyo: with Tokyo's "now" of the 6th at 09:00, that is Today.
    set({ relativeDates: true, timeZone: "Asia/Tokyo" });
    expect(dateFormat.formatDate("2026-03-05T23:30:00Z", new Date("2026-03-06T00:00:00Z"))).toBe(word(0));
    expect(dateFormat.formatDate("2026-03-05T23:30:00Z", new Date("2026-03-07T00:00:00Z"))).toBe(word(-1));
  });

  it("states how long ago or how far ahead a moment is", () => {
    const now = new Date("2026-03-05T12:00:00Z");
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    expect(dateFormat.formatRelative("2026-03-05T11:55:00Z", now)).toBe(rtf.format(-5, "minute"));
    expect(dateFormat.formatRelative("2026-03-05T14:00:00Z", now)).toBe(rtf.format(2, "hour"));
    expect(dateFormat.formatRelative("2026-03-02 12:00:00", now)).toBe(rtf.format(-3, "day"));
    expect(dateFormat.formatRelative("2026-03-05T12:00:20Z", now)).toBe(rtf.format(20, "second"));
    expect(dateFormat.formatRelative("2024-03-05T12:00:00Z", now)).toBe(rtf.format(-2, "year"));
    expect(dateFormat.formatRelative(null, now)).toBe("");
  });
});

describe("todayInPreferredZone (the Calendar's today, review finding L16)", () => {
  beforeEach(() => dateFormat.setDisplayPreferences(null));
  const word = (offset: number) => {
    const text = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(offset, "day");
    return text.charAt(0).toLocaleUpperCase() + text.slice(1);
  };

  it("is the browser's own day, as YYYY-MM-DD, when no time zone is chosen", () => {
    expect(dateFormat.todayInPreferredZone(NOON)).toBe("2026-03-05");
    // Local clock times either side of midnight: the local date, not the UTC one.
    expect(dateFormat.todayInPreferredZone(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
    expect(dateFormat.todayInPreferredZone(new Date(2027, 0, 1, 0, 0, 1))).toBe("2027-01-01");
    expect(dateFormat.todayInPreferredZone(new Date(2026, 0, 2, 12, 0, 0))).toBe("2026-01-02");
    expect(dateFormat.todayInPreferredZone()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is the day it is in the chosen zone, whatever day it is where the browser is", () => {
    const instant = new Date("2026-03-05T23:30:00Z");
    for (const [timeZone, day] of [
      ["UTC", "2026-03-05"],
      ["Asia/Tokyo", "2026-03-06"],
      ["America/Los_Angeles", "2026-03-05"],
      ["Pacific/Kiritimati", "2026-03-06"],
      ["Pacific/Pago_Pago", "2026-03-05"],
    ] as const) {
      set({ timeZone });
      expect(dateFormat.todayInPreferredZone(instant), timeZone).toBe(day);
    }
    set({ timeZone: "Pacific/Pago_Pago" });
    expect(dateFormat.todayInPreferredZone(new Date("2026-03-05T05:00:00Z"))).toBe("2026-03-04");
    set({ timeZone: "Asia/Tokyo" });
    expect(dateFormat.todayInPreferredZone(new Date("2025-12-31T15:00:00Z"))).toBe("2026-01-01");
  });

  it("names the day the relative dates call Today, so the Calendar's accent and its labels agree", () => {
    const instant = new Date("2026-03-05T23:30:00Z");
    set({ relativeDates: true, timeZone: "Asia/Tokyo" });
    const today = dateFormat.todayInPreferredZone(instant);
    expect(dateFormat.formatIsoDate(today, instant)).toBe(word(0));
    // The previous calendar day is Yesterday there, even though the browser's zone may still be on it.
    expect(dateFormat.formatIsoDate("2026-03-05", instant)).toBe(word(-1));
    set({ relativeDates: true, timeZone: "America/Los_Angeles" });
    expect(dateFormat.formatIsoDate(dateFormat.todayInPreferredZone(instant), instant)).toBe(word(0));
  });

  it("is what the Calendar page marks today with (the web package has no runner to render it, so the source is checked)", () => {
    const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src", "pages", "Calendar.tsx"), "utf-8");
    expect(source).toContain("const today = todayInPreferredZone();");
    expect(source).not.toMatch(/const today = toIsoDate\(new Date\(\)\)/);
    expect(source).toContain("startOfMonth(parseCalendarDate(todayInPreferredZone()))");
  });
});
