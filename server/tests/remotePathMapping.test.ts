import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let applyRemotePathMapping: typeof import("../src/services/downloadClient.js")["applyRemotePathMapping"];
let clientId: number;

describe("applyRemotePathMapping", () => {
  beforeAll(async () => {
    ({ db } = await setupTestDb());
    ({ applyRemotePathMapping } = await import("../src/services/downloadClient.js"));

    const result = await db
      .prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('qbit', 'qbittorrent', 'localhost', 8080, 1)")
      .run();
    clientId = Number(result.lastInsertRowid);
  });

  it("returns the path unchanged when no mapping is configured for that client", async () => {
    const result = await applyRemotePathMapping(clientId, "C:\\Downloads\\Movie.2024.mkv");
    expect(result).toBe("C:\\Downloads\\Movie.2024.mkv");
  });

  it("rewrites a matching remote prefix to the configured local path", async () => {
    await db
      .prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, ?, ?)")
      .run(clientId, "C:\\Downloads", "/downloads");

    const result = await applyRemotePathMapping(clientId, "C:\\Downloads\\Movie.2024\\Movie.2024.mkv");
    expect(result).toBe("/downloads/Movie.2024/Movie.2024.mkv");
  });

  it("matches case-insensitively and tolerates mixed slash styles", async () => {
    const result = await applyRemotePathMapping(clientId, "c:/downloads/Show/S01E01.mkv");
    expect(result).toBe("/downloads/Show/S01E01.mkv");
  });

  it("returns the local path exactly when the remote path is an exact match with no suffix", async () => {
    const result = await applyRemotePathMapping(clientId, "C:\\Downloads");
    expect(result).toBe("/downloads");
  });

  it("leaves a path unchanged when it doesn't start with any configured remote prefix", async () => {
    const result = await applyRemotePathMapping(clientId, "D:\\Other\\file.mkv");
    expect(result).toBe("D:\\Other\\file.mkv");
  });

  it("prefers the longest matching prefix when mappings overlap", async () => {
    await db
      .prepare("INSERT INTO remote_path_mappings (download_client_id, remote_path, local_path) VALUES (?, ?, ?)")
      .run(clientId, "C:\\Downloads\\Movies", "/data/movies");

    const result = await applyRemotePathMapping(clientId, "C:\\Downloads\\Movies\\Movie.2024\\file.mkv");
    expect(result).toBe("/data/movies/Movie.2024/file.mkv");

    // A sibling path outside the more specific mapping still falls back to the broader one.
    const other = await applyRemotePathMapping(clientId, "C:\\Downloads\\TV\\Show\\S01E01.mkv");
    expect(other).toBe("/downloads/TV/Show/S01E01.mkv");
  });

  it("doesn't apply a mapping configured for a different download client", async () => {
    const otherResult = await db
      .prepare("INSERT INTO download_clients (name, type, host, port, enabled) VALUES ('sab', 'sabnzbd', 'localhost', 8081, 1)")
      .run();
    const otherClientId = Number(otherResult.lastInsertRowid);

    const result = await applyRemotePathMapping(otherClientId, "C:\\Downloads\\Movie.2024.mkv");
    expect(result).toBe("C:\\Downloads\\Movie.2024.mkv");
  });
});
