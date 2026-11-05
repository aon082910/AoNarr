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

describe("POST /api/remote-path-mappings: a local path that reaches too far (M3)", () => {
  const rootFolderAt = async (dir: string) => db.prepare("INSERT INTO root_folders (path, media_type, name) VALUES (?, 'movie', 'library')").run(dir);
  const mappingCount = async () => Number(((await db.prepare("SELECT COUNT(*) AS c FROM remote_path_mappings").get()) as any).c);

  it("refuses the root of a disk, and saves nothing", async () => {
    const before = await mappingCount();
    const res = await post({ downloadClientId: clientId, remotePath: "/everything", localPath: path.parse(localDir).root });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/root of a disk/);
    expect(await mappingCount()).toBe(before);
  });

  it("refuses a folder that is a library root folder, or holds one, and takes the folders beside it", async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-mapping-holder-"));
    const library = path.join(holder, "movies");
    const downloads = path.join(holder, "downloads");
    fs.mkdirSync(library);
    fs.mkdirSync(downloads);
    await rootFolderAt(library);
    try {
      const before = await mappingCount();
      for (const [i, localPath] of [library, holder, path.join(holder, "movies", "..", "movies")].entries()) {
        const res = await post({ downloadClientId: clientId, remotePath: `/wide/${i}`, localPath });
        expect(res.status, localPath).toBe(400);
        expect(res.body.error).toMatch(/library root folder/);
      }
      expect(await mappingCount()).toBe(before);
      // The download folder next to the library is what a mapping is for.
      const ok = await post({ downloadClientId: clientId, remotePath: "/wide/downloads", localPath: downloads });
      expect(ok.status).toBe(201);
    } finally {
      await db.prepare("DELETE FROM root_folders WHERE path = ?").run(library);
      fs.rmSync(holder, { recursive: true, force: true });
    }
  });

  it("refuses a folder that reaches a library root folder through a symbolic link", async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-mapping-link-"));
    const library = path.join(holder, "movies");
    fs.mkdirSync(library);
    const link = path.join(os.tmpdir(), `aonarr-mapping-linked-${path.basename(holder)}`);
    fs.symlinkSync(holder, link, "dir");
    await rootFolderAt(library);
    try {
      const res = await post({ downloadClientId: clientId, remotePath: "/wide/link", localPath: link });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/library root folder/);
    } finally {
      await db.prepare("DELETE FROM root_folders WHERE path = ?").run(library);
      fs.rmSync(link, { force: true });
      fs.rmSync(holder, { recursive: true, force: true });
    }
  });
});
