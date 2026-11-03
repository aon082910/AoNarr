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

const KEYS = ["genericWebhookUrl", "genericEvents", "ntfyServerUrl", "ntfyTopic", "ntfyToken", "ntfyEvents", "gotifyServerUrl", "gotifyToken", "gotifyEvents", "pushEvents", "notifyTemplateAdded"];

beforeAll(async () => {
  ({ app, apiKey } = await setupTestDb());
  notifications = await import("../src/services/notifications.js");
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
});

beforeEach(() => {
  sendPush.mockReset().mockResolvedValue(undefined);
  for (const key of KEYS) deleteSetting(key);
});

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
    for (const event of ["grabbed", "imported", "failed", "healthIssue", "updateAvailable"]) expect(notifications.isEventEnabledFor("generic", event)).toBe(true);
    for (const event of ["added", "deleted", "renamed", "fileDeleted"]) expect(notifications.isEventEnabledFor("generic", event)).toBe(false);
  });

  it("a connection gets a new event once its list names it", () => {
    setSetting("genericEvents", "grabbed,added");
    expect(notifications.isEventEnabledFor("generic", "added")).toBe(true);
    expect(notifications.isEventEnabledFor("generic", "deleted")).toBe(false);
  });

  it("an event list saved empty still means no events", () => {
    setSetting("genericEvents", "");
    expect(notifications.isEventEnabledFor("generic", "grabbed")).toBe(false);
  });

  it("sends added, deleted, renamed and file-deleted with their own payloads", async () => {
    const fetchMock = stubFetch();
    setSetting("genericWebhookUrl", "https://hook.example.com/x");
    setSetting("genericEvents", "added,deleted,renamed,fileDeleted");

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
    setSetting("genericWebhookUrl", "https://hook.example.com/x");
    await notifications.notifyAdded("Arrival", "movie");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a message template can be set for the new events", async () => {
    const fetchMock = stubFetch();
    setSetting("ntfyServerUrl", "https://ntfy.example.com");
    setSetting("ntfyTopic", "media");
    setSetting("ntfyEvents", "added");
    setSetting("notifyTemplateAdded", "New: {mediaTitle}");
    await notifications.notifyAdded("Heat", "movie");
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe("New: Heat");
  });
});

describe("ntfy (ST13)", () => {
  it("posts the message to the topic with the title as a header and the token as a bearer", async () => {
    const fetchMock = stubFetch();
    setSetting("ntfyServerUrl", "https://ntfy.example.com/");
    setSetting("ntfyTopic", "my topic");
    setSetting("ntfyToken", "tk_secret");

    await notifications.notifyGrabbed("Heat", "Heat.1995.1080p");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.example.com/my%20topic");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("Heat\nHeat.1995.1080p");
    expect((init.headers as Record<string, string>).Title).toBe("Grabbed");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk_secret");
  });

  it("is not used until both the server and the topic are set, and honors its event list", async () => {
    const fetchMock = stubFetch();
    setSetting("ntfyServerUrl", "https://ntfy.example.com");
    await notifications.notifyGrabbed("Heat", "x");
    expect(fetchMock).not.toHaveBeenCalled();
    setSetting("ntfyTopic", "t");
    setSetting("ntfyEvents", "failed");
    await notifications.notifyGrabbed("Heat", "x");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the test button works and names a missing setting", async () => {
    await expect(notifications.sendTestNotification("ntfy")).rejects.toThrow(/server URL and topic/);
    const fetchMock = stubFetch();
    setSetting("ntfyServerUrl", "https://ntfy.example.com");
    setSetting("ntfyTopic", "t");
    await notifications.sendTestNotification("ntfy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an error names the host and not the topic", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    setSetting("ntfyServerUrl", "https://ntfy.example.com");
    setSetting("ntfyTopic", "private-topic-name");
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
    setSetting("gotifyServerUrl", "https://gotify.example.com");
    setSetting("gotifyToken", "AbC123");

    await notifications.notifyFailed("Heat", "no seeders");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gotify.example.com/message");
    expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("AbC123");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Failed", message: "Heat: no seeders", priority: 5 });
  });

  it("the test button names a missing setting", async () => {
    await expect(notifications.sendTestNotification("gotify")).rejects.toThrow(/server URL and application token/);
  });

  it("a server typed without its scheme is refused with a message that does not carry the token", async () => {
    stubFetch();
    setSetting("gotifyServerUrl", "gotify.lan:8080");
    setSetting("gotifyToken", "SECRET-TOKEN");
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
    setSetting("ntfyServerUrl", "192.168.1.5:8080");
    setSetting("ntfyTopic", "t");
    await expect(notifications.sendTestNotification("ntfy")).rejects.toThrow(/must start with http/);
  });
});

describe("the library fires them (ST13)", () => {
  it("tells a connection that asked for it when a title is added and when it is deleted", async () => {
    const fetchMock = stubFetch();
    setSetting("genericWebhookUrl", "https://hook.example.com/x");
    setSetting("genericEvents", "added,deleted");

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
