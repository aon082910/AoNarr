import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import AdmZip from "adm-zip";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

const movie = {
  type: "movie",
  title: "Dune",
  year: 2021,
  overview: "A noble family becomes embroiled in a war.",
  posterUrl: "https://example.com/poster.jpg",
  externalIds: { tmdb: "438631", imdb: "tt1160419" },
};

describe("buildNfo", () => {
  it("uses <movie> as the root for a single-shape type", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    const xml = buildNfo(movie);
    expect(xml).toContain("<movie>");
    expect(xml).toContain("<title>Dune</title>");
    expect(xml).toContain('<uniqueid type="tmdb">438631</uniqueid>');
  });

  it("uses <tvshow> as the root for episodic/collection-shape types, not just movies", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    expect(buildNfo({ ...movie, type: "series" })).toContain("<tvshow>");
    expect(buildNfo({ ...movie, type: "artist" })).toContain("<tvshow>");
  });

  it("escapes XML-significant characters in title/overview", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    const xml = buildNfo({ ...movie, title: `Bob & "Doug" <McKenzie>`, overview: null });
    expect(xml).toContain("Bob &amp; &quot;Doug&quot; &lt;McKenzie&gt;");
  });

  it("omits optional elements entirely when the field is absent, rather than emitting empty tags", async () => {
    const { buildNfo } = await import("../src/services/metadataExport.js");
    const xml = buildNfo({ type: "movie", title: "Bare", year: null, overview: null, posterUrl: null, externalIds: {} });
    expect(xml).not.toContain("<year>");
    expect(xml).not.toContain("<plot>");
    expect(xml).not.toContain("<thumb");
    expect(xml).not.toContain("<uniqueid");
  });
});

describe("buildJson / buildPlexMatch / buildCalibreOpf", () => {
  it("buildJson round-trips the item through JSON", async () => {
    const { buildJson } = await import("../src/services/metadataExport.js");
    expect(JSON.parse(buildJson(movie))).toEqual(movie);
  });

  it("buildPlexMatch includes only the ids that are actually present", async () => {
    const { buildPlexMatch } = await import("../src/services/metadataExport.js");
    const text = buildPlexMatch(movie);
    expect(text).toContain("tmdbid: 438631");
    expect(text).toContain("imdbid: tt1160419");
    expect(text).not.toContain("tvdbid:");
  });

  it("buildCalibreOpf puts an ISBN in its own dc:identifier with the ISBN scheme", async () => {
    const { buildCalibreOpf } = await import("../src/services/metadataExport.js");
    const opf = buildCalibreOpf({ ...movie, externalIds: { isbn: "9780593099322" } });
    expect(opf).toContain('opf:scheme="ISBN"');
    expect(opf).toContain("9780593099322");
  });
});

describe("safeFileName", () => {
  it("strips filesystem-illegal characters and trims whitespace", async () => {
    const { safeFileName } = await import("../src/services/metadataExport.js");
    expect(safeFileName('Movie: "Subtitle" <2021>')).toBe("Movie Subtitle 2021");
  });

  it("truncates an excessively long title to 200 characters", async () => {
    const { safeFileName } = await import("../src/services/metadataExport.js");
    expect(safeFileName("A".repeat(500)).length).toBe(200);
  });
});

describe("writeNfoSidecar", () => {
  it("writes a sidecar with the same basename as the media file, next to it", async () => {
    const { writeNfoSidecar } = await import("../src/services/metadataExport.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-nfo-"));
    const mediaFile = path.join(dir, "Dune (2021).mkv");
    fs.writeFileSync(mediaFile, "fake video content");

    writeNfoSidecar(mediaFile, movie);

    const nfoPath = path.join(dir, "Dune (2021).nfo");
    expect(fs.existsSync(nfoPath)).toBe(true);
    expect(fs.readFileSync(nfoPath, "utf-8")).toContain("<title>Dune</title>");
  });

  it("never throws even when the target directory doesn't exist", async () => {
    const { writeNfoSidecar } = await import("../src/services/metadataExport.js");
    expect(() => writeNfoSidecar("/definitely/does/not/exist/movie.mkv", movie)).not.toThrow();
  });
});

describe("fetchPosterBuffer", () => {
  it("returns null without making a request when there's no URL", async () => {
    const { fetchPosterBuffer } = await import("../src/services/metadataExport.js");
    expect(await fetchPosterBuffer(null)).toBeNull();
  });
});

async function insertItem(type: string, title: string, year: number | null): Promise<number> {
  // No poster_url, so the exports never go to the network for artwork.
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status) VALUES (?, ?, ?, ?, 1, 0, 'missing')`)
    .run(type, title, title.toLowerCase(), year);
  return Number(result.lastInsertRowid);
}

function getZip(url: string) {
  return request(app)
    .get(url)
    .set("X-Api-Key", apiKey)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

describe("GET /api/media/:id/export", () => {
  it("downloads an item whose title is outside Latin-1, with the name carried in an RFC 5987 filename*", async () => {
    const id = await insertItem("artist", "坂本龍一", null);

    const res = await request(app).get(`/api/media/${id}/export?format=nfo`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("坂本龍一")}.nfo`);
    expect(res.text).toContain("<title>坂本龍一</title>");
  });

  it("still names a plexmatch download exactly .plexmatch", async () => {
    const id = await insertItem("movie", "Plexmatch Name Test", 2001);

    const res = await request(app).get(`/api/media/${id}/export?format=plexmatch`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename=".plexmatch"');
  });
});

describe("bulk zip exports with same-titled items", () => {
  it("gives two same-titled items their own .nfo, told apart by year", async () => {
    await insertItem("series", "Dune", 1984);
    await insertItem("series", "Dune", 2021);
    await insertItem("series", "Arrival", 2016);

    const res = await getZip("/api/media/export-bulk.zip?type=series&format=nfo");

    expect(res.status).toBe(200);
    const zip = new AdmZip(res.body as Buffer);
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(["Arrival.nfo", "Dune (1984).nfo", "Dune (2021).nfo"]);
    expect(zip.readAsText("Dune (1984).nfo")).toContain("<year>1984</year>");
    expect(zip.readAsText("Dune (2021).nfo")).toContain("<year>2021</year>");
  });

  it("falls back to the item id when the title and year are both shared (plexmatch folders)", async () => {
    const first = await insertItem("adult", "Solaris", 1972);
    const second = await insertItem("adult", "solaris", 1972);

    const res = await getZip("/api/media/export-bulk.zip?type=adult&format=plexmatch");

    expect(res.status).toBe(200);
    const names = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName).sort();
    // Whichever row comes back first keeps the plain "title (year)" folder; the other gets its id.
    // Compared case-insensitively, since "Solaris" and "solaris" collide on a case-insensitive disk.
    const lower = names.map((n) => n.toLowerCase());
    expect(lower).toHaveLength(2);
    expect(lower).toContain("solaris (1972)/.plexmatch");
    expect([`solaris (1972) [${first}]/.plexmatch`, `solaris (1972) [${second}]/.plexmatch`]).toContain(
      lower.find((n) => n !== "solaris (1972)/.plexmatch")
    );
  });

  it("keeps each same-titled book's metadata.opf in its own Calibre folder", async () => {
    const first = await insertItem("book", "Emma", null);
    const second = await insertItem("book", "Emma", null);

    const res = await getZip("/api/media/export-calibre.zip?type=book");

    expect(res.status).toBe(200);
    const names = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain("Emma/metadata.opf");
    expect([`Emma [${first}]/metadata.opf`, `Emma [${second}]/metadata.opf`]).toContain(names.find((n) => n !== "Emma/metadata.opf"));
  });
});
