import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers/testDb.js";

let exporter: typeof import("../src/services/metadataExport.js");
let dir: string;

beforeAll(async () => {
  await setupTestDb();
  exporter = await import("../src/services/metadataExport.js");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-nfo-"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const item = { type: "movie", title: "Film", year: 2020, overview: "A film.", posterUrl: null, externalIds: { tmdb: "1" } };

describe("an import does not wipe an NFO another tool wrote (MM21)", () => {
  it("keeps a richer NFO and refreshes one AoNarr wrote", () => {
    const file = path.join(dir, "Film (2020).mkv");
    const nfo = path.join(dir, "Film (2020).nfo");
    fs.writeFileSync(nfo, "<movie><title>Film</title><plot>Hand tuned</plot><actor><name>Someone</name></actor></movie>");

    exporter.writeNfoSidecar(file, item, { keepRicher: true });
    expect(fs.readFileSync(nfo, "utf-8")).toContain("<actor>");

    fs.writeFileSync(nfo, exporter.buildNfo({ ...item, overview: "Older plot" }));
    exporter.writeNfoSidecar(file, item, { keepRicher: true });
    expect(fs.readFileSync(nfo, "utf-8")).toContain("A film.");
  });

  it("treats a movie.nfo beside the file as richer too, and still overwrites when not asked to keep", () => {
    const sub = fs.mkdtempSync(path.join(dir, "m-"));
    fs.writeFileSync(path.join(sub, "movie.nfo"), "<movie><title>Film</title><rating>8</rating></movie>");
    exporter.writeNfoSidecar(path.join(sub, "Film.mkv"), item, { keepRicher: true });
    expect(fs.existsSync(path.join(sub, "Film.nfo"))).toBe(false);

    exporter.writeNfoSidecar(path.join(sub, "Film.mkv"), item);
    expect(fs.existsSync(path.join(sub, "Film.nfo"))).toBe(true);
  });

  it("writes Kodi's episodedetails once per episode and never over another tool's", () => {
    const file = path.join(dir, "Show - S01E01-E02.mkv");
    exporter.writeEpisodeNfoSidecar(file, [
      { showTitle: "Show", title: "One", season: 1, episode: 1, aired: "2020-01-01", overview: "First" },
      { showTitle: "Show", title: "Two & more", season: 1, episode: 2, aired: null, overview: null },
    ]);
    const written = fs.readFileSync(path.join(dir, "Show - S01E01-E02.nfo"), "utf-8");
    expect(written.match(/<episodedetails>/g)).toHaveLength(2);
    expect(written).toContain("<aired>2020-01-01</aired>");
    expect(written).toContain("Two &amp; more");
    expect(exporter.isAonarrShapedNfo(written)).toBe(true);

    const other = path.join(dir, "Other.mkv");
    fs.writeFileSync(path.join(dir, "Other.nfo"), "<episodedetails><title>x</title><director>Y</director></episodedetails>");
    exporter.writeEpisodeNfoSidecar(other, [{ showTitle: "Show", title: "One", season: 1, episode: 1, aired: null, overview: null }]);
    expect(fs.readFileSync(path.join(dir, "Other.nfo"), "utf-8")).toContain("<director>");
  });

  it("writes tvshow.nfo only when there is none", () => {
    const show = fs.mkdtempSync(path.join(dir, "s-"));
    exporter.writeTvShowNfoIfMissing(show, { ...item, type: "series" });
    expect(fs.readFileSync(path.join(show, "tvshow.nfo"), "utf-8")).toContain("<tvshow>");
    fs.writeFileSync(path.join(show, "tvshow.nfo"), "mine");
    exporter.writeTvShowNfoIfMissing(show, { ...item, type: "series" });
    expect(fs.readFileSync(path.join(show, "tvshow.nfo"), "utf-8")).toBe("mine");
  });
});
