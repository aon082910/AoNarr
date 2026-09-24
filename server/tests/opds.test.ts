import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let setSetting: (key: string, value: string) => void;
let deleteSetting: (key: string) => void;
const token = "opds-test-token";

beforeAll(async () => {
  ({ app, db } = await setupTestDb());
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
  setSetting("opdsToken", token);
});

afterEach(() => {
  deleteSetting("externalUrl");
});

/** application/atom+xml isn't a type superagent buffers as text on its own — collect it by hand. */
async function getFeed(url: string, host?: string): Promise<{ status: number; text: string }> {
  let req = request(app).get(url);
  if (host) req = req.set("Host", host);
  const res = await req.buffer(true).parse((stream, cb) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (data += chunk));
    stream.on("end", () => cb(null, data));
  });
  return { status: res.status, text: typeof res.body === "string" ? res.body : "" };
}

// Behind the shipped nginx configs the Host header carries no port and req.protocol is always
// "http" — links built from them sent every OPDS reader to port 80 instead of the UI's port.
describe("OPDS feed link base", () => {
  it("emits root-relative links when no External URL is set, never the request's Host header", async () => {
    const res = await getFeed(`/api/opds?token=${token}`, "192.168.1.10");
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<link rel="self" href="/api/opds?token=${token}"`);
    expect(res.text).toContain(`href="/api/opds/type/author?token=${token}"`);
    expect(res.text).not.toContain("192.168.1.10");
  });

  it("builds absolute links from the External URL setting, trimming a trailing slash", async () => {
    setSetting("externalUrl", "https://books.example.com:8443/");
    const res = await getFeed(`/api/opds?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<link rel="self" href="https://books.example.com:8443/api/opds?token=${token}"`);
    expect(res.text).toContain(`href="https://books.example.com:8443/api/opds/type/comic?token=${token}"`);
    expect(res.text).not.toContain("http://127.0.0.1");
  });

  it("uses the same base for acquisition download links", async () => {
    const parentId = Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Opds Author', 'opds author', 1, 1, 'unknown')")
          .run()
      ).lastInsertRowid
    );
    const subId = Number(
      (
        await db
          .prepare("INSERT INTO sub_items (media_item_id, title, has_file, file_path) VALUES (?, 'Opds Book', 1, '/books/Opds Author/Opds Book.epub')")
          .run(parentId)
      ).lastInsertRowid
    );

    const relative = await getFeed(`/api/opds/item/${parentId}?token=${token}`);
    expect(relative.status).toBe(200);
    expect(relative.text).toContain(`href="/api/opds/download/subitem/${subId}?token=${token}"`);

    setSetting("externalUrl", "https://books.example.com");
    const absolute = await getFeed(`/api/opds/item/${parentId}?token=${token}`);
    expect(absolute.text).toContain(`href="https://books.example.com/api/opds/download/subitem/${subId}?token=${token}"`);
  });

  it("still rejects a request without the OPDS token", async () => {
    const res = await request(app).get("/api/opds");
    expect(res.status).toBe(401);
  });
});
