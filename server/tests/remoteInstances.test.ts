import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import v8 from "node:v8";
import vm from "node:vm";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let decryptValue: (typeof import("../src/services/encryption.js"))["decryptValue"];
let encryptValue: (typeof import("../src/services/encryption.js"))["encryptValue"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  ({ decryptValue, encryptValue } = await import("../src/services/encryption.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function storedKey(id: number): Promise<string> {
  return ((await db.prepare("SELECT api_key FROM remote_instances WHERE id = ?").get(id)) as { api_key: string }).api_key;
}

/** Stands in for the remote instance: records the X-Api-Key each request carried. */
function stubRemote(items: unknown[]): { sentKeys: string[] } {
  const sentKeys: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      sentKeys.push(init?.headers?.["X-Api-Key"] ?? "");
      const body = String(url).includes("/api/media-types") ? [{ id: "movie" }] : { items, total: items.length };
      return { ok: true, status: 200, json: async () => body } as any;
    })
  );
  return { sentKeys };
}

describe("remote instance API keys at rest", () => {
  it("stores a new instance's API key encrypted, never returns it, and uses the plaintext against the remote", async () => {
    const created = await request(app)
      .post("/api/remote-instances")
      .set("X-Api-Key", apiKey)
      .send({ name: "Encrypted Remote", url: "http://remote-a.local:9876/", apiKey: "remote-secret-key" });

    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("remote-secret-key");
    const raw = await storedKey(created.body.id);
    expect(raw.startsWith("enc1:")).toBe(true);
    expect(decryptValue(raw)).toBe("remote-secret-key");

    const { sentKeys } = stubRemote([]);
    const media = await request(app).get(`/api/remote-instances/${created.body.id}/media`).set("X-Api-Key", apiKey);
    const types = await request(app).get(`/api/remote-instances/${created.body.id}/media-types`).set("X-Api-Key", apiKey);

    expect(media.status).toBe(200);
    expect(types.status).toBe(200);
    expect(sentKeys).toEqual(["remote-secret-key", "remote-secret-key"]);
  });

  it("encrypts a replacement key saved through PATCH", async () => {
    const created = await request(app)
      .post("/api/remote-instances")
      .set("X-Api-Key", apiKey)
      .send({ name: "Rotated Remote", url: "http://remote-b.local:9876", apiKey: "old-key" });

    const patched = await request(app).patch(`/api/remote-instances/${created.body.id}`).set("X-Api-Key", apiKey).send({ apiKey: "new-key" });

    expect(patched.status).toBe(200);
    const raw = await storedKey(created.body.id);
    expect(raw.startsWith("enc1:")).toBe(true);
    expect(decryptValue(raw)).toBe("new-key");
  });

  it("keeps working with a key stored in plaintext before encryption, and re-saves it encrypted", async () => {
    const id = Number(
      (
        await db
          .prepare("INSERT INTO remote_instances (name, url, api_key) VALUES ('Legacy Remote', 'http://remote-c.local:9876', 'legacy-plain-key')")
          .run()
      ).lastInsertRowid
    );
    const { sentKeys } = stubRemote([]);

    const res = await request(app).get(`/api/remote-instances/${id}/media`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(sentKeys).toEqual(["legacy-plain-key"]);
    const raw = await storedKey(id);
    expect(raw.startsWith("enc1:")).toBe(true);
    expect(decryptValue(raw)).toBe("legacy-plain-key");
  });

  it("doesn't re-save a legacy plaintext key over one rotated after it was read", async () => {
    const id = Number(
      (
        await db
          .prepare("INSERT INTO remote_instances (name, url, api_key) VALUES ('Racing Remote', 'http://remote-e.local:9876', 'stale-plain-key')")
          .run()
      ).lastInsertRowid
    );
    const rotated = encryptValue("rotated-key");
    const { initDb } = await import("../src/db/index.js");
    const inner = await initDb();
    const realPrepare = inner.prepare.bind(inner);
    // The admin saves a new key in Settings between the proxy's read of the row and its re-save.
    const prepareSpy = vi.spyOn(inner, "prepare").mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.startsWith("UPDATE remote_instances SET api_key")) return stmt;
      return {
        ...stmt,
        run: async (...params: unknown[]) => {
          await realPrepare("UPDATE remote_instances SET api_key = ? WHERE id = ?").run(rotated, id);
          return stmt.run(...params);
        },
      };
    });
    const { sentKeys } = stubRemote([]);

    try {
      const res = await request(app).get(`/api/remote-instances/${id}/media`).set("X-Api-Key", apiKey);
      expect(res.status).toBe(200);
    } finally {
      prepareSpy.mockRestore();
    }

    expect(sentKeys).toEqual(["stale-plain-key"]);
    expect(await storedKey(id)).toBe(rotated);
  });
});

describe("remote instance local artwork", () => {
  let remoteId: number;

  beforeAll(async () => {
    const created = await request(app)
      .post("/api/remote-instances")
      .set("X-Api-Key", apiKey)
      .send({ name: "Artwork Remote", url: "http://remote-d.local:9876/", apiKey: "k" });
    remoteId = created.body.id;
  });

  /** The remote's public local-artwork route: answers one token, records what was requested. */
  function stubRemoteArtwork(response: () => Response): { calls: { url: string; headers?: unknown }[] } {
    const calls: { url: string; headers?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: unknown }) => {
        calls.push({ url: String(url), headers: init?.headers });
        return response();
      })
    );
    return { calls };
  }

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  it("points local-artwork URLs at this instance's relay route and leaves absolute URLs alone", async () => {
    stubRemote([
      { id: 1, title: "Sidecar Poster", posterUrl: "/api/media/local-artwork/tok1", backdropUrl: "/api/media/local-artwork/tok2" },
      { id: 2, title: "Provider Poster", posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg", backdropUrl: null },
      { id: 3, title: "Protocol Relative", posterUrl: "//cdn.example/p.jpg" },
    ]);

    const res = await request(app).get(`/api/remote-instances/${remoteId}/media`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 1,
        title: "Sidecar Poster",
        posterUrl: `/api/remote-instances/${remoteId}/local-artwork/tok1`,
        backdropUrl: `/api/remote-instances/${remoteId}/local-artwork/tok2`,
      },
      { id: 2, title: "Provider Poster", posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg", backdropUrl: null },
      { id: 3, title: "Protocol Relative", posterUrl: "//cdn.example/p.jpg" },
    ]);
  });

  it("relays the image from the remote's own local-artwork route without sending its API key", async () => {
    const { calls } = stubRemoteArtwork(() => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } }));

    const res = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.compare(res.body as Buffer, JPEG)).toBe(0);
    expect(calls).toEqual([{ url: "http://remote-d.local:9876/api/media/local-artwork/tok1", headers: undefined }]);
  });

  it("serves an <img> request that carries no credentials, with authentication required", async () => {
    const { getSetting } = await import("../src/services/settingsStore.js");
    expect(getSetting("authRequired")).not.toBe("0");
    stubRemoteArtwork(() => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } }));

    const artwork = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`);

    expect(artwork.status).toBe(200);
    expect(Buffer.compare(artwork.body as Buffer, JPEG)).toBe(0);
  });

  it("still requires credentials for every other remote-instance request", async () => {
    const { calls } = stubRemoteArtwork(() => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } }));

    const list = await request(app).get("/api/remote-instances");
    const media = await request(app).get(`/api/remote-instances/${remoteId}/media`);
    const types = await request(app).get(`/api/remote-instances/${remoteId}/media-types`);
    const post = await request(app).post(`/api/remote-instances/${remoteId}/local-artwork/tok1`);
    const nested = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1/extra`);

    expect([list.status, media.status, types.status, post.status, nested.status]).toEqual([401, 401, 401, 401, 401]);
    expect(calls).toEqual([]);
  });

  it("doesn't follow a redirect from whatever answers at the remote's URL", async () => {
    const internal = "http://169.254.169.254/latest/poster.jpg";
    const calls: string[] = [];
    // Behaves like fetch does for each redirect mode when the remote answers 302.
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(String(url));
      if (String(url) === internal) return new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { Location: internal } });
      return fakeFetch(internal, init);
    };
    vi.stubGlobal("fetch", vi.fn(fakeFetch));

    const res = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`);

    expect(res.status).toBe(404);
    expect(calls).toEqual(["http://remote-d.local:9876/api/media/local-artwork/tok1"]);
  });

  const jpegResponse = () => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });

  /** Stands in for a remote whose artwork requests hang until the test answers them. */
  function holdRemoteArtwork(): ((res: Response) => void)[] {
    const held: ((res: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => held.push(resolve))));
    return held;
  }

  it("queues relays over the in-flight cap instead of refusing them, never running more than the cap at once", async () => {
    const { MAX_CONCURRENT_ARTWORK_RELAYS, queuedArtworkRelays } = await import("../src/routes/remoteInstances.js");
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return jpegResponse();
      })
    );
    const url = `/api/remote-instances/${remoteId}/local-artwork/tok1`;
    let settled = 0;

    const requests = Array.from({ length: 60 }, () =>
      request(app)
        .get(url)
        .then((r) => {
          settled++;
          return r;
        })
    );
    await vi.waitFor(() => expect(queuedArtworkRelays()).toBe(60 - MAX_CONCURRENT_ARTWORK_RELAYS), { timeout: 10_000 });
    expect(calls).toBe(MAX_CONCURRENT_ARTWORK_RELAYS);
    expect(settled).toBe(0);

    openGate();
    const responses = await Promise.all(requests);

    expect(responses.map((r) => r.status)).toEqual(Array(60).fill(200));
    expect(responses.every((r) => Buffer.compare(r.body as Buffer, JPEG) === 0)).toBe(true);
    expect(calls).toBe(60);
    expect(maxActive).toBe(MAX_CONCURRENT_ARTWORK_RELAYS);
    expect(queuedArtworkRelays()).toBe(0);
  }, 30_000);

  it("answers 503 once the wait queue is full, and frees each slot once its relay ends", async () => {
    const { MAX_CONCURRENT_ARTWORK_RELAYS, artworkRelayLimits, queuedArtworkRelays } = await import("../src/routes/remoteInstances.js");
    const maxQueued = artworkRelayLimits.maxQueued;
    artworkRelayLimits.maxQueued = 4;
    try {
      const held = holdRemoteArtwork();
      const url = `/api/remote-instances/${remoteId}/local-artwork/tok1`;

      const inFlight = Array.from({ length: MAX_CONCURRENT_ARTWORK_RELAYS }, () => request(app).get(url).then((r) => r));
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS));
      const queued = Array.from({ length: 4 }, () => request(app).get(url).then((r) => r));
      await vi.waitFor(() => expect(queuedArtworkRelays()).toBe(4));

      const refused = await request(app).get(url);
      expect(refused.status).toBe(503);
      expect(refused.headers["retry-after"]).toBe("1");
      expect(held).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS);

      // Half the held relays succeed, half fail upstream: both must hand their slot on.
      held
        .splice(0, MAX_CONCURRENT_ARTWORK_RELAYS)
        .forEach((resolve, i) => resolve(i % 2 === 0 ? jpegResponse() : new Response(null, { status: 500 })));
      const statuses = (await Promise.all(inFlight)).map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS / 2);
      expect(statuses.filter((s) => s === 404)).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS / 2);

      await vi.waitFor(() => expect(held).toHaveLength(4));
      held.splice(0).forEach((resolve) => resolve(jpegResponse()));
      expect((await Promise.all(queued)).map((r) => r.status)).toEqual([200, 200, 200, 200]);

      stubRemoteArtwork(jpegResponse);
      const after = await Promise.all(Array.from({ length: MAX_CONCURRENT_ARTWORK_RELAYS }, () => request(app).get(url)));
      expect(after.map((r) => r.status)).toEqual(Array(MAX_CONCURRENT_ARTWORK_RELAYS).fill(200));
      expect(queuedArtworkRelays()).toBe(0);
    } finally {
      artworkRelayLimits.maxQueued = maxQueued;
    }
  });

  it("answers 503 when a queued relay's deadline passes before a slot frees up", async () => {
    const { MAX_CONCURRENT_ARTWORK_RELAYS, artworkRelayLimits, queuedArtworkRelays } = await import("../src/routes/remoteInstances.js");
    const timeoutMs = artworkRelayLimits.timeoutMs;
    artworkRelayLimits.timeoutMs = 300;
    try {
      const held = holdRemoteArtwork();
      const url = `/api/remote-instances/${remoteId}/local-artwork/tok1`;
      const inFlight = Array.from({ length: MAX_CONCURRENT_ARTWORK_RELAYS }, () => request(app).get(url).then((r) => r));
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS));

      const late = await request(app).get(url);

      expect(late.status).toBe(503);
      expect(queuedArtworkRelays()).toBe(0);
      expect(held).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS);
      held.splice(0).forEach((resolve) => resolve(jpegResponse()));
      await Promise.all(inFlight);
    } finally {
      artworkRelayLimits.timeoutMs = timeoutMs;
    }
  });

  it("keeps a relay's deadline through garbage collection, while queued and while the remote stalls", async () => {
    const { MAX_CONCURRENT_ARTWORK_RELAYS, artworkRelayLimits, queuedArtworkRelays } = await import("../src/routes/remoteInstances.js");
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const collectWhile = async (done: () => boolean) => {
      for (let i = 0; i < 20 && !done(); i++) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const within = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), ms))]);
    const timeoutMs = artworkRelayLimits.timeoutMs;
    artworkRelayLimits.timeoutMs = 300;
    try {
      const held = holdRemoteArtwork();
      const url = `/api/remote-instances/${remoteId}/local-artwork/tok1`;
      const inFlight = Array.from({ length: MAX_CONCURRENT_ARTWORK_RELAYS }, () => request(app).get(url).then((r) => r));
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS));

      let queuedDone = false;
      const queued = request(app)
        .get(url)
        .then((r) => ((queuedDone = true), r));
      await vi.waitFor(() => expect(queuedArtworkRelays()).toBe(1));
      await collectWhile(() => queuedDone);
      const refused = await within(queued, 3000);
      expect(refused === "still pending" ? refused : refused.status).toBe(503);
      expect(queuedArtworkRelays()).toBe(0);

      held.splice(0).forEach((resolve) => resolve(jpegResponse()));
      await Promise.all(inFlight);

      // A remote that accepts the connection and never answers; only an abort ends the fetch.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
            })
        )
      );
      let stalledDone = false;
      const stalled = request(app)
        .get(url)
        .then((r) => ((stalledDone = true), r));
      await collectWhile(() => stalledDone);
      const gaveUp = await within(stalled, 3000);
      expect(gaveUp === "still pending" ? gaveUp : gaveUp.status).toBe(404);
    } finally {
      artworkRelayLimits.timeoutMs = timeoutMs;
    }
  });

  it("drops a queued relay whose client goes away, without it ever taking a slot", async () => {
    const { MAX_CONCURRENT_ARTWORK_RELAYS, queuedArtworkRelays } = await import("../src/routes/remoteInstances.js");
    const held = holdRemoteArtwork();
    const url = `/api/remote-instances/${remoteId}/local-artwork/tok1`;
    const inFlight = Array.from({ length: MAX_CONCURRENT_ARTWORK_RELAYS }, () => request(app).get(url).then((r) => r));
    await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_ARTWORK_RELAYS));

    const server = app.listen(0);
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const abandoned = http.get(`http://127.0.0.1:${port}${url}`);
      abandoned.on("error", () => {});
      await vi.waitFor(() => expect(queuedArtworkRelays()).toBe(1));

      abandoned.destroy();
      await vi.waitFor(() => expect(queuedArtworkRelays()).toBe(0));

      held.splice(0).forEach((resolve) => resolve(jpegResponse()));
      expect((await Promise.all(inFlight)).map((r) => r.status)).toEqual(Array(MAX_CONCURRENT_ARTWORK_RELAYS).fill(200));
      // The abandoned request never fetched anything, and every slot is free again.
      expect(held).toHaveLength(0);
      stubRemoteArtwork(jpegResponse);
      const after = await Promise.all(Array.from({ length: MAX_CONCURRENT_ARTWORK_RELAYS }, () => request(app).get(url)));
      expect(after.map((r) => r.status)).toEqual(Array(MAX_CONCURRENT_ARTWORK_RELAYS).fill(200));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses anything the remote returns that isn't a raster image", async () => {
    stubRemoteArtwork(() => new Response("<script>alert(1)</script>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const html = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`).set("X-Api-Key", apiKey);

    stubRemoteArtwork(() => new Response("<svg onload='alert(1)'/>", { status: 200, headers: { "Content-Type": "image/svg+xml" } }));
    const svg = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`).set("X-Api-Key", apiKey);

    stubRemoteArtwork(() => new Response(JSON.stringify({ error: "No artwork found for this token" }), { status: 404, headers: { "Content-Type": "image/jpeg" } }));
    const missing = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`).set("X-Api-Key", apiKey);

    expect(html.status).toBe(404);
    expect(svg.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("404s an unknown instance or a malformed token without contacting anything", async () => {
    const { calls } = stubRemoteArtwork(() => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } }));

    const unknown = await request(app).get("/api/remote-instances/999999/local-artwork/tok1").set("X-Api-Key", apiKey);
    const traversal = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/..%2F..%2Fapi%2Fmedia`).set("X-Api-Key", apiKey);

    expect(unknown.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("answers 404 instead of hanging when the remote can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const res = await request(app).get(`/api/remote-instances/${remoteId}/local-artwork/tok1`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(404);
  });
});
