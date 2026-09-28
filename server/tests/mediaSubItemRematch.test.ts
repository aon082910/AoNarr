import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const searchBooks = vi.fn();
vi.mock("../src/services/metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/metadata.js")>()),
  searchBooks: (...args: unknown[]) => searchBooks(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

async function insertAuthor(title: string): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', ?, ?, 1, 0, 'missing')`)
    .run(title, title.toLowerCase());
  return Number(result.lastInsertRowid);
}

async function insertBook(authorId: number, title: string): Promise<number> {
  const result = await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, ?, 1, 0)`).run(authorId, title);
  return Number(result.lastInsertRowid);
}

describe("GET /api/media/:id/subitems/:subItemId/search", () => {
  it("searches by the book's own title, not the author's", async () => {
    const authorId = await insertAuthor("Some Author");
    const bookId = await insertBook(authorId, "Wrong Title");
    searchBooks.mockResolvedValue([{ title: "The Real Book", year: 2001, overview: "A real book.", posterUrl: "http://p", externalIds: { openlibrary: "/works/OL1W" } }]);

    const res = await request(app)
      .get(`/api/media/${authorId}/subitems/${bookId}/search?query=The+Real+Book&provider=openlibrary`)
      .set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ title: "The Real Book", year: 2001, overview: "A real book.", posterUrl: "http://p", externalIds: { openlibrary: "/works/OL1W" } }]);
    expect(searchBooks).toHaveBeenCalledWith("The Real Book", "openlibrary");
  });

  it("re-ranks results so an exact-year hit sorts first, without dropping the others", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Book");
    searchBooks.mockResolvedValue([
      { title: "Book", year: 1990, overview: null, posterUrl: null, externalIds: {} },
      { title: "Book", year: 2001, overview: null, posterUrl: null, externalIds: {} },
    ]);

    const res = await request(app).get(`/api/media/${authorId}/subitems/${bookId}/search?query=Book&provider=openlibrary&year=2001`).set("X-Api-Key", apiKey);

    expect(res.body.map((r: any) => r.year)).toEqual([2001, 1990]);
  });

  it("404s for a book under a different author", async () => {
    const authorId = await insertAuthor("Real Author");
    const bookId = await insertBook(authorId, "Book");
    const unrelatedId = await insertAuthor("Unrelated Author");

    const res = await request(app).get(`/api/media/${unrelatedId}/subitems/${bookId}/search?query=x&provider=openlibrary`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });

  it("400s when query is missing, without calling searchBooks", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Book");
    searchBooks.mockClear();

    const res = await request(app).get(`/api/media/${authorId}/subitems/${bookId}/search?provider=openlibrary`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(400);
    expect(searchBooks).not.toHaveBeenCalled();
  });

  it("surfaces a searchBooks failure as a 400, e.g. an unsupported provider", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Book");
    searchBooks.mockRejectedValue(new Error('"hardcover" doesn\'t support searching for a book by title'));

    const res = await request(app).get(`/api/media/${authorId}/subitems/${bookId}/search?query=x&provider=hardcover`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("doesn't support searching for a book by title");
  });
});

describe("POST /api/media/:id/subitems/:subItemId/rematch", () => {
  it("applies title/overview/poster/release date/external id, leaving the file (has_file/file_path) untouched", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Wrong Title");
    await db.prepare("UPDATE sub_items SET has_file = 1, file_path = ? WHERE id = ?").run("/books/Author/book.epub", bookId);

    const res = await request(app)
      .post(`/api/media/${authorId}/subitems/${bookId}/rematch`)
      .set("X-Api-Key", apiKey)
      .send({
        title: "The Real Book",
        overview: "A real description.",
        posterUrl: "http://cover",
        releaseDate: "2001-05-01",
        externalIds: { openlibrary: "/works/OL1W" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: "The Real Book",
      overview: "A real description.",
      posterUrl: "http://cover",
      releaseDate: "2001-05-01",
      externalId: "/works/OL1W",
      externalProvider: "openlibrary",
    });
    const row = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(bookId)) as any;
    expect(Number(row.has_file)).toBe(1);
    expect(row.file_path).toBe("/books/Author/book.epub");
  });

  it("clears overview/poster/external id when the picked result has none, rather than leaving the old values behind", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Book");
    await db.prepare("UPDATE sub_items SET overview = 'old', poster_url = 'http://old', external_id = 'old-id', external_provider = 'openlibrary' WHERE id = ?").run(bookId);

    const res = await request(app).post(`/api/media/${authorId}/subitems/${bookId}/rematch`).set("X-Api-Key", apiKey).send({ title: "New Title", externalIds: {} });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "New Title", overview: null, posterUrl: null, externalId: null, externalProvider: null });
  });

  it("400s without a title", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Book");
    const res = await request(app).post(`/api/media/${authorId}/subitems/${bookId}/rematch`).set("X-Api-Key", apiKey).send({});
    expect(res.status).toBe(400);
  });

  it("404s for a book under a different author, changing neither", async () => {
    const authorId = await insertAuthor("Real Author");
    const bookId = await insertBook(authorId, "Book");
    const unrelatedId = await insertAuthor("Unrelated Author");

    const res = await request(app).post(`/api/media/${unrelatedId}/subitems/${bookId}/rematch`).set("X-Api-Key", apiKey).send({ title: "Hijacked" });
    expect(res.status).toBe(404);
    const row = (await db.prepare("SELECT title FROM sub_items WHERE id = ?").get(bookId)) as any;
    expect(row.title).toBe("Book");
  });

  it("401s without any credentials", async () => {
    const authorId = await insertAuthor("Author");
    const bookId = await insertBook(authorId, "Book");
    const res = await request(app).post(`/api/media/${authorId}/subitems/${bookId}/rematch`).send({ title: "x" });
    expect(res.status).toBe(401);
  });
});
