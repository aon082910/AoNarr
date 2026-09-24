import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
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

// A sidecar's <thumb> is untrusted text from the library, and whatever resolves here is later
// served by the unauthenticated local-artwork route — so nothing outside the sidecar's own folder,
// and nothing that isn't an image file, may ever resolve.
describe("resolveLocalArtwork — containment and file-type checks", () => {
  /** <root>/Movies/Some Movie (2020) as the sidecar's folder, with <root> itself as "outside". */
  function libraryLayout(): { root: string; dir: string } {
    const root = tmpDir();
    const dir = path.join(root, "Movies", "Some Movie (2020)");
    fs.mkdirSync(dir, { recursive: true });
    return { root, dir };
  }

  it("rejects a relative <thumb> that climbs out of the folder, even when the target really exists", () => {
    const { root, dir } = libraryLayout();
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config", "aonarr.db"), "sqlite bytes");
    fs.writeFileSync(path.join(root, "outside.jpg"), "fake bytes");

    expect(resolveLocalArtwork(dir, "../../config/aonarr.db").posterPath).toBeNull();
    // An image extension alone isn't enough either — it still has to stay inside the folder.
    expect(resolveLocalArtwork(dir, "../../outside.jpg").posterPath).toBeNull();
  });

  it("rejects an absolute <thumb> pointing outside the folder", () => {
    const { root, dir } = libraryLayout();
    const outside = path.join(root, "outside.jpg");
    fs.writeFileSync(outside, "fake bytes");

    expect(resolveLocalArtwork(dir, outside).posterPath).toBeNull();
  });

  it("still falls back to the folder's own poster.jpg when the <thumb> value is rejected", () => {
    const { root, dir } = libraryLayout();
    fs.writeFileSync(path.join(root, "outside.jpg"), "fake bytes");
    fs.writeFileSync(path.join(dir, "poster.jpg"), "fake bytes");

    expect(resolveLocalArtwork(dir, "../../outside.jpg").posterPath).toBe(path.join(dir, "poster.jpg"));
  });

  // Creating a symlink needs elevated rights on Windows; the suite itself runs on Linux.
  it.skipIf(process.platform === "win32")("rejects a symlink inside the folder that points outside it, for the <thumb> and the poster/fanart conventions alike", () => {
    const { root, dir } = libraryLayout();
    const outside = path.join(root, "outside.jpg");
    fs.writeFileSync(outside, "fake bytes");
    fs.symlinkSync(outside, path.join(dir, "linked.jpg"));
    fs.symlinkSync(outside, path.join(dir, "poster.jpg"));
    fs.symlinkSync(outside, path.join(dir, "fanart.jpg"));

    const result = resolveLocalArtwork(dir, "linked.jpg");

    expect(result.posterPath).toBeNull();
    expect(result.backdropPath).toBeNull();
  });

  it("rejects a non-image file inside the folder", () => {
    const { dir } = libraryLayout();
    fs.writeFileSync(path.join(dir, "movie.nfo"), "<movie/>");

    expect(resolveLocalArtwork(dir, "movie.nfo").posterPath).toBeNull();
  });

  it("skips an image-named directory (not a regular file) and moves on to the next convention name", () => {
    const { dir } = libraryLayout();
    fs.mkdirSync(path.join(dir, "poster.jpg"));
    fs.writeFileSync(path.join(dir, "folder.jpg"), "fake bytes");

    expect(resolveLocalArtwork(dir, null).posterPath).toBe(path.join(dir, "folder.jpg"));
  });

  it("accepts every supported image extension for a <thumb> inside the folder (.webp/.gif too)", () => {
    const { dir } = libraryLayout();
    fs.writeFileSync(path.join(dir, "cover.webp"), "fake bytes");
    fs.writeFileSync(path.join(dir, "cover.GIF"), "fake bytes");

    expect(resolveLocalArtwork(dir, "cover.webp").posterPath).toBe(path.join(dir, "cover.webp"));
    expect(resolveLocalArtwork(dir, "cover.GIF").posterPath).toBe(path.join(dir, "cover.GIF"));
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

  async function insertPosterRow(title: string, posterPath: string, token: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, local_poster_path, local_poster_token)
         VALUES ('movie', ?, ?, 1, 1, 'downloaded', ?, ?)`
      )
      .run(title, title.toLowerCase(), posterPath, token);
  }

  it("refuses to serve a stored path without an image extension, even though the file exists (a row written before resolve-time checks)", async () => {
    const dir = tmpDir();
    const secret = path.join(dir, "aonarr.db");
    fs.writeFileSync(secret, "sqlite bytes");
    await insertPosterRow("Stale Traversal Row", secret, "test-non-image-token");
    await insertPosterRow("Stale Relative Row", "../../config/aonarr.db", "test-relative-traversal-token");

    expect((await request(app).get("/api/media/local-artwork/test-non-image-token")).status).toBe(404);
    expect((await request(app).get("/api/media/local-artwork/test-relative-traversal-token")).status).toBe(404);
  });

  describe("a 'mediaserver:' artwork ref", () => {
    afterEach(async () => {
      vi.unstubAllGlobals();
      const { setSetting } = await import("../src/services/settingsStore.js");
      for (const key of ["mediaServerType", "mediaServerUrl", "mediaServerToken"]) setSetting(key, "");
    });

    async function configurePlex(): Promise<void> {
      const { setSetting } = await import("../src/services/settingsStore.js");
      setSetting("mediaServerType", "plex");
      setSetting("mediaServerUrl", "http://plex.local:32400");
      setSetting("mediaServerToken", "plex-owner-token");
    }

    it("is proxied server-side with the credential sent as a header, never in the URL", async () => {
      await configurePlex();
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const fetchMock = vi.fn(async () => new Response(new Uint8Array(imageBytes), { status: 200, headers: { "content-type": "image/png" } }));
      vi.stubGlobal("fetch", fetchMock);
      await insertPosterRow("Media Server Art", "mediaserver:/library/metadata/42/thumb/1700000000", "test-mediaserver-token");

      const res = await request(app)
        .get("/api/media/local-artwork/test-mediaserver-token")
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect((res.body as Buffer).equals(imageBytes)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://plex.local:32400/library/metadata/42/thumb/1700000000");
      expect(url).not.toContain("plex-owner-token");
      expect((init.headers as Record<string, string>)["X-Plex-Token"]).toBe("plex-owner-token");
    });

    it("404s when the upstream response isn't an image", async () => {
      await configurePlex();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })));
      await insertPosterRow("Media Server Non Image", "mediaserver:/library/metadata/43/thumb/1", "test-mediaserver-html-token");

      const res = await request(app).get("/api/media/local-artwork/test-mediaserver-html-token");

      expect(res.status).toBe(404);
    });

    it("404s without any network call when no media server is configured anymore", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await insertPosterRow("Media Server Gone", "mediaserver:/library/metadata/44/thumb/1", "test-mediaserver-unconfigured-token");

      const res = await request(app).get("/api/media/local-artwork/test-mediaserver-unconfigured-token");

      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
