import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const sendPush = vi.fn();
vi.mock("../src/services/push.js", () => ({ sendPush: (...args: unknown[]) => sendPush(...args) }));
vi.mock("../src/services/smtp.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../src/services/mediaServer.js", () => ({ refreshMediaServerLibrary: vi.fn() }));

let notifications: typeof import("../src/services/notifications.js");
let app: Express;
let apiKey: string;
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let deleteSetting: (typeof import("../src/services/settingsStore.js"))["deleteSetting"];
let connections: typeof import("../src/services/notificationConnections.js");
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

// Providers are connections now (Round 30e): the ones these tests used to set up through settings are made here.
beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  notifications = await import("../src/services/notifications.js");
  connections = await import("../src/services/notificationConnections.js");
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(async () => {
  sendPush.mockReset().mockResolvedValue(undefined);
  await db.prepare("DELETE FROM notification_connections").run();
  deleteSetting("notifyTemplateAdded");
});

const webhook = (extra: Record<string, unknown> = {}) => connections.createNotificationConnection({ name: "Hook", kind: "webhook", config: { url: "https://hook.example.com/x" }, ...extra });
const ntfy = (config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  connections.createNotificationConnection({ name: "ntfy", kind: "ntfy", config: { serverUrl: "https://ntfy.example.com", topic: "t", ...config }, ...extra });
const gotify = (config: Record<string, unknown> = {}) =>
  connections.createNotificationConnection({ name: "Gotify", kind: "gotify", config: { serverUrl: "https://gotify.example.com", token: "AbC123", ...config } });

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the new notification events (ST13)", () => {
  it("a connection that never saved an event list gets the events it always had, but not the new bulk ones", () => {
    for (const event of ["grabbed", "imported", "failed", "healthIssue", "updateAvailable"]) expect(notifications.eventAllowed(null, event)).toBe(true);
    for (const event of ["added", "deleted", "renamed", "fileDeleted"]) expect(notifications.eventAllowed(null, event)).toBe(false);
  });

  it("a connection gets a new event once its list names it", () => {
    expect(notifications.eventAllowed("grabbed,added", "added")).toBe(true);
    expect(notifications.eventAllowed("grabbed,added", "deleted")).toBe(false);
  });

  it("an event list saved empty still means no events", () => {
    expect(notifications.eventAllowed("", "grabbed")).toBe(false);
  });

  it("sends added, deleted, renamed and file-deleted with their own payloads", async () => {
    const fetchMock = stubFetch();
    await webhook({ events: ["added", "deleted", "renamed", "fileDeleted"] });

    await notifications.notifyAdded("Arrival", "movie");
    await notifications.notifyDeleted("Arrival", "movie", true);
    await notifications.notifyRenamed("Arrival", 3);
    await notifications.notifyFileDeleted("Arrival", "Arrival.mkv");

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies).toEqual([
      { event: "added", mediaTitle: "Arrival", mediaType: "movie" },
      { event: "deleted", mediaTitle: "Arrival", mediaType: "movie", deletedFiles: true },
      { event: "renamed", mediaTitle: "Arrival", count: 3 },
      { event: "fileDeleted", mediaTitle: "Arrival", fileName: "Arrival.mkv" },
    ]);
  });

  it("sends nothing for an event a connection did not ask for", async () => {
    const fetchMock = stubFetch();
    await webhook();
    await notifications.notifyAdded("Arrival", "movie");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a message template can be set for the new events", async () => {
    const fetchMock = stubFetch();
    await ntfy({ topic: "media" }, { events: ["added"] });
    setSetting("notifyTemplateAdded", "New: {mediaTitle}");
    await notifications.notifyAdded("Heat", "movie");
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe("New: Heat");
  });
});

describe("ntfy (ST13)", () => {
  it("posts the message to the topic with the title as a header and the token as a bearer", async () => {
    const fetchMock = stubFetch();
    await ntfy({ serverUrl: "https://ntfy.example.com/", topic: "my topic", token: "tk_secret" });

    await notifications.notifyGrabbed("Heat", "Heat.1995.1080p");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.example.com/my%20topic");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("Heat\nHeat.1995.1080p");
    expect((init.headers as Record<string, string>).Title).toBe("Grabbed");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk_secret");
  });

  it("needs both the server and the topic to exist at all, and honors its event list", async () => {
    const fetchMock = stubFetch();
    await expect(connections.createNotificationConnection({ name: "ntfy", kind: "ntfy", config: { serverUrl: "https://ntfy.example.com" } })).rejects.toThrow("ntfy: Topic is required");
    await notifications.notifyGrabbed("Heat", "x");
    expect(fetchMock).not.toHaveBeenCalled();
    await ntfy({}, { events: ["failed"] });
    await notifications.notifyGrabbed("Heat", "x");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the test button works and names a missing connection", async () => {
    await expect(notifications.sendTestNotification("ntfy")).rejects.toThrow(/There is no ntfy connection yet/);
    const fetchMock = stubFetch();
    await ntfy();
    await notifications.sendTestNotification("ntfy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an error names the host and not the topic", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await ntfy({ topic: "private-topic-name" });
    const error = await notifications.sendTestNotification("ntfy").then(
      () => null,
      (err: Error) => err
    );
    expect(error?.message).toMatch(/ntfy\.example\.com.*403/);
    expect(error?.message).not.toContain("private-topic-name");
  });
});

describe("Gotify (ST13)", () => {
  it("posts a JSON message with the application token in a header, not in the URL", async () => {
    const fetchMock = stubFetch();
    await gotify();

    await notifications.notifyFailed("Heat", "no seeders");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gotify.example.com/message");
    expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("AbC123");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Failed", message: "Heat: no seeders", priority: 5 });
  });

  it("the test button names a missing connection", async () => {
    await expect(notifications.sendTestNotification("gotify")).rejects.toThrow(/There is no Gotify connection yet/);
  });

  // The API refuses a server typed without its scheme; one that came over from the old settings is stored as it was,
  // and the send names the problem without echoing the address or the token.
  async function withBadServerUrl(kind: "gotify" | "ntfy", serverUrl: string): Promise<void> {
    const conn = kind === "gotify" ? await gotify({ token: "SECRET-TOKEN" }) : await ntfy();
    const row = (await db.prepare("SELECT config FROM notification_connections WHERE id = ?").get(conn.id)) as { config: string };
    await db.prepare("UPDATE notification_connections SET config = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.config), serverUrl }), conn.id);
  }

  it("a server typed without its scheme is refused with a message that does not carry the token", async () => {
    stubFetch();
    await withBadServerUrl("gotify", "gotify.lan:8080");
    const error = await notifications.sendTestNotification("gotify").then(
      () => null,
      (err: Error) => err
    );
    expect(error?.message).toMatch(/must start with http/);
    expect(error?.message).not.toContain("SECRET-TOKEN");
    expect(error?.message).not.toContain("gotify.lan");
  });

  it("the same for ntfy", async () => {
    stubFetch();
    await withBadServerUrl("ntfy", "192.168.1.5:8080");
    await expect(notifications.sendTestNotification("ntfy")).rejects.toThrow(/must start with http/);
  });
});

describe("the library fires them (ST13)", () => {
  it("tells a connection that asked for it when a title is added and when it is deleted", async () => {
    const fetchMock = stubFetch();
    await webhook({ events: ["added", "deleted"] });

    const created = await request(app as any).post("/api/media").set("X-Api-Key", apiKey).send({ type: "movie", title: "Fired Film", year: 2022, confirmDuplicate: true });
    expect(created.status).toBe(201);
    const removed = await request(app as any).delete(`/api/media/${created.body.id}`).set("X-Api-Key", apiKey);
    expect(removed.status).toBeLessThan(300);

    await vi.waitFor(() => {
      const events = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).event);
      expect(events).toEqual(["added", "deleted"]);
    });
  });
});
