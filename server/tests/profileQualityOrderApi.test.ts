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

const authed = (r: request.Test) => r.set("X-Api-Key", apiKey);
const post = (body: unknown) => authed(request(app).post("/api/quality-profiles")).send(body);
const patch = (id: number, body: unknown) => authed(request(app).patch(`/api/quality-profiles/${id}`)).send(body);
const list = async () => (await authed(request(app).get("/api/quality-profiles"))).body as any[];
const stored = async (id: number) => ((await db.prepare("SELECT quality_order FROM quality_profiles WHERE id = ?").get(id)) as { quality_order: string | null }).quality_order;

const base = { name: "", allowedQualities: ["WEBDL-1080p", "Bluray-1080p", "Remux-1080p"], cutoff: "WEBDL-1080p" };

describe("qualityOrder on the quality profile API", () => {
  it("stores a valid order and returns it, and a profile without one has none", async () => {
    const created = await post({ ...base, name: "order-a", qualityOrder: ["Bluray-1080p", "Remux-1080p", "WEBDL-1080p"] });
    expect(created.status).toBe(201);
    expect(created.body.qualityOrder).toEqual(["Bluray-1080p", "Remux-1080p", "WEBDL-1080p"]);
    expect(JSON.parse((await stored(created.body.id))!)).toEqual(["Bluray-1080p", "Remux-1080p", "WEBDL-1080p"]);

    const plain = await post({ ...base, name: "order-none" });
    expect(plain.status).toBe(201);
    expect(plain.body.qualityOrder).toBeNull();
    expect(await stored(plain.body.id)).toBeNull();
    expect((await list()).find((p) => p.id === created.body.id).qualityOrder).toEqual(["Bluray-1080p", "Remux-1080p", "WEBDL-1080p"]);
  });

  it("takes an empty list or null as the default order", async () => {
    const created = await post({ ...base, name: "order-reset", qualityOrder: ["Bluray-1080p", "WEBDL-1080p"] });
    const id = created.body.id;
    expect((await patch(id, { qualityOrder: [] })).body.qualityOrder).toBeNull();
    expect(await stored(id)).toBeNull();
    await patch(id, { qualityOrder: ["Bluray-1080p", "WEBDL-1080p"] });
    expect((await patch(id, { qualityOrder: null })).body.qualityOrder).toBeNull();
    expect(await stored(id)).toBeNull();
    expect((await post({ ...base, name: "order-empty-list", qualityOrder: [] })).body.qualityOrder).toBeNull();
  });

  it("leaves the order alone when a request does not mention it", async () => {
    const created = await post({ ...base, name: "order-keep", qualityOrder: ["Bluray-1080p", "WEBDL-1080p"] });
    const patched = await patch(created.body.id, { minFormatScore: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body.qualityOrder).toEqual(["Bluray-1080p", "WEBDL-1080p"]);
  });

  it("refuses a name that is not on the ladder, a repeated name, and a bad shape", async () => {
    const unknown = await post({ ...base, name: "bad-1", qualityOrder: ["WEBDL-1080p", "Ghost-1080p"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("Ghost-1080p");
    const repeated = await post({ ...base, name: "bad-2", qualityOrder: ["WEBDL-1080p", "Bluray-1080p", "WEBDL-1080p"] });
    expect(repeated.status).toBe(400);
    expect(repeated.body.error).toContain("WEBDL-1080p");
    expect((await post({ ...base, name: "bad-3", qualityOrder: "WEBDL-1080p" })).status).toBe(400);
    expect((await post({ ...base, name: "bad-4", qualityOrder: [1, 2] })).status).toBe(400);
    expect((await post({ ...base, name: "bad-5", qualityOrder: ["WEBDL-1080p", ""] })).status).toBe(400);
    const created = await post({ ...base, name: "order-bad-patch" });
    expect((await patch(created.body.id, { qualityOrder: ["Ghost-1080p"] })).status).toBe(400);
    expect((await patch(created.body.id, { qualityOrder: {} })).status).toBe(400);
    // Nothing was stored by the refusals.
    expect(await stored(created.body.id)).toBeNull();
    expect((await list()).some((p) => /^bad-/.test(p.name))).toBe(false);
  });

  it("accepts the new tiers of the ladder in an order", async () => {
    const res = await post({ ...base, name: "order-new-tiers", allowedQualities: ["CAM", "SDTV", "Raw-HD"], cutoff: "SDTV", qualityOrder: ["SDTV", "CAM", "Raw-HD"] });
    expect(res.status).toBe(201);
    expect(res.body.qualityOrder).toEqual(["SDTV", "CAM", "Raw-HD"]);
  });

  it("puts a quality that becomes allowed into the order, by its place on the ladder, when the order was not sent", async () => {
    const created = await post({ ...base, name: "order-grow", allowedQualities: ["WEBDL-1080p", "Remux-1080p"], cutoff: "WEBDL-1080p", qualityOrder: ["Remux-1080p", "WEBDL-1080p"] });
    const id = created.body.id;

    // Bluray-1080p ranks between the two on the ladder; the order puts the first listed quality above it in front of it.
    const grown = await patch(id, { allowedQualities: ["WEBDL-1080p", "Bluray-1080p", "Remux-1080p"] });
    expect(grown.status).toBe(200);
    expect(grown.body.qualityOrder).toEqual(["Bluray-1080p", "Remux-1080p", "WEBDL-1080p"]);
    // A profile with no order of its own gets none by being edited.
    const plain = await post({ ...base, name: "order-grow-none", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p" });
    expect((await patch(plain.body.id, { allowedQualities: ["WEBDL-1080p", "Bluray-1080p"] })).body.qualityOrder).toBeNull();
    // And an order sent with the new list is the order that is stored.
    const sent = await patch(id, { allowedQualities: ["WEBDL-1080p", "Bluray-1080p"], qualityOrder: ["WEBDL-1080p", "Bluray-1080p"] });
    expect(sent.body.qualityOrder).toEqual(["WEBDL-1080p", "Bluray-1080p"]);
  });
});

describe("a deleted quality leaves the profiles' orders", () => {
  it("drops the tier from every order, and an order left empty is the default again", async () => {
    await db.prepare("INSERT INTO qualities (name, rank) VALUES ('Order-Temp-A', (SELECT MAX(rank) + 1 FROM qualities))").run();
    await db.prepare("INSERT INTO qualities (name, rank) VALUES ('Order-Temp-B', (SELECT MAX(rank) + 1 FROM qualities))").run();
    const { loadQualityCaches } = await import("../src/services/quality.js");
    await loadQualityCaches();
    const both = await post({ ...base, name: "del-both", allowedQualities: ["WEBDL-1080p", "Order-Temp-A"], cutoff: "WEBDL-1080p", qualityOrder: ["Order-Temp-A", "WEBDL-1080p"] });
    // The tier is only in the order, not allowed: the order still loses it.
    const onlyOrdered = await post({ ...base, name: "del-only-order", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p", qualityOrder: ["WEBDL-1080p", "Order-Temp-B"] });
    const alone = await post({ ...base, name: "del-alone", allowedQualities: ["Order-Temp-B", "WEBDL-1080p"], cutoff: "WEBDL-1080p", qualityOrder: ["Order-Temp-B"] });
    const idOf = async (name: string) => ((await db.prepare("SELECT id FROM qualities WHERE name = ?").get(name)) as { id: number }).id;

    expect((await authed(request(app).delete(`/api/qualities/${await idOf("Order-Temp-A")}`))).status).toBe(204);
    expect((await authed(request(app).delete(`/api/qualities/${await idOf("Order-Temp-B")}`))).status).toBe(204);

    const profiles = await list();
    expect(profiles.find((p) => p.id === both.body.id).qualityOrder).toEqual(["WEBDL-1080p"]);
    expect(profiles.find((p) => p.id === onlyOrdered.body.id).qualityOrder).toEqual(["WEBDL-1080p"]);
    expect(profiles.find((p) => p.id === alone.body.id).qualityOrder).toBeNull();
    await loadQualityCaches();
  });
});

describe("the settings template carries a profile's order", () => {
  it("exports it, and imports it back, whole or reset", async () => {
    const two = { ...base, allowedQualities: ["WEBDL-1080p", "Bluray-1080p"] };
    const created = await post({ ...two, name: "tpl-ordered", qualityOrder: ["Bluray-1080p", "WEBDL-1080p"] });
    const plain = await post({ ...two, name: "tpl-unordered" });
    expect(created.status).toBe(201);
    expect(plain.status).toBe(201);

    const exported = (await authed(request(app).get("/api/settings/template/export"))).body;
    expect(exported.qualityProfiles.find((p: any) => p.name === "tpl-ordered").qualityOrder).toEqual(["Bluray-1080p", "WEBDL-1080p"]);
    expect(exported.qualityProfiles.find((p: any) => p.name === "tpl-unordered").qualityOrder).toBeNull();

    // Round trip into an instance that no longer has the profiles.
    await db.prepare("DELETE FROM quality_profiles WHERE name IN ('tpl-ordered', 'tpl-unordered')").run();
    const imported = await authed(request(app).post("/api/settings/template/import")).send(exported);
    expect(imported.status).toBe(200);
    const after = await list();
    expect(after.find((p) => p.name === "tpl-ordered").qualityOrder).toEqual(["Bluray-1080p", "WEBDL-1080p"]);
    expect(after.find((p) => p.name === "tpl-unordered").qualityOrder).toBeNull();

    // A template that says null resets an order; one from before profiles had an order (no key at all) leaves it alone.
    const reset = { ...exported, qualityProfiles: exported.qualityProfiles.map((p: any) => (p.name === "tpl-ordered" ? { ...p, qualityOrder: null } : p)) };
    await authed(request(app).post("/api/settings/template/import")).send(reset);
    expect((await list()).find((p) => p.name === "tpl-ordered").qualityOrder).toBeNull();

    // (The import made the profile again, with a new id.)
    const ordered = (await list()).find((p) => p.name === "tpl-ordered");
    expect((await patch(ordered.id, { qualityOrder: ["WEBDL-1080p", "Bluray-1080p"] })).status).toBe(200);
    const old = {
      ...exported,
      qualityProfiles: exported.qualityProfiles.map((p: any) => {
        const { qualityOrder: _dropped, ...withoutOrder } = p;
        return withoutOrder;
      }),
    };
    expect((await authed(request(app).post("/api/settings/template/import")).send(old)).status).toBe(200);
    expect((await list()).find((p) => p.name === "tpl-ordered").qualityOrder).toEqual(["WEBDL-1080p", "Bluray-1080p"]);

    // ...and an old backup that allows one more quality than the order lists puts it in, by its place on the ladder.
    const grown = { ...old, qualityProfiles: old.qualityProfiles.map((p: any) => (p.name === "tpl-ordered" ? { ...p, allowedQualities: [...p.allowedQualities, "HDTV-1080p"] } : p)) };
    expect((await authed(request(app).post("/api/settings/template/import")).send(grown)).status).toBe(200);
    expect((await list()).find((p) => p.name === "tpl-ordered").qualityOrder).toEqual(["HDTV-1080p", "WEBDL-1080p", "Bluray-1080p"]);
  });
});

describe("the Starr API lists a profile's qualities in its order", () => {
  it("puts the qualities a profile lists last, in its order", async () => {
    const created = await post({ ...base, name: "starr-ordered", qualityOrder: ["Bluray-1080p", "WEBDL-1080p"] });
    const res = await authed(request(app).get(`/radarr/api/v3/qualityprofile/${created.body.id}`));
    expect(res.status).toBe(200);
    const names: string[] = res.body.items.map((i: any) => i.quality.name);
    expect(names.slice(-2)).toEqual(["Bluray-1080p", "WEBDL-1080p"]);
    expect(names).toContain("Raw-HD");
    expect(new Set(names).size).toBe(names.length);
    const cam = res.body.items.find((i: any) => i.quality.name === "CAM");
    expect(cam.quality).toMatchObject({ name: "CAM", source: "cam" });
  });
});
