import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let setSetting: (key: string, value: string) => void;
let server: http.Server;
let baseUrl: string;

interface OpenedStream {
  status: number;
  received: () => string;
  isClosed: () => boolean;
  closed: Promise<void>;
  close: () => void;
}

/** GETs an SSE route over a real socket (supertest waits for a response end a stream never sends);
 * a 200 resolves once the ": connected" preamble arrived, i.e. the server has registered the client. */
function openStream(path: string, headers: Record<string, string> = {}): Promise<OpenedStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, { headers }, (res) => {
      let data = "";
      let closedFlag = false;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("error", () => {});
      const closed = new Promise<void>((done) =>
        res.on("close", () => {
          closedFlag = true;
          done();
        })
      );
      const stream = { status: res.statusCode ?? 0, received: () => data, isClosed: () => closedFlag, closed, close: () => req.destroy() };
      if (res.statusCode === 200) res.once("data", () => resolve(stream));
      else resolve(stream);
    });
    req.on("error", reject);
  });
}

function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms))]);
}

async function mintTicket(headers: Record<string, string>): Promise<string> {
  const res = await request(app).post("/api/auth/stream-ticket").set(headers);
  expect(res.status).toBe(200);
  expect(typeof res.body.ticket).toBe("string");
  return res.body.ticket;
}

async function adminSession(username: string): Promise<string> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (await db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, hashPassword("x"))).lastInsertRowid
  );
  return (await createSession(userId)).token;
}

describe("SSE stream tickets", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    ({ setSetting } = await import("../src/services/settingsStore.js"));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setSetting("apiKey", apiKey);
    setSetting("authRequired", "1");
  });

  it("no longer accepts the API key or a session token in the query string", async () => {
    const token = await adminSession("query-string-admin");

    expect((await request(app).get(`/api/auth/me?apikey=${apiKey}`)).status).toBe(401);
    expect((await request(app).get(`/api/auth/me?sessionToken=${token}`)).status).toBe(401);
    expect((await openStream(`/api/system/logs/stream?apikey=${apiKey}`)).status).toBe(401);
  });

  it("only mints a ticket for an authenticated caller", async () => {
    expect((await request(app).post("/api/auth/stream-ticket")).status).toBe(401);

    const res = await request(app).post("/api/auth/stream-ticket").set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("opens the log and queue streams with a ticket, each ticket exactly once", async () => {
    const ticket = await mintTicket({ "X-Api-Key": apiKey });
    const logs = await openStream(`/api/system/logs/stream?ticket=${ticket}`);
    try {
      expect(logs.status).toBe(200);
      expect(logs.received()).toContain(": connected");
      expect((await openStream(`/api/system/logs/stream?ticket=${ticket}`)).status).toBe(401);
    } finally {
      logs.close();
    }

    const queue = await openStream(`/api/activity/stream?ticket=${await mintTicket({ "X-Api-Key": apiKey })}`);
    try {
      expect(queue.status).toBe(200);
    } finally {
      queue.close();
    }
  });

  it("doesn't accept a ticket as a credential anywhere but the stream routes", async () => {
    const ticket = await mintTicket({ "X-Api-Key": apiKey });

    expect((await request(app).get(`/api/auth/me?ticket=${ticket}`)).status).toBe(401);
    expect((await request(app).get(`/api/settings?ticket=${ticket}`)).status).toBe(401);
    // Not spent by those attempts.
    const stream = await openStream(`/api/system/logs/stream?ticket=${ticket}`);
    stream.close();
    expect(stream.status).toBe(200);
  });

  it("rejects a ticket past its lifetime", async () => {
    const ticket = await mintTicket({ "X-Api-Key": apiKey });
    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);

    expect((await openStream(`/api/system/logs/stream?ticket=${ticket}`)).status).toBe(401);
  });

  it("rejects a ticket whose session was revoked before it was used", async () => {
    const token = await adminSession("revoked-before-use-admin");
    const ticket = await mintTicket({ "X-Session-Token": token });
    await db.prepare("DELETE FROM sessions WHERE token = ?").run(token);

    expect((await openStream(`/api/system/logs/stream?ticket=${ticket}`)).status).toBe(401);
  });

  it("keeps a stream open while its session is valid and drops it once the session is revoked", async () => {
    const token = await adminSession("revoked-stream-admin");
    const ticket = await mintTicket({ "X-Session-Token": token });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream(`/api/system/logs/stream?ticket=${ticket}`);
    expect(stream.status).toBe(200);

    await vi.advanceTimersByTimeAsync(30_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.isClosed()).toBe(false);

    await db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    await vi.advanceTimersByTimeAsync(30_000);
    await within(stream.closed);
  });

  it("drops a stream once the API key it was opened with is regenerated", async () => {
    const ticket = await mintTicket({ "X-Api-Key": apiKey });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream(`/api/activity/stream?ticket=${ticket}`);
    expect(stream.status).toBe(200);

    setSetting("apiKey", "a-freshly-regenerated-key");
    await vi.advanceTimersByTimeAsync(30_000);
    await within(stream.closed);
  });

  it("re-checks a stream opened with a header credential too", async () => {
    const token = await adminSession("header-stream-admin");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream("/api/system/logs/stream", { "X-Session-Token": token });
    expect(stream.status).toBe(200);

    await db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    await vi.advanceTimersByTimeAsync(30_000);
    await within(stream.closed);
  });

  it("drops a stream opened while Authentication was disabled once it's enabled again", async () => {
    setSetting("authRequired", "0");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = await openStream("/api/system/logs/stream");
    expect(stream.status).toBe(200);

    setSetting("authRequired", "1");
    await vi.advanceTimersByTimeAsync(30_000);
    await within(stream.closed);
  });
});
