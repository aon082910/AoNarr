import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
const token = "calendar-test-token";

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
  const { setSetting } = await import("../src/services/settingsStore.js");
  setSetting("calendarToken", token);
});

afterEach(() => {
  vi.useRealTimers();
});

async function insertItem(type: string, title: string, releaseDate: string | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, release_date) VALUES (?, ?, ?, 1, 0, 'unknown', ?)")
        .run(type, title, title.toLowerCase(), releaseDate)
    ).lastInsertRowid
  );
}

function dtstartLines(ics: string): string[] {
  return ics.split("\r\n").filter((l) => l.startsWith("DTSTART"));
}

describe("GET /api/calendar.ics", () => {
  it("never emits a DTSTART for a year-only or year-month release date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));

    const artistId = await insertItem("artist", "Partial Date Artist");
    await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored) VALUES (?, 'Announced Album', '2026-11', 1)").run(artistId);
    await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored) VALUES (?, 'Dated Album', '2026-07-01', 1)").run(artistId);
    await insertItem("movie", "Partial Date Movie", "2026-08");

    const res = await request(app).get(`/api/calendar.ics?token=${token}`);
    expect(res.status).toBe(200);
    const lines = dtstartLines(res.text);
    expect(lines).toContain("DTSTART;VALUE=DATE:20260701");
    for (const line of lines) expect(line).toMatch(/^DTSTART;VALUE=DATE:\d{8}$/);
    expect(res.text).not.toContain("Announced Album");
    expect(res.text).not.toContain("Partial Date Movie");
  });

  it("keeps tonight's episode after UTC has already rolled over to the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 17:30 on 2026-06-20 in UTC-7 — already 00:30 on the 21st in UTC.
    vi.setSystemTime(new Date("2026-06-21T00:30:00Z"));

    const seriesId = await insertItem("series", "Tonight Show");
    await db
      .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, monitored) VALUES (?, 1, 1, 'Pilot', '2026-06-20', 1)")
      .run(seriesId);

    const res = await request(app).get(`/api/calendar.ics?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("SUMMARY:Tonight Show S01E01 - Pilot");
    expect(dtstartLines(res.text)).toContain("DTSTART;VALUE=DATE:20260620");
  });

  it("rejects a request with the wrong token", async () => {
    const res = await request(app).get("/api/calendar.ics?token=wrong");
    expect(res.status).toBe(401);
  });
});
