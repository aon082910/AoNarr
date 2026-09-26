import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Unauthenticated on purpose — that's how a Prometheus scraper calls it. */
async function scrape(): Promise<string> {
  const res = await request(app).get("/api/metrics");
  expect(res.status).toBe(200);
  return res.text;
}

function sampleValue(body: string, metric: string): number {
  const line = body.split("\n").find((l) => l.startsWith(`${metric} `));
  expect(line).toBeDefined();
  return Number(line!.slice(metric.length + 1));
}

describe("GET /api/metrics", () => {
  it("labels root-folder disk samples by id and name, never by the folder's host path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-metrics-root-"));
    // A free-text name with a quote, a backslash and a newline — unescaped, the newline would end
    // the sample line mid-label and Prometheus would reject the whole scrape.
    const name = 'Kids "4K"\\\nShelf';
    const id = Number(
      (await db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', ?)").run(dir, name)).lastInsertRowid
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    // Past any cached gauges an earlier scrape in this file left behind.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    try {
      const body = await scrape();

      expect(body).not.toContain(dir);
      expect(body).not.toMatch(/\bpath="/);
      const labels = String.raw`{root_folder_id="${id}",media_type="movie",name="Kids \"4K\"\\\nShelf"}`;
      for (const metric of ["aonarr_disk_free_bytes", "aonarr_disk_total_bytes"]) {
        const line = body.split("\n").find((l) => l.startsWith(`${metric}{root_folder_id="${id}"`));
        expect(line).toBeDefined();
        expect(line!.startsWith(`${metric}${labels} `)).toBe(true);
        expect(Number(line!.slice(`${metric}${labels} `.length))).toBeGreaterThan(0);
      }
    } finally {
      await db.prepare("DELETE FROM root_folders WHERE id = ?").run(id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomputes the history/library-wide gauges at most every few minutes, not on every scrape", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now() + 2 * 60 * 60 * 1000;
    vi.setSystemTime(base);
    const before = sampleValue(await scrape(), "aonarr_repeated_imports");

    const itemId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('movie', 'Metrics Twice', 'metrics twice', 1, 1, 'downloaded')`)
          .run()
      ).lastInsertRowid
    );
    for (const quality of ["720p", "1080p"]) {
      await db
        .prepare("INSERT INTO history (media_item_id, event_type, data, created_at) VALUES (?, 'imported', ?, ?)")
        .run(itemId, JSON.stringify({ itemId, quality }), new Date(base).toISOString());
    }

    vi.setSystemTime(base + 60 * 1000);
    expect(sampleValue(await scrape(), "aonarr_repeated_imports")).toBe(before);

    vi.setSystemTime(base + 6 * 60 * 1000);
    expect(sampleValue(await scrape(), "aonarr_repeated_imports")).toBe(before + 1);
  });

  it("keeps the cheap gauges live between recomputes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now() + 4 * 60 * 60 * 1000;
    vi.setSystemTime(base);
    const before = sampleValue(await scrape(), "aonarr_pending_requests");
    const userId = Number(
      (await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('metrics-household', 'x', 'user')").run()).lastInsertRowid
    );
    await db
      .prepare("INSERT INTO requests (user_id, type, title, status) VALUES (?, 'movie', 'Metrics Request', 'pending')")
      .run(userId);

    vi.setSystemTime(base + 60 * 1000);
    expect(sampleValue(await scrape(), "aonarr_pending_requests")).toBe(before + 1);
  });

  it("reports the free space the server can actually use, not blocks reserved for root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-metrics-reserved-"));
    const id = Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, 'movie')").run(dir)).lastInsertRowid);
    const realStatfs = fs.statfsSync;
    vi.spyOn(fs, "statfsSync").mockImplementation(((p: string, ...rest: unknown[]) =>
      p === dir ? ({ bfree: 30, bavail: 10, blocks: 100, bsize: 1000 } as any) : (realStatfs as any)(p, ...rest)) as any);
    vi.useFakeTimers({ toFake: ["Date"] });
    // Later than every earlier test's clock, so the cached disk gauges are recomputed.
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    try {
      const body = await scrape();

      const labels = `{root_folder_id="${id}",media_type="movie"}`;
      expect(sampleValue(body, `aonarr_disk_free_bytes${labels}`)).toBe(10_000);
      expect(sampleValue(body, `aonarr_disk_total_bytes${labels}`)).toBe(100_000);
    } finally {
      await db.prepare("DELETE FROM root_folders WHERE id = ?").run(id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
