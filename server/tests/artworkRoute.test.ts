import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

const ARTWORK_COLUMNS = "poster_url, backdrop_url, local_poster_path, local_poster_token, local_backdrop_path, local_backdrop_token";

async function insertItem(title: string, columns: Record<string, string | null> = {}): Promise<number> {
  const names = Object.keys(columns);
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title${names.map((n) => `, ${n}`).join("")})
           VALUES ('rom', ?, ?${names.map(() => ", ?").join("")})`
        )
        .run(title, title.toLowerCase(), ...Object.values(columns))
    ).lastInsertRowid
  );
}

async function artwork(id: number) {
  return (await db.prepare(`SELECT ${ARTWORK_COLUMNS} FROM media_items WHERE id = ?`).get(id)) as Record<string, string | null>;
}

function select(id: number, body: Record<string, unknown>) {
  return request(app).post(`/api/media/${id}/artwork/select`).set("X-Api-Key", apiKey).send(body);
}

describe("POST /api/media/:id/artwork/select", () => {
  const credentialed = "https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=dev-2&devpassword=dev-secret-2&ssid=me&sspassword=my-secret-2&jeuid=9&media=box-2D(wor)";
  const backdropRef = "screenscraper:https://neoclone.screenscraper.fr/api2/mediaJeu.php?jeuid=9&media=fanart";

  it("stores a ScreenScraper pick behind the local-artwork proxy, credential-free", async () => {
    const id = await insertItem("Select ScreenScraper Art", { poster_url: "https://images.igdb.com/old.jpg", backdrop_url: "https://images.igdb.com/old-bg.jpg" });

    const res = await select(id, { posterUrl: credentialed, backdropUrl: backdropRef });
    expect(res.status).toBe(200);

    const row = await artwork(id);
    expect(row.local_poster_token).toMatch(/^[0-9a-f]{40}$/);
    expect(row.poster_url).toBe(`/api/media/local-artwork/${row.local_poster_token}`);
    expect(row.local_poster_path).toMatch(/^screenscraper:https:\/\/neoclone\.screenscraper\.fr\/api2\/mediaJeu\.php\?/);
    expect(row.local_poster_path).toContain("jeuid=9");
    expect(row.backdrop_url).toBe(`/api/media/local-artwork/${row.local_backdrop_token}`);
    expect(row.local_backdrop_path).toBe(backdropRef);
    expect(row.local_backdrop_token).not.toBe(row.local_poster_token);
    expect(JSON.stringify(row)).not.toMatch(/dev-2|dev-secret-2|my-secret-2/);
    expect(res.body.posterUrl).toBe(row.poster_url);
    expect(res.body.backdropUrl).toBe(row.backdrop_url);
  });

  it("stores any other pick as given, clearing the local artwork it replaces and leaving the other one alone", async () => {
    const id = await insertItem("Select Plain Art", {
      poster_url: "/api/media/local-artwork/old-poster-token",
      local_poster_path: "/library/Game/poster.jpg",
      local_poster_token: "old-poster-token",
      backdrop_url: "/api/media/local-artwork/old-backdrop-token",
      local_backdrop_path: "/library/Game/fanart.jpg",
      local_backdrop_token: "old-backdrop-token",
    });

    const res = await select(id, { posterUrl: "https://images.igdb.com/new.jpg" });
    expect(res.status).toBe(200);

    expect(await artwork(id)).toEqual({
      poster_url: "https://images.igdb.com/new.jpg",
      local_poster_path: null,
      local_poster_token: null,
      backdrop_url: "/api/media/local-artwork/old-backdrop-token",
      local_backdrop_path: "/library/Game/fanart.jpg",
      local_backdrop_token: "old-backdrop-token",
    });
  });

  it("replaces a proxied ScreenScraper poster with a plain one", async () => {
    const id = await insertItem("Select Replaces Proxied Art");
    await select(id, { posterUrl: credentialed });
    const res = await select(id, { posterUrl: "https://images.igdb.com/replacement.jpg" });
    expect(res.status).toBe(200);

    const row = await artwork(id);
    expect(row.poster_url).toBe("https://images.igdb.com/replacement.jpg");
    expect(row.local_poster_path).toBeNull();
    expect(row.local_poster_token).toBeNull();
  });

  it("400s without either URL, and 404s for an unknown item", async () => {
    const id = await insertItem("Select Nothing");
    expect((await select(id, {})).status).toBe(400);
    expect((await select(99999999, { posterUrl: "https://images.igdb.com/x.jpg" })).status).toBe(404);
  });
});
