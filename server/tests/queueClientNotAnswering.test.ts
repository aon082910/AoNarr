import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const getDownloadClientAdapter = vi.fn();
vi.mock("../src/services/downloadClient.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getDownloadClientAdapter: (...args: unknown[]) => getDownloadClientAdapter(...args),
  applyRemotePathMapping: async (_clientId: number, remotePath: string) => remotePath,
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let pollQueue: (typeof import("../src/services/scheduler.js"))["pollQueue"];
let NOTE: string;
let recordClientFailure: (typeof import("../src/services/clientStatus.js"))["recordClientFailure"];
let recordClientSuccess: (typeof import("../src/services/clientStatus.js"))["recordClientSuccess"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  const scheduler = await import("../src/services/scheduler.js");
  pollQueue = scheduler.pollQueue;
  NOTE = scheduler.CLIENT_NOT_ANSWERING_NOTE;
  ({ recordClientFailure, recordClientSuccess } = await import("../src/services/clientStatus.js"));
});

const clientIds: number[] = [];

beforeEach(async () => {
  for (const id of clientIds.splice(0)) await recordClientSuccess(id);
  for (const t of ["history", "queue", "media_items", "download_clients"]) await db.prepare(`DELETE FROM ${t}`).run();
  getDownloadClientAdapter.mockReset();
});

async function insertClient(name: string): Promise<number> {
  const id = Number((await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES (?, 'qbittorrent', 1)").run(name)).lastInsertRowid);
  clientIds.push(id);
  return id;
}

/** A downloading row that already carries an ETA, a size left and a client note from an earlier good poll. */
async function insertRow(clientId: number, downloadId: string): Promise<number> {
  const movie = Number(
    (await db.prepare("INSERT INTO media_items (type, title, sort_title, status) VALUES ('movie', ?, ?, 'missing')").run(`Movie ${downloadId}`, `movie ${downloadId}`)).lastInsertRowid
  );
  return Number(
    (
      await db
        .prepare(
          "INSERT INTO queue (media_item_id, title, download_client_id, download_id, status, progress, eta_seconds, size_left, client_state, status_message) VALUES (?, 'Movie.2020.1080p.WEB-DL-GRP', ?, ?, 'downloading', 0.4, 600, 1500000000, 'downloading', NULL)"
        )
        .run(movie, clientId, downloadId)
    ).lastInsertRowid
  );
}

const rowOf = async (id: number) =>
  (await db.prepare("SELECT status, progress, eta_seconds, size_left, client_state, status_message FROM queue WHERE id = ?").get(id)) as {
    status: string;
    progress: number;
    eta_seconds: number | null;
    size_left: number | null;
    client_state: string | null;
    status_message: string | null;
  };

describe("a download client that stops answering (round 30c)", () => {
  it("clears the ETA and size left of its rows and says so, without failing them", async () => {
    const client = await insertClient("Down");
    const row = await insertRow(client, "dl-1");
    getDownloadClientAdapter.mockReturnValue({ getStatus: vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED"))) });

    await pollQueue();

    expect(await rowOf(row)).toMatchObject({ status: "downloading", progress: 0.4, eta_seconds: null, size_left: null, client_state: "warning", status_message: NOTE });
  });

  it("restores the real values on the next good poll", async () => {
    const client = await insertClient("Flaky");
    const row = await insertRow(client, "dl-2");
    getDownloadClientAdapter.mockReturnValue({ getStatus: vi.fn(async () => Promise.reject(new Error("timeout"))) });
    await pollQueue();
    await recordClientSuccess(client); // the wait on the ladder is over

    getDownloadClientAdapter.mockReturnValue({
      getStatus: vi.fn(async () => [{ downloadId: "dl-2", progress: 0.5, status: "downloading", etaSeconds: 300, sizeLeft: 1_000_000_000 }]),
    });
    await pollQueue();

    expect(await rowOf(row)).toMatchObject({ progress: 0.5, eta_seconds: 300, size_left: 1_000_000_000, client_state: "downloading", status_message: null });
  });

  it("also clears the rows of a client that is being left alone after a failure", async () => {
    const client = await insertClient("Backed off");
    const row = await insertRow(client, "dl-3");
    await recordClientFailure(client, "refused");
    const getStatus = vi.fn(async () => []);
    getDownloadClientAdapter.mockReturnValue({ getStatus });

    await pollQueue();

    expect(getStatus).not.toHaveBeenCalled();
    expect(await rowOf(row)).toMatchObject({ eta_seconds: null, size_left: null, client_state: "warning", status_message: NOTE });
  });

  it("leaves the rows of a client that answers alone", async () => {
    const down = await insertClient("Down");
    const up = await insertClient("Up");
    await insertRow(down, "dl-4");
    const healthy = await insertRow(up, "dl-5");
    getDownloadClientAdapter.mockImplementation((_type: string) => ({
      getStatus: vi.fn(async (client: { id: number }) =>
        client.id === down ? Promise.reject(new Error("refused")) : [{ downloadId: "dl-5", progress: 0.4, status: "downloading", etaSeconds: 600, sizeLeft: 1_500_000_000 }]
      ),
    }));

    await pollQueue();

    expect(await rowOf(healthy)).toMatchObject({ eta_seconds: 600, size_left: 1_500_000_000, client_state: "downloading", status_message: null });
  });
});
