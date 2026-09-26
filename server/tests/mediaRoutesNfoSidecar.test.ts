import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const refreshOneMediaItem = vi.fn();
vi.mock("../src/services/libraryScan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/libraryScan.js")>()),
  refreshOneMediaItem: (...args: unknown[]) => refreshOneMediaItem(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;

// What tinyMediaManager/Radarr leave next to a movie: far more than AoNarr's own six fields.
const RICH_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!--created by tinyMediaManager-->
<movie>
  <title>Heat</title>
  <year>1995</year>
  <plot>A group of professional bank robbers.</plot>
  <genre>Crime</genre>
  <actor><name>Al Pacino</name><role>Vincent Hanna</role></actor>
  <ratings><rating name="imdb" max="10"><value>8.3</value></rating></ratings>
  <uniqueid type="imdb">tt0113277</uniqueid>
</movie>`;

async function insertMovieWithFile(fileName = "Heat (1995).mkv"): Promise<{ id: number; dir: string; nfoPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-nfo-route-"));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, "video");
  const result = await db
    .prepare(
      `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, path, external_ids)
       VALUES ('movie', 'Heat', 'heat', 1995, 1, 1, 'downloaded', ?, ?)`
    )
    .run(filePath, JSON.stringify({ tmdb: "949" }));
  const nfoPath = path.join(dir, `${path.basename(fileName, path.extname(fileName))}.nfo`);
  return { id: Number(result.lastInsertRowid), dir, nfoPath };
}

function patchTitle(id: number, title: string) {
  return request(app).patch(`/api/media/${id}`).set("X-Api-Key", apiKey).send({ title, year: 1995, overview: "Edited.", posterUrl: null });
}

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(() => {
  refreshOneMediaItem.mockReset().mockResolvedValue({ ok: true, childrenAdded: 0 });
});

describe("NFO sidecar on metadata edit (PATCH /api/media/:id)", () => {
  it("writes nothing while the Write NFO setting is off", async () => {
    setSetting("writeNfoOnImport", "0");
    const { id, nfoPath } = await insertMovieWithFile();

    const res = await patchTitle(id, "Heat Edited");

    expect(res.status).toBe(200);
    expect(fs.existsSync(nfoPath)).toBe(false);
  });

  it("writes a new sidecar when the setting is on and there isn't one", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, nfoPath } = await insertMovieWithFile();

    await patchTitle(id, "Heat Edited");

    expect(fs.readFileSync(nfoPath, "utf-8")).toContain("<title>Heat Edited</title>");
  });

  it("refreshes a sidecar AoNarr wrote itself", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, nfoPath } = await insertMovieWithFile();
    const { buildNfo } = await import("../src/services/metadataExport.js");
    fs.writeFileSync(nfoPath, buildNfo({ type: "movie", title: "Heat", year: 1995, overview: "Old.", posterUrl: "https://x/p.jpg", externalIds: { tmdb: "949" } }));

    await patchTitle(id, "Heat (Director's Cut)");

    const nfo = fs.readFileSync(nfoPath, "utf-8");
    expect(nfo).toContain("<title>Heat (Director's Cut)</title>");
    expect(nfo).toContain('<uniqueid type="tmdb">949</uniqueid>');
  });

  it("leaves another tool's richer sidecar untouched", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, nfoPath } = await insertMovieWithFile();
    fs.writeFileSync(nfoPath, RICH_NFO);

    const res = await patchTitle(id, "Heat Edited");

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Heat Edited");
    expect(fs.readFileSync(nfoPath, "utf-8")).toBe(RICH_NFO);
  });

  it("doesn't create a basename sidecar that would shadow a user's movie.nfo", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, dir, nfoPath } = await insertMovieWithFile();
    fs.writeFileSync(path.join(dir, "movie.nfo"), RICH_NFO);

    await patchTitle(id, "Heat Edited");

    expect(fs.existsSync(nfoPath)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "movie.nfo"), "utf-8")).toBe(RICH_NFO);
  });

  it("still writes the sidecar of a file that is itself named movie.mkv", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, nfoPath } = await insertMovieWithFile("movie.mkv");

    await patchTitle(id, "Heat Edited");

    expect(fs.readFileSync(nfoPath, "utf-8")).toContain("<title>Heat Edited</title>");
  });
});

describe("NFO sidecar on rematch (POST /api/media/:id/rematch)", () => {
  it("leaves another tool's sidecar untouched", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, nfoPath } = await insertMovieWithFile();
    fs.writeFileSync(nfoPath, RICH_NFO);

    const res = await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Heat", year: 1995, externalIds: { tmdb: "949" } });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(nfoPath, "utf-8")).toBe(RICH_NFO);
  });

  it("writes nothing while the Write NFO setting is off", async () => {
    setSetting("writeNfoOnImport", "0");
    const { id, nfoPath } = await insertMovieWithFile();

    await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Heat", externalIds: { tmdb: "949" } });

    expect(fs.existsSync(nfoPath)).toBe(false);
  });

  it("writes the new match's ids when the setting is on", async () => {
    setSetting("writeNfoOnImport", "1");
    const { id, nfoPath } = await insertMovieWithFile();

    await request(app).post(`/api/media/${id}/rematch`).set("X-Api-Key", apiKey).send({ title: "Heat", year: 1995, externalIds: { tmdb: "950" } });

    expect(fs.readFileSync(nfoPath, "utf-8")).toContain('<uniqueid type="tmdb">950</uniqueid>');
  });
});
