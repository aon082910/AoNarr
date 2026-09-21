import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";
import { resolveLocalArtwork } from "../src/services/localArtwork.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-localartwork-"));
}

describe("resolveLocalArtwork", () => {
  it("resolves a <thumb> value that's a relative filename against the given folder", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "custom-poster.jpg"), "fake bytes");
    const result = resolveLocalArtwork(dir, "custom-poster.jpg");
    expect(result.posterPath).toBe(path.join(dir, "custom-poster.jpg"));
  });

  it("leaves a real http(s) thumb value alone entirely — never treated as local", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "poster.jpg"), "fake bytes");
    // Even though poster.jpg exists in this folder, an explicit *working* remote URL wins — the
    // bare-file convention is a fallback for "no usable thumb value", not an override.
    const result = resolveLocalArtwork(dir, "https://example.com/real-poster.jpg");
    expect(result.posterPath).toBeNull();
  });

  it("falls back to the bare poster.jpg/folder.jpg convention when there's no thumb value at all", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "folder.jpg"), "fake bytes");
    const result = resolveLocalArtwork(dir, null);
    expect(result.posterPath).toBe(path.join(dir, "folder.jpg"));
  });

  it("falls back to the bare-file convention when the thumb's own relative file doesn't exist", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "poster.jpg"), "fake bytes");
    const result = resolveLocalArtwork(dir, "missing-file.jpg");
    expect(result.posterPath).toBe(path.join(dir, "poster.jpg"));
  });

  it("resolves fanart.jpg/backdrop.jpg as backdrop independently of poster resolution", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "fanart.jpg"), "fake bytes");
    const result = resolveLocalArtwork(dir, null);
    expect(result.posterPath).toBeNull();
    expect(result.backdropPath).toBe(path.join(dir, "fanart.jpg"));
  });

  it("returns nulls when neither convention finds anything", () => {
    const dir = tmpDir();
    const result = resolveLocalArtwork(dir, null);
    expect(result.posterPath).toBeNull();
    expect(result.backdropPath).toBeNull();
  });
});

describe("GET /api/media/local-artwork/:token", () => {
  let app: Express;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    ({ app, db } = await setupTestDb());
  });

  it("streams a local poster's bytes with no auth header required", async () => {
    const dir = tmpDir();
    const posterPath = path.join(dir, "poster.jpg");
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 1]);
    fs.writeFileSync(posterPath, fakeJpeg);
    const token = "test-poster-token-1";
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, local_poster_path, local_poster_token)
         VALUES ('movie', 'Local Art Movie', 'local art movie', 1, 1, 'downloaded', ?, ?)`
      )
      .run(posterPath, token);

    const res = await request(app)
      .get(`/api/media/local-artwork/${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(fakeJpeg)).toBe(true);
  });

  it("also serves a backdrop by its own distinct token", async () => {
    const dir = tmpDir();
    const backdropPath = path.join(dir, "fanart.jpg");
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);
    fs.writeFileSync(backdropPath, fakeJpeg);
    const token = "test-backdrop-token-1";
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, local_backdrop_path, local_backdrop_token)
         VALUES ('movie', 'Local Backdrop Movie', 'local backdrop movie', 1, 1, 'downloaded', ?, ?)`
      )
      .run(backdropPath, token);

    const res = await request(app)
      .get(`/api/media/local-artwork/${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(fakeJpeg)).toBe(true);
  });

  it("404s for an unknown token", async () => {
    const res = await request(app).get("/api/media/local-artwork/nonexistent-token");
    expect(res.status).toBe(404);
  });
});
