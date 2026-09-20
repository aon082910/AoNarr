import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let setSetting: (key: string, value: string) => void;
let backupDir: string;

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-test-backups-"));
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
