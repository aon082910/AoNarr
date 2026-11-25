import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";
import { SECRET_MASK } from "../src/db/mappers.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

const auth = (r: request.Test) => r.set("X-Api-Key", apiKey);
const storedSecret = async (table: "download_clients" | "indexers", column: string, id: number) =>
  ((await db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(id)) as { v: string | null }).v;

describe("download client secrets never leave the server", () => {
  it("masks the key and hides the password in every response, and a masked save changes nothing", async () => {
    const created = await auth(request(app).post("/api/download-clients")).send({
      name: "Secret SAB", type: "sabnzbd", host: "sab.local", port: 8080, username: "u", password: "hunter2-password", apiKey: "sab-api-key-123",
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toMatch(/hunter2-password|sab-api-key-123/);
    expect(created.body.password).toBeNull();
    expect(created.body.passwordSet).toBe(true);
    expect(created.body.apiKey).toBe(SECRET_MASK);
    expect(created.body.apiKeySet).toBe(true);
    const id = created.body.id as number;
    const before = await storedSecret("download_clients", "api_key", id);
    const beforePw = await storedSecret("download_clients", "password", id);
    expect(before).toBeTruthy();

    const list = await auth(request(app).get("/api/download-clients"));
    expect(JSON.stringify(list.body)).not.toMatch(/hunter2-password|sab-api-key-123/);

    // the form sends back what it was shown: the mask means "unchanged"
    const patched = await auth(request(app).patch(`/api/download-clients/${id}`)).send({ name: "Renamed SAB", apiKey: SECRET_MASK });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Renamed SAB");
    expect(JSON.stringify(patched.body)).not.toMatch(/hunter2-password|sab-api-key-123/);
    expect(await storedSecret("download_clients", "api_key", id)).toBe(before);
    expect(await storedSecret("download_clients", "password", id)).toBe(beforePw);

    // a real new key still replaces the old one
    await auth(request(app).patch(`/api/download-clients/${id}`)).send({ apiKey: "a-new-key" });
    expect(await storedSecret("download_clients", "api_key", id)).not.toBe(before);
  });
});

describe("indexer API keys never leave the server", () => {
  it("masks the key everywhere and keeps it when the mask is saved back", async () => {
    const created = await auth(request(app).post("/api/indexers")).send({ name: "Secret Idx", protocol: "torznab", url: "https://idx.example.com", apiKey: "indexer-secret-key" });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("indexer-secret-key");
    expect(created.body.apiKey).toBe(SECRET_MASK);
    expect(created.body.apiKeySet).toBe(true);
    const id = created.body.id as number;
    const before = await storedSecret("indexers", "api_key", id);

    const list = await auth(request(app).get("/api/indexers"));
    expect(JSON.stringify(list.body)).not.toContain("indexer-secret-key");

    const patched = await auth(request(app).patch(`/api/indexers/${id}`)).send({ priority: 5, apiKey: SECRET_MASK });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.body)).not.toContain("indexer-secret-key");
    expect(await storedSecret("indexers", "api_key", id)).toBe(before);

    // no key at all: shown as not set
    const bare = await auth(request(app).post("/api/indexers")).send({ name: "No key", protocol: "torznab", url: "https://idx2.example.com" });
    expect(bare.body.apiKey).toBeNull();
    expect(bare.body.apiKeySet).toBe(false);
  });
});
