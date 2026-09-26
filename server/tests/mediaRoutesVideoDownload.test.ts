import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const addDownload = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/downloadClient.js")>()),
  getDownloadClientAdapter: () => ({ addDownload: (...args: unknown[]) => addDownload(...args), getStatus: async () => [] }),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

describe("POST /api/media/subitems/:subItemId/download", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  it("hands the yt-dlp adapter the mapped client, so its audio-only setting is honoured", async () => {
    await db
      .prepare(`INSERT INTO download_clients (name, type, category, enabled, audio_only) VALUES ('yt-dlp', 'ytdlp', 'videos', 1, 1)`)
      .run();
    const channelId = Number(
      (
        await db
          .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('video', 'Some Channel', 'some channel', 1, 0, 'continuing')`)
          .run()
      ).lastInsertRowid
    );
    const subId = Number(
      (
        await db
          .prepare(`INSERT INTO sub_items (media_item_id, title, external_id, external_provider, monitored) VALUES (?, 'Live Set', 'abc123', 'youtube', 1)`)
          .run(channelId)
      ).lastInsertRowid
    );
    addDownload.mockResolvedValue({ downloadId: "job-1" });

    const res = await request(app).post(`/api/media/subitems/${subId}/download`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(201);
    const [client, url, category, title] = addDownload.mock.calls[0];
    expect(Number(client.audioOnly)).toBe(1);
    expect(url).toBe("https://www.youtube.com/watch?v=abc123");
    expect(category).toBe("videos");
    expect(title).toBe("Live Set");
    const queue = (await db.prepare("SELECT media_item_id, sub_item_id, download_id FROM queue WHERE id = ?").get(res.body.id)) as any;
    expect(queue).toMatchObject({ media_item_id: channelId, sub_item_id: subId, download_id: "job-1" });
  });
});

describe("Online Videos file extensions", () => {
  it("covers what yt-dlp writes: .webm single-stream downloads and audio-only .mp3", async () => {
    const { getMediaTypeConfig, isProbeableFile } = await import("../src/services/mediaTypes.js");
    const extensions = getMediaTypeConfig("video").extensions;
    expect(extensions).toEqual(expect.arrayContaining([".mkv", ".mp4", ".webm", ".mp3"]));
    expect(isProbeableFile("/downloads/My Video.webm")).toBe(true);
  });
});
