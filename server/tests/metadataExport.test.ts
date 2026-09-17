import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupTestDb } from "./helpers/testDb.js";

beforeAll(async () => {
  await setupTestDb();
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
