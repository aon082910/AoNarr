import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let invalidateAutoTagRules: (typeof import("../src/services/autoTag.js"))["invalidateAutoTagRules"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  ({ invalidateAutoTagRules } = await import("../src/services/autoTag.js"));
});

beforeEach(async () => {
  for (const t of ["media_item_auto_tags", "auto_tag_rules", "media_item_tags", "media_items", "delay_profiles", "release_profiles", "tags", "import_lists"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  invalidateAutoTagRules();
});

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);

async function tag(name: string): Promise<number> {
  return (await authed(request(app).post("/api/tags")).send({ name })).body.id;
}

async function list(name: string): Promise<number> {
  return Number((await db.prepare("INSERT INTO import_lists (name, type, url) VALUES (?, 'trakt', 'u')").run(name)).lastInsertRowid);
}

const rules = async () => (await authed(request(app).get("/api/auto-tag-rules"))).body as any[];
const exported = async () => (await authed(request(app).get("/api/settings/template/export"))).body;
const importing = (body: unknown) => authed(request(app).post("/api/settings/template/import")).send(body as object);

describe("the settings template carries auto tagging rules", () => {
  it("exports them with their tags and lists by name, never by id", async () => {
    const kids = await tag("tpl-kids");
    const scary = await tag("tpl-scary");
    const l = await list("Family picks");
    await authed(request(app).post("/api/auto-tag-rules")).send({
      name: "Family",
      match: "all",
      libraryTypes: ["movie"],
      genres: ["Family", "Animation"],
      listIds: [l],
      tagIds: [kids, scary],
      removeWhenUnmatched: true,
    });
    await authed(request(app).post("/api/auto-tag-rules")).send({ name: "Dormant", enabled: false, genres: ["Horror"], tagIds: [scary] });

    const body = await exported();

    expect(body.autoTagRules).toEqual(
      expect.arrayContaining([
        {
          name: "Family",
          enabled: true,
          match: "all",
          libraryTypes: ["movie"],
          genres: ["Family", "Animation"],
          listNames: ["Family picks"],
          tagNames: ["tpl-kids", "tpl-scary"],
          removeWhenUnmatched: true,
        },
        expect.objectContaining({ name: "Dormant", enabled: false, tagNames: ["tpl-scary"], listNames: [] }),
      ])
    );
    expect(JSON.stringify(body.autoTagRules)).not.toMatch(/"(tagIds|listIds|id)"/);
  });

  it("imports into an empty instance: the tags are created and the list is found by its name", async () => {
    const kids = await tag("tpl-kids");
    const l = await list("Family picks");
    await authed(request(app).post("/api/auto-tag-rules")).send({ name: "Family", match: "all", libraryTypes: ["movie"], listIds: [l], genres: ["Family"], tagIds: [kids], removeWhenUnmatched: true });
    const template = await exported();

    await db.prepare("DELETE FROM auto_tag_rules").run();
    await db.prepare("DELETE FROM tags").run();
    await db.prepare("DELETE FROM import_lists").run();
    invalidateAutoTagRules();
    const newList = await list("Family picks");

    const res = await importing(template);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoTagRulesImported: 1, autoTagRuleNotes: [] });
    const [rule] = await rules();
    const newTag = (await db.prepare("SELECT id FROM tags WHERE name = 'tpl-kids'").get()) as { id: number };
    expect(rule).toMatchObject({ name: "Family", match: "all", libraryTypes: ["movie"], genres: ["Family"], listIds: [newList], tagIds: [Number(newTag.id)], removeWhenUnmatched: true, enabled: true });
  });

  it("importing the same template twice updates the rule in place", async () => {
    const t = await tag("tpl-once");
    await authed(request(app).post("/api/auto-tag-rules")).send({ name: "Once", genres: ["Horror"], tagIds: [t] });
    const template = await exported();

    await importing(template).expect(200);
    template.autoTagRules[0].genres = ["Horror", "Thriller"];
    await importing(template).expect(200);

    const all = await rules();
    expect(all).toHaveLength(1);
    expect(all[0].genres).toEqual(["Horror", "Thriller"]);
  });

  it("a template from before this existed still imports", async () => {
    const template = await exported();
    delete template.autoTagRules;
    const res = await importing(template);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoTagRulesImported: 0, autoTagRuleNotes: [] });
  });

  it("skips, with a note, a rule whose list this install does not have, so it never gets broader", async () => {
    const res = await importing({
      autoTagRules: [{ name: "Needs a list", match: "all", libraryTypes: ["movie"], listNames: ["No such list"], tagNames: ["tpl-x"] }],
    });

    expect(res.status).toBe(200);
    expect(res.body.autoTagRulesImported).toBe(0);
    expect(res.body.autoTagRuleNotes).toEqual([expect.stringMatching(/"Needs a list" skipped.*"No such list"/)]);
    expect(await rules()).toHaveLength(0);
  });

  it("keeps the library types and lists it can resolve and leaves out the rest", async () => {
    const l = await list("Known");
    const res = await importing({
      autoTagRules: [{ name: "Partly known", libraryTypes: ["movie", "no-such-type"], listNames: ["Known", "Unknown"], genres: [" Horror ", ""], tagNames: ["tpl-y"] }],
    });

    expect(res.body.autoTagRulesImported).toBe(1);
    const [rule] = await rules();
    expect(rule).toMatchObject({ libraryTypes: ["movie"], listIds: [l], genres: ["Horror"] });
  });

  it("skips a rule whose only library type is unknown here", async () => {
    const res = await importing({ autoTagRules: [{ name: "Odd", libraryTypes: ["no-such-type"], genres: ["Horror"], tagNames: ["tpl-z"] }] });
    expect(res.body.autoTagRulesImported).toBe(0);
    expect(res.body.autoTagRuleNotes[0]).toMatch(/"Odd" skipped.*library types/);
  });

  it("skips a rule that names no tag or no condition, and entries that are not rules", async () => {
    const res = await importing({
      autoTagRules: [
        { name: "No tag", genres: ["Horror"], tagNames: [] },
        { name: "No condition", tagNames: ["tpl-w"] },
        "nonsense",
        { genres: ["Horror"], tagNames: ["tpl-w"] },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.autoTagRulesImported).toBe(0);
    expect(res.body.autoTagRuleNotes).toEqual([expect.stringMatching(/"No tag" skipped: it names no tag/), expect.stringMatching(/"No condition" skipped.*at least one condition/)]);
    expect(await rules()).toHaveLength(0);
  });
});
