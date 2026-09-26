import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let mediaItemId: number;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  mediaItemId = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Client Movie', 'client movie')").run()).lastInsertRowid
  );
});

async function insertClient(name: string): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO download_clients (name, type, host, port, use_ssl, enabled, audio_only) VALUES (?, 'sabnzbd', 'sab.local', 8080, 0, 1, 0)")
        .run(name)
    ).lastInsertRowid
  );
}

async function insertQueueRow(clientId: number, title: string, status: string): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO queue (media_item_id, title, status, download_client_id, download_id) VALUES (?, ?, ?, ?, ?)")
        .run(mediaItemId, title, status, clientId, `nzo_${title}`)
    ).lastInsertRowid
  );
}

async function statusOf(queueId: number): Promise<string> {
  return ((await db.prepare("SELECT status FROM queue WHERE id = ?").get(queueId)) as { status: string }).status;
}

describe("DELETE /api/download-clients/:id", () => {
  it("fails the deleted client's in-flight queue rows so their targets can be searched again, without blocklisting", async () => {
    const doomed = await insertClient("Doomed SAB");
    const kept = await insertClient("Kept SAB");
    const queued = await insertQueueRow(doomed, "Doomed.Queued", "queued");
    const downloading = await insertQueueRow(doomed, "Doomed.Downloading", "downloading");
    const completed = await insertQueueRow(doomed, "Doomed.Completed", "completed");
    const otherClients = await insertQueueRow(kept, "Kept.Downloading", "downloading");

    const res = await request(app).delete(`/api/download-clients/${doomed}`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(204);
    expect(await db.prepare("SELECT id FROM download_clients WHERE id = ?").get(doomed)).toBeUndefined();
    expect(await statusOf(queued)).toBe("failed");
    expect(await statusOf(downloading)).toBe("failed");
    // A completed row may still be waiting for a manual import; its files don't depend on the client.
    expect(await statusOf(completed)).toBe("completed");
    expect(await statusOf(otherClients)).toBe("downloading");
    const blocklisted = (await db.prepare("SELECT COUNT(*) AS c FROM blocklist WHERE media_item_id = ?").get(mediaItemId)) as { c: number | string };
    expect(Number(blocklisted.c)).toBe(0);
  });

  it("404s an unknown client without touching the queue", async () => {
    const client = await insertClient("Untouched SAB");
    const row = await insertQueueRow(client, "Untouched.Queued", "queued");

    const res = await request(app).delete("/api/download-clients/999999").set("X-Api-Key", apiKey);

    expect(res.status).toBe(404);
    expect(await statusOf(row)).toBe("queued");
  });
});
