import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

describe("DELETE /api/qualities/:id", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("deletes a quality tier not referenced by any profile's cutoff", async () => {
    const inserted = await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, 999)").run("Test-Only-Quality");
    const id = Number(inserted.lastInsertRowid);

    const res = await request(app).delete(`/api/qualities/${id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(await db.prepare("SELECT id FROM qualities WHERE id = ?").get(id)).toBeUndefined();
  });

  it("404s for an id that doesn't exist", async () => {
    const res = await request(app).delete("/api/qualities/999999").set("X-Api-Key", apiKey);
    expect(res.status).toBe(404);
  });

  it("refuses to delete the last remaining quality", async () => {
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("DELETE FROM qualities").run();
    const inserted = await db.prepare("INSERT INTO qualities (name, rank) VALUES (?, 0)").run("Only-Quality-Left");
    const id = Number(inserted.lastInsertRowid);

    const res = await request(app).delete(`/api/qualities/${id}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(400);
    expect(await db.prepare("SELECT id FROM qualities WHERE id = ?").get(id)).toBeTruthy();
  });

  it("drops the deleted quality from every profile's allowed list (falling back to the nearest lower tier if that empties it), and moves a cutoff that was the deleted quality DOWN", async () => {
    await db.prepare("DELETE FROM quality_profiles").run();
    await db.prepare("DELETE FROM qualities").run();
    await db.prepare("INSERT INTO qualities (name, rank) VALUES ('Low', 0)").run();
    const mid = Number((await db.prepare("INSERT INTO qualities (name, rank) VALUES ('Mid', 1)").run()).lastInsertRowid);
    await db.prepare("INSERT INTO qualities (name, rank) VALUES ('High', 2)").run();

    const profile = Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
          .run("Cutoff-At-Mid", JSON.stringify(["Low", "Mid", "High"]), "Mid")
      ).lastInsertRowid
    );
    const soleAllowedProfile = Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
          .run("Only-Allows-Mid", JSON.stringify(["Mid"]), "Mid")
      ).lastInsertRowid
    );

    const res = await request(app).delete(`/api/qualities/${mid}`).set("X-Api-Key", apiKey);
    expect(res.status).toBe(204);

    const updated = (await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(profile)) as any;
    expect(JSON.parse(updated.allowed_qualities)).toEqual(["Low", "High"]);
    // Moved DOWN to the best allowed tier below the deleted one — never up to "High", which would
    // turn every file at the old cutoff into an upgrade target.
    expect(updated.cutoff).toBe("Low");

    const soleUpdated = (await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(soleAllowedProfile)) as any;
    // Emptied, so replaced by the nearest tier — lower first.
    expect(JSON.parse(soleUpdated.allowed_qualities)).toEqual(["Low"]);
    expect(soleUpdated.cutoff).toBe("Low");
  });
});
