import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

beforeEach(async () => {
  await db.prepare("DELETE FROM import_lists").run();
  await db.prepare("DELETE FROM root_folders").run();
});

async function addRootFolder(mediaType: string): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aonarr-listroute-${mediaType}-`));
  return Number((await db.prepare("INSERT INTO root_folders (path, media_type) VALUES (?, ?)").run(dir, mediaType)).lastInsertRowid);
}

function createList(body: Record<string, unknown>) {
  return request(app)
    .post("/api/import-lists")
    .set("X-Api-Key", apiKey)
    .send({ name: "My list", type: "trakt", url: "https://trakt.tv/users/me/watchlist", ...body });
}

function patchList(id: number, body: Record<string, unknown>) {
  return request(app).patch(`/api/import-lists/${id}`).set("X-Api-Key", apiKey).send(body);
}

async function storedRootFolder(id: number): Promise<number | null> {
  return ((await db.prepare("SELECT root_folder_id FROM import_lists WHERE id = ?").get(id)) as { root_folder_id: number | null }).root_folder_id;
}

describe("import list root folder", () => {
  it("creates a list with its own root folder and returns it, from GET too", async () => {
    const movies = await addRootFolder("movie");

    const res = await createList({ rootFolderId: movies });

    expect(res.status).toBe(201);
    expect(res.body.root_folder_id).toBe(movies);
    const listed = await request(app).get("/api/import-lists").set("X-Api-Key", apiKey);
    expect(listed.body.map((l: { root_folder_id: number | null }) => l.root_folder_id)).toEqual([movies]);
  });

  it("leaves it unset (automatic) when none is given, or when it's null or empty", async () => {
    for (const body of [{}, { rootFolderId: null }, { rootFolderId: "" }]) {
      const res = await createList(body);
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(res.body.root_folder_id).toBeNull();
    }
  });

  it("refuses a root folder that doesn't exist, or isn't a number", async () => {
    const missing = await createList({ rootFolderId: 999999 });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("doesn't exist");
    expect((await createList({ rootFolderId: "movies" })).status).toBe(400);
    expect((await createList({ rootFolderId: 99999999999 })).status).toBe(400);
    expect(await db.prepare("SELECT id FROM import_lists").all()).toEqual([]);
  });

  it("refuses a root folder of a media type the list never adds", async () => {
    const books = await addRootFolder("author");
    const movies = await addRootFolder("movie");
    const music = await addRootFolder("artist");

    const trakt = await createList({ rootFolderId: books });
    expect(trakt.status).toBe(400);
    expect(trakt.body.error).toContain("author");
    expect((await createList({ type: "lastfm", url: "someone", rootFolderId: movies })).status).toBe(400);

    const lastfm = await createList({ type: "lastfm", url: "someone", rootFolderId: music });
    expect(lastfm.status).toBe(201);
    expect(lastfm.body.root_folder_id).toBe(music);
    const shows = await addRootFolder("series");
    const tmdb = await createList({ type: "tmdb", url: "8290123", rootFolderId: shows });
    expect(tmdb.status).toBe(201);
  });

  it("sets, changes and clears it on update, refusing a folder the list can't use", async () => {
    const movies = await addRootFolder("movie");
    const shows = await addRootFolder("series");
    const books = await addRootFolder("author");
    const { id } = (await createList({})).body as { id: number };

    const set = await patchList(id, { rootFolderId: movies });
    expect(set.status).toBe(200);
    expect(set.body.root_folder_id).toBe(movies);
    expect((await patchList(id, { rootFolderId: String(shows) })).body.root_folder_id).toBe(shows);

    const refused = await patchList(id, { rootFolderId: books });
    expect(refused.status).toBe(400);
    expect((await patchList(id, { rootFolderId: 999999 })).status).toBe(400);
    expect(await storedRootFolder(id)).toBe(shows);

    // Other fields leave it alone.
    expect((await patchList(id, { name: "Renamed" })).body.root_folder_id).toBe(shows);
    expect((await patchList(id, { rootFolderId: null })).body.root_folder_id).toBeNull();
    await patchList(id, { rootFolderId: movies });
    expect((await patchList(id, { rootFolderId: "" })).body.root_folder_id).toBeNull();
  });

  it("goes back to automatic when its root folder is removed", async () => {
    const movies = await addRootFolder("movie");
    const { id } = (await createList({ rootFolderId: movies })).body as { id: number };

    expect((await request(app).delete(`/api/root-folders/${movies}`).set("X-Api-Key", apiKey)).status).toBe(204);

    expect(await storedRootFolder(id)).toBeNull();
    expect((await request(app).get("/api/import-lists").set("X-Api-Key", apiKey)).body[0]).toMatchObject({ id, root_folder_id: null });
  });
});
