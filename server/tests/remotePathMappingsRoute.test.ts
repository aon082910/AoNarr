import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let clientId: number;
let localDir: string;

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  clientId = Number(
    (await db.prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('qbit', 'qbittorrent', 'localhost', 8080, 1)").run()).lastInsertRowid
  );
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-mapping-"));
});

function post(body: Record<string, unknown>) {
  return request(app).post("/api/remote-path-mappings").set("X-Api-Key", apiKey).send(body);
}

describe("POST /api/remote-path-mappings validation (DL13)", () => {
  it("saves a mapping whose local path exists", async () => {
    const res = await post({ downloadClientId: clientId, remotePath: "/data/downloads", localPath: localDir });
    expect(res.status).toBe(201);
    expect(res.body.localPath).toBe(localDir);
  });

  it("refuses a local path that does not exist inside AoNarr", async () => {
    const res = await post({ downloadClientId: clientId, remotePath: "/other", localPath: path.join(localDir, "nope") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist inside AoNarr/);
  });

  it("refuses a relative local path and a local path that is a file", async () => {
    expect((await post({ downloadClientId: clientId, remotePath: "/r1", localPath: "downloads" })).status).toBe(400);
    const file = path.join(localDir, "file.txt");
    fs.writeFileSync(file, "x");
    expect((await post({ downloadClientId: clientId, remotePath: "/r2", localPath: file })).status).toBe(400);
  });

  it("refuses the same remote path twice for one client, whatever the trailing separator", async () => {
    const res = await post({ downloadClientId: clientId, remotePath: "/data/downloads/", localPath: localDir });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a mapping/);
  });

  it("recognises a duplicate Windows-style remote path with a trailing backslash", async () => {
    expect((await post({ downloadClientId: clientId, remotePath: "D:\\Downloads\\", localPath: localDir })).status).toBe(201);
    expect((await post({ downloadClientId: clientId, remotePath: "D:\\Downloads", localPath: localDir })).status).toBe(409);
  });
});
