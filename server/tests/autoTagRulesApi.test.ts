import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let userToken: string;
let invalidateAutoTagRules: (typeof import("../src/services/autoTag.js"))["invalidateAutoTagRules"];
let isJobBusy: (typeof import("../src/services/jobRegistry.js"))["isJobBusy"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ invalidateAutoTagRules } = await import("../src/services/autoTag.js"));
  ({ isJobBusy } = await import("../src/services/jobRegistry.js"));
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number((await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('household', ?, 'user')").run(hashPassword("x"))).lastInsertRowid);
  ({ token: userToken } = await createSession(userId));
});

beforeEach(async () => {
  for (const t of ["media_item_auto_tags", "auto_tag_rules", "media_item_tags", "media_items", "tags", "import_lists", "audit_log"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  invalidateAutoTagRules();
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

async function tag(name: string): Promise<number> {
  const res = await authed(request(app).post("/api/tags")).send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function list(name = "Watchlist"): Promise<number> {
  return Number((await db.prepare("INSERT INTO import_lists (name, type, url) VALUES (?, 'trakt', 'u')").run(name)).lastInsertRowid);
}

async function movie(title: string, genres: string[] = []): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO media_items (type, title, sort_title, genres, monitored, has_file, status) VALUES ('movie', ?, ?, ?, 1, 0, 'unknown')")
        .run(title, title.toLowerCase(), genres.length > 0 ? JSON.stringify(genres) : null)
    ).lastInsertRowid
  );
}

async function createRule(body: Record<string, unknown>) {
  return authed(request(app).post("/api/auto-tag-rules")).send(body);
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function auditEvents(type: string): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return ((await db.prepare("SELECT detail FROM audit_log WHERE event_type = ?").all(type)) as { detail: string }[]).map((r) => r.detail);
}

describe("creating a rule", () => {
  it("stores the conditions and tags, with the defaults and the genres tidied", async () => {
    const t = await tag("kids");
    const l = await list();

    const res = await createRule({ name: "  Kids stuff ", genres: [" Animation ", "animation", "Family", ""], libraryTypes: ["movie", "movie", "series"], listIds: [l, l], tagIds: [t, t] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Kids stuff",
      enabled: true,
      match: "any",
      libraryTypes: ["movie", "series"],
      genres: ["Animation", "Family"],
      listIds: [l],
      tagIds: [t],
      removeWhenUnmatched: false,
      lastApply: null,
    });
    expect((await authed(request(app).get("/api/auto-tag-rules"))).body).toHaveLength(1);
    expect(await auditEvents("auto_tag_rule_added")).toEqual(["Kids stuff"]);
  });

  it.each([
    ["no condition at all, which would tag the whole library", (t: number) => ({ name: "Everything", tagIds: [t] }), /at least one condition/],
    ["empty conditions", (t: number) => ({ name: "Empty", genres: [" "], libraryTypes: [], listIds: [], tagIds: [t] }), /at least one condition/],
    ["no tag", () => ({ name: "Tagless", genres: ["Horror"], tagIds: [] }), /at least one tag/],
    ["a tag that does not exist", () => ({ name: "Ghost tag", genres: ["Horror"], tagIds: [987654] }), /Tag 987654 doesn't exist/],
    ["a list that does not exist", (t: number) => ({ name: "Ghost list", listIds: [987654], tagIds: [t] }), /Import list 987654 doesn't exist/],
    ["an unknown library type", (t: number) => ({ name: "Odd type", libraryTypes: ["moovie"], tagIds: [t] }), /Unknown library type "moovie"/],
    ["no name", (t: number) => ({ genres: ["Horror"], tagIds: [t] }), /name is required/],
    ["a blank name", (t: number) => ({ name: "   ", genres: ["Horror"], tagIds: [t] }), /name is required/],
    ["a match mode that is neither any nor all", (t: number) => ({ name: "Odd match", match: "some", genres: ["Horror"], tagIds: [t] }), /match must be/],
    ["genres that are not a list", (t: number) => ({ name: "Bad genres", genres: "Horror", tagIds: [t] }), /genres must be a list/],
    ["tag ids that are not ids", (t: number) => ({ name: "Bad ids", genres: ["Horror"], tagIds: [t, "x"] }), /tagIds must be a list of ids/],
  ])("refuses %s with a 400", async (_what, body, message) => {
    const t = await tag("valid");
    const res = await createRule(body(t));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect((await authed(request(app).get("/api/auto-tag-rules"))).body).toHaveLength(0);
  });

  it("refuses a name that is taken, whatever its case, with a 409", async () => {
    const t = await tag("kids");
    expect((await createRule({ name: "Anime", genres: ["Anime"], tagIds: [t] })).status).toBe(201);
    const res = await createRule({ name: "anime", genres: ["Animation"], tagIds: [t] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

describe("permissions", () => {
  it("is for the admin only: a household account gets a 403 on every route, and no login a 401", async () => {
    const t = await tag("kids");
    const rule = (await createRule({ name: "Anime", genres: ["Anime"], tagIds: [t] })).body;
    const asUser = (r: request.Test) => r.set("X-Session-Token", userToken);
    const calls: [string, () => request.Test][] = [
      ["list", () => request(app).get("/api/auto-tag-rules")],
      ["meta", () => request(app).get("/api/auto-tag-rules/meta")],
      ["create", () => request(app).post("/api/auto-tag-rules").send({ name: "X", genres: ["X"], tagIds: [t] })],
      ["update", () => request(app).put(`/api/auto-tag-rules/${rule.id}`).send({ enabled: false })],
      ["delete", () => request(app).delete(`/api/auto-tag-rules/${rule.id}`)],
      ["preview", () => request(app).post(`/api/auto-tag-rules/${rule.id}/preview`)],
      ["apply", () => request(app).post(`/api/auto-tag-rules/${rule.id}/apply`)],
    ];
    for (const [name, call] of calls) {
      expect((await asUser(call())).status, `${name} as a household account`).toBe(403);
      expect((await call()).status, `${name} without a login`).toBe(401);
    }
    const after = (await authed(request(app).get("/api/auto-tag-rules"))).body;
    expect(after).toHaveLength(1);
    expect(after[0].enabled).toBe(true);
  });
});

describe("changing and deleting a rule", () => {
  it("updates only what is sent, and checks the result as a whole", async () => {
    const t = await tag("kids");
    const rule = (await createRule({ name: "Anime", genres: ["Anime"], tagIds: [t] })).body;

    const off = await authed(request(app).put(`/api/auto-tag-rules/${rule.id}`)).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, genres: ["Anime"], tagIds: [t] });

    const renamed = await authed(request(app).put(`/api/auto-tag-rules/${rule.id}`)).send({ name: "Anime and animation", genres: ["Anime", "Animation"], match: "all", removeWhenUnmatched: true });
    expect(renamed.body).toMatchObject({ name: "Anime and animation", genres: ["Anime", "Animation"], match: "all", removeWhenUnmatched: true, enabled: false });

    // Dropping the only condition would leave a rule that tags everything.
    const bare = await authed(request(app).put(`/api/auto-tag-rules/${rule.id}`)).send({ genres: [] });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/at least one condition/);
    expect((await authed(request(app).get("/api/auto-tag-rules"))).body[0].genres).toEqual(["Anime", "Animation"]);

    expect((await authed(request(app).put("/api/auto-tag-rules/999999")).send({ enabled: true })).status).toBe(404);
    expect((await auditEvents("auto_tag_rule_updated")).sort()).toEqual(["Anime", "Anime and animation"]);
  });

  it("a rename onto another rule's name is a 409", async () => {
    const t = await tag("kids");
    expect((await createRule({ name: "First", genres: ["A"], tagIds: [t] })).status).toBe(201);
    const second = (await createRule({ name: "Second", genres: ["B"], tagIds: [t] })).body;
    expect((await authed(request(app).put(`/api/auto-tag-rules/${second.id}`)).send({ name: "FIRST" })).status).toBe(409);
    expect((await authed(request(app).put(`/api/auto-tag-rules/${second.id}`)).send({ name: "Second" })).status).toBe(200);
  });

  it("deletes, leaves the tags that titles got as plain tags, and answers 404 the second time", async () => {
    const t = await tag("kept");
    const rule = (await createRule({ name: "Horror", genres: ["Horror"], tagIds: [t], removeWhenUnmatched: true })).body;
    const m = await movie("Scary", ["Horror"]);
    await authed(request(app).post(`/api/auto-tag-rules/${rule.id}/apply`)).expect(200);
    await waitFor(async () => ((await authed(request(app).get("/api/auto-tag-rules"))).body[0].lastApply?.finishedAt ?? null) !== null, "the apply");
    await waitFor(() => !isJobBusy("autoTag"), "the job to end");
    expect(await db.prepare("SELECT 1 AS ok FROM media_item_tags WHERE media_item_id = ? AND tag_id = ?").get(m, t)).toBeTruthy();

    await authed(request(app).delete(`/api/auto-tag-rules/${rule.id}`)).expect(204);

    expect(await db.prepare("SELECT 1 AS ok FROM media_item_tags WHERE media_item_id = ? AND tag_id = ?").get(m, t)).toBeTruthy();
    expect(await db.prepare("SELECT 1 AS ok FROM media_item_auto_tags WHERE media_item_id = ?").get(m)).toBeFalsy();
    expect((await authed(request(app).delete(`/api/auto-tag-rules/${rule.id}`))).status).toBe(404);
    expect(await auditEvents("auto_tag_rule_removed")).toEqual(["Horror"]);
  });

  it("a deleted import list leaves the rule alone: its id never matches, and the rule can still be switched off", async () => {
    const t = await tag("listed");
    const l = await list();
    const rule = (await createRule({ name: "From list", listIds: [l], tagIds: [t] })).body;
    await db.prepare("DELETE FROM import_lists WHERE id = ?").run(l);

    expect((await authed(request(app).put(`/api/auto-tag-rules/${rule.id}`)).send({ enabled: false })).status).toBe(200);
    // But a request that names the missing list is refused.
    const res = await authed(request(app).put(`/api/auto-tag-rules/${rule.id}`)).send({ listIds: [l] });
    expect(res.status).toBe(400);
  });
});

describe("tags in use by a rule", () => {
  it("cannot be deleted while a rule gives them, and can once the rule is gone", async () => {
    const t = await tag("in-use");
    const rule = (await createRule({ name: "Uses it", genres: ["Horror"], tagIds: [t] })).body;

    const res = await authed(request(app).delete(`/api/tags/${t}`));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/auto tagging rule\(s\) "Uses it"/);
    expect(res.body.usage.autoTagRules).toEqual([{ id: rule.id, name: "Uses it" }]);
    expect(await db.prepare("SELECT 1 AS ok FROM tags WHERE id = ?").get(t)).toBeTruthy();

    await authed(request(app).delete(`/api/auto-tag-rules/${rule.id}`)).expect(204);
    await authed(request(app).delete(`/api/tags/${t}`)).expect(204);
  });
});

describe("previewing and applying", () => {
  it("a preview answers with counts and examples and writes nothing", async () => {
    const t = await tag("seen");
    const rule = (await createRule({ name: "Horror", genres: ["Horror"], tagIds: [t] })).body;
    await movie("Scary One", ["Horror"]);
    await movie("Scary Two", ["horror"]);
    await movie("Funny", ["Comedy"]);

    const res = await authed(request(app).post(`/api/auto-tag-rules/${rule.id}/preview`));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 3, matching: 2, itemsGaining: 2, itemsLosing: 0, tagsAdded: 2, tagsRemoved: 0 });
    expect(res.body.samples.map((s: any) => s.title).sort()).toEqual(["Scary One", "Scary Two"]);
    expect(res.body.samples[0].adds).toEqual(["seen"]);
    expect(((await db.prepare("SELECT COUNT(*) AS c FROM media_item_tags").get()) as { c: number }).c).toBe(0);
    expect((await authed(request(app).post("/api/auto-tag-rules/999999/preview"))).status).toBe(404);
  });

  it("Apply refuses a switched-off rule and writes nothing", async () => {
    const t = await tag("idle");
    const rule = (await createRule({ name: "Off", enabled: false, genres: ["Horror"], tagIds: [t] })).body;
    await movie("Scary", ["Horror"]);

    const res = await authed(request(app).post(`/api/auto-tag-rules/${rule.id}/apply`));

    expect(res.status).toBe(409);
    expect(((await db.prepare("SELECT COUNT(*) AS c FROM media_item_tags").get()) as { c: number }).c).toBe(0);
  });

  it("Apply starts a background run and the rule then reports its counts", async () => {
    const t = await tag("applied");
    const rule = (await createRule({ name: "Horror", genres: ["Horror"], tagIds: [t] })).body;
    await movie("Scary One", ["Horror"]);
    await movie("Funny", ["Comedy"]);

    const res = await authed(request(app).post(`/api/auto-tag-rules/${rule.id}/apply`));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ started: true });
    await waitFor(async () => ((await authed(request(app).get("/api/auto-tag-rules"))).body[0].lastApply?.finishedAt ?? null) !== null, "the apply to finish");
    const [shown] = (await authed(request(app).get("/api/auto-tag-rules"))).body;
    expect(shown.lastApply).toMatchObject({ scanned: 2, matching: 1, itemsGaining: 1, tagsAdded: 1, tagsRemoved: 0, cancelled: false, error: null });
    await waitFor(() => !isJobBusy("autoTag"), "the job to end");
    expect(await auditEvents("auto_tag_rule_applied")).toEqual(["Horror"]);
  });
});

describe("what the form needs", () => {
  it("lists the library types, the genres in the library (once each) and the import lists", async () => {
    await movie("A", ["Horror", "Comedy"]);
    await movie("B", ["horror", "Drama"]);
    const l = await list("My list");

    const res = await authed(request(app).get("/api/auto-tag-rules/meta"));

    expect(res.status).toBe(200);
    expect(res.body.libraryTypes).toEqual(expect.arrayContaining([{ key: "movie", label: expect.any(String) }, { key: "series", label: expect.any(String) }]));
    expect(res.body.genres).toEqual(["Comedy", "Drama", "Horror"]);
    expect(res.body.lists).toEqual([{ id: l, name: "My list", type: "trakt" }]);
  });
});

describe("the tables on an install that predates them", () => {
  it("the schema creates both, keeps working when it runs again, and a rule can be written afterwards", async () => {
    const t = await tag("upgrade");
    await db.exec("DROP TABLE media_item_auto_tags");
    await db.exec("DROP TABLE auto_tag_rules");
    const file = db.dialect === "postgres" ? "schema.postgres.sql" : "schema.sql";
    const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db", file), "utf-8");

    await db.exec(sql);
    await db.exec(sql);

    invalidateAutoTagRules();
    expect((await createRule({ name: "After upgrade", genres: ["Horror"], tagIds: [t] })).status).toBe(201);
    // The claims table takes a row without an id column (Postgres must not be asked to RETURNING one).
    const rule = (await authed(request(app).get("/api/auto-tag-rules"))).body[0];
    const m = await movie("Scary", ["Horror"]);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(m, t);
    await db.prepare("INSERT INTO media_item_auto_tags (media_item_id, tag_id, rule_id) VALUES (?, ?, ?)").run(m, t, rule.id);
    expect(await db.prepare("SELECT 1 AS ok FROM media_item_auto_tags WHERE media_item_id = ?").get(m)).toBeTruthy();
  });
});
