import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// Notifications as connections (Round 30e, ST13/ST21): the move from the old settings, the API, sending to several
// connections of one kind, tags, per-connection Health, the Test button and the webhook kind.

const sendPush = vi.fn();
const sendEmail = vi.fn();
vi.mock("../src/services/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/services/push.js")>()), sendPush: (...args: unknown[]) => sendPush(...args) }));
vi.mock("../src/services/smtp.js", () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));
vi.mock("../src/services/mediaServer.js", () => ({ refreshMediaServerLibrary: vi.fn() }));

let execFileError: Error | null = null;
const execFileMock = vi.fn((_file: string, _args: string[], _options: any, callback: (err: Error | null, result?: any) => void) => {
  callback(execFileError, { stdout: "", stderr: "" });
});
vi.mock("node:child_process", () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let notifications: typeof import("../src/services/notifications.js");
let connections: typeof import("../src/services/notificationConnections.js");
let status: typeof import("../src/services/notificationStatus.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let deleteSetting: (typeof import("../src/services/settingsStore.js"))["deleteSetting"];
let getSetting: (typeof import("../src/services/settingsStore.js"))["getSetting"];
let getAllSettings: (typeof import("../src/services/settingsStore.js"))["getAllSettings"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  notifications = await import("../src/services/notifications.js");
  connections = await import("../src/services/notificationConnections.js");
  status = await import("../src/services/notificationStatus.js");
  ({ setSetting, deleteSetting, getSetting, getAllSettings } = await import("../src/services/settingsStore.js"));
});

const OLD_KEYS = [
  "discordWebhookUrl", "slackWebhookUrl", "genericWebhookUrl", "telegramBotToken", "telegramChatId", "pushoverApiToken", "pushoverUserKey",
  "ntfyServerUrl", "ntfyTopic", "ntfyToken", "gotifyServerUrl", "gotifyToken", "matrixHomeserverUrl", "matrixAccessToken", "matrixRoomId",
  "twilioAccountSid", "twilioAuthToken", "twilioFromNumber", "twilioToNumber", "smtpHost", "smtpTo", "smtpFrom", "smtpPort", "smtpSecure",
  "smtpUsername", "smtpPassword", "customScriptEnabled", "customScriptPath", "vapidPublicKey",
];
const OLD_EVENT_KEYS = ["discordEvents", "slackEvents", "genericEvents", "telegramEvents", "pushoverEvents", "ntfyEvents", "gotifyEvents", "matrixEvents", "twilioEvents", "smtpEvents", "pushEvents", "customScriptEvents"];
const TEMPLATE_KEYS = notificationsTemplateKeys();

function notificationsTemplateKeys(): string[] {
  return ["Grabbed", "Imported", "Upgraded", "Failed", "DuplicatesFound", "HealthIssue", "HealthRestored", "ManualInteractionRequired", "UpdateAvailable", "Added", "Deleted", "Renamed", "FileDeleted"].map((e) => `notifyTemplate${e}`);
}

beforeEach(async () => {
  await db.prepare("DELETE FROM notification_connections").run();
  await db.prepare("DELETE FROM push_subscriptions").run();
  for (const key of OLD_KEYS) deleteSetting(key);
  for (const key of OLD_EVENT_KEYS) deleteSetting(key);
  for (const key of TEMPLATE_KEYS) deleteSetting(key);
  status.__resetNotificationFailuresForTests();
  sendPush.mockReset().mockResolvedValue(undefined);
  sendEmail.mockReset().mockResolvedValue(undefined);
  execFileMock.mockClear();
  execFileError = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const api = {
  get: (url: string) => request(app).get(url).set("X-Api-Key", apiKey),
  post: (url: string, body: unknown = {}) => request(app).post(url).set("X-Api-Key", apiKey).send(body as object),
  put: (url: string, body: unknown = {}) => request(app).put(url).set("X-Api-Key", apiKey).send(body as object),
  del: (url: string) => request(app).delete(url).set("X-Api-Key", apiKey),
};

function stubFetch(status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: any) => ({ ok: status < 400, status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const urls = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls.map((c) => String(c[0]));

async function make(kind: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return connections.createNotificationConnection({ name: extra.name ?? kind, kind, config, ...extra });
}

/** Runs the move again from whatever the old settings hold now. */
async function migrateAgain(): Promise<number> {
  await db.prepare("DELETE FROM notification_connections").run();
  setSetting("notificationConnectionsMigrated", "");
  return connections.migrateNotificationConnections();
}

// ---------------------------------------------------------------------------
// the move from the old settings
// ---------------------------------------------------------------------------

describe("the move from the old settings to connections", () => {
  it("creates nothing on an install where nothing was set up, and still sets the marker", async () => {
    expect(await migrateAgain()).toBe(0);
    expect(await connections.listNotificationConnections()).toEqual([]);
    expect(getSetting("notificationConnectionsMigrated")).toBe("1");
  });

  it("makes one connection for each provider that was set up, with its values", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/api/webhooks/1/secret-discord");
    setSetting("slackWebhookUrl", "https://hooks.slack.example/services/T/B/secret-slack");
    setSetting("genericWebhookUrl", "https://hook.example/x");
    setSetting("telegramBotToken", "tg-token");
    setSetting("telegramChatId", "chat-9");
    setSetting("pushoverApiToken", "po-api");
    setSetting("pushoverUserKey", "po-user");
    setSetting("ntfyServerUrl", "https://ntfy.example");
    setSetting("ntfyTopic", "topic");
    setSetting("ntfyToken", "ntfy-tok");
    setSetting("gotifyServerUrl", "https://gotify.example");
    setSetting("gotifyToken", "got-tok");
    setSetting("matrixHomeserverUrl", "https://matrix.example");
    setSetting("matrixAccessToken", "mx-tok");
    setSetting("matrixRoomId", "!r:example");
    setSetting("twilioAccountSid", "AC1");
    setSetting("twilioAuthToken", "tw-tok");
    setSetting("twilioFromNumber", "+1555000");
    setSetting("twilioToNumber", "+1555111");
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpTo", "to@example.com");
    setSetting("smtpFrom", "from@example.com");
    setSetting("smtpPort", "465");
    setSetting("smtpSecure", "1");
    setSetting("smtpUsername", "mailer");
    setSetting("smtpPassword", "mail-pass");
    setSetting("customScriptEnabled", "1");
    setSetting("customScriptPath", "/scripts/on.sh");
    setSetting("pushEvents", "grabbed");

    expect(await migrateAgain()).toBe(12);

    const byKind = new Map((await connections.listNotificationConnections()).map((c) => [c.kind, c]));
    expect([...byKind.keys()].sort()).toEqual(["customScript", "discord", "email", "gotify", "matrix", "ntfy", "pushover", "slack", "telegram", "twilio", "webPush", "webhook"]);
    expect(byKind.get("discord")!.config).toEqual({ webhookUrl: "https://discord.example/api/webhooks/1/secret-discord" });
    expect(byKind.get("slack")!.config.webhookUrl).toContain("secret-slack");
    expect(byKind.get("webhook")!.config).toMatchObject({ url: "https://hook.example/x", method: "POST", payloadStyle: "aonarr", headers: [] });
    expect(byKind.get("telegram")!.config).toEqual({ botToken: "tg-token", chatId: "chat-9" });
    expect(byKind.get("pushover")!.config).toEqual({ apiToken: "po-api", userKey: "po-user" });
    expect(byKind.get("ntfy")!.config).toEqual({ serverUrl: "https://ntfy.example", topic: "topic", token: "ntfy-tok" });
    expect(byKind.get("gotify")!.config).toEqual({ serverUrl: "https://gotify.example", token: "got-tok" });
    expect(byKind.get("matrix")!.config).toEqual({ homeserverUrl: "https://matrix.example", accessToken: "mx-tok", roomId: "!r:example" });
    expect(byKind.get("twilio")!.config).toEqual({ accountSid: "AC1", authToken: "tw-tok", fromNumber: "+1555000", toNumber: "+1555111" });
    expect(byKind.get("email")!.config).toEqual({ host: "smtp.example", port: 465, secure: true, username: "mailer", password: "mail-pass", from: "from@example.com", to: "to@example.com" });
    expect(byKind.get("customScript")!.config).toEqual({ path: "/scripts/on.sh" });
    expect(byKind.get("customScript")!.enabled).toBe(true);
    expect(byKind.get("webPush")!.events).toBe("grabbed");
    // Never saved an event list: stays null, the same defaults as before.
    expect(byKind.get("discord")!.events).toBeNull();
    expect(byKind.get("discord")!.tagIds).toEqual([]);
  });

  it("does not make a connection for a provider that was only half set up (the old fan-out sent nothing for it)", async () => {
    setSetting("telegramBotToken", "tg-token"); // no chat id
    setSetting("pushoverApiToken", "po-api"); // no user key
    setSetting("matrixHomeserverUrl", "https://matrix.example"); // no token, no room
    setSetting("twilioAccountSid", "AC1");
    setSetting("smtpHost", "smtp.example"); // no from/to
    setSetting("ntfyServerUrl", "https://ntfy.example"); // no topic
    setSetting("customScriptEnabled", "1"); // no path

    expect(await migrateAgain()).toBe(0);
  });

  it("carries each provider's event list over, and an explicitly emptied one stays empty", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/w");
    setSetting("discordEvents", "grabbed,added");
    setSetting("slackWebhookUrl", "https://slack.example/w");
    setSetting("slackEvents", ""); // every event deliberately unticked
    setSetting("genericWebhookUrl", "https://generic.example/w");
    setSetting("genericEvents", "failed,fileDeleted");

    await migrateAgain();

    const byKind = new Map((await connections.listNotificationConnections()).map((c) => [c.kind, c]));
    expect(byKind.get("discord")!.events).toBe("grabbed,added");
    expect(byKind.get("slack")!.events).toBe("");
    expect(byKind.get("webhook")!.events).toBe("failed,fileDeleted");
    expect(connections.eventAllowed(byKind.get("slack")!.events, "grabbed")).toBe(false);
  });

  it("keeps the opt-in rule: a connection that never saved a list gets the old events and not the bulk ones", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/w");
    await migrateAgain();
    const [discord] = await connections.listNotificationConnections();
    for (const event of ["grabbed", "imported", "upgraded", "failed", "healthIssue", "healthRestored", "updateAvailable", "duplicatesFound", "manualInteractionRequired"]) {
      expect(connections.eventAllowed(discord.events, event), event).toBe(true);
    }
    for (const event of ["added", "deleted", "renamed", "fileDeleted"]) expect(connections.eventAllowed(discord.events, event), event).toBe(false);
  });

  it("makes a web push connection for an install that has a subscribed browser or ever generated its keys, and for a saved pushEvents", async () => {
    await db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES ('https://push.example/1', 'k', 'a', NULL)").run();
    await migrateAgain();
    expect((await connections.listNotificationConnections()).map((c) => c.kind)).toEqual(["webPush"]);

    await db.prepare("DELETE FROM push_subscriptions").run();
    setSetting("vapidPublicKey", "vapid");
    await migrateAgain();
    expect((await connections.listNotificationConnections()).map((c) => c.kind)).toEqual(["webPush"]);

    deleteSetting("vapidPublicKey");
    setSetting("pushEvents", "");
    await migrateAgain();
    const [push] = await connections.listNotificationConnections();
    expect(push.kind).toBe("webPush");
    expect(push.events).toBe("");
  });

  it("keeps a script that was switched off as a connection that is off", async () => {
    setSetting("customScriptEnabled", "0");
    setSetting("customScriptPath", "/scripts/off.sh");
    await migrateAgain();
    const [script] = await connections.listNotificationConnections();
    expect(script).toMatchObject({ kind: "customScript", enabled: false, config: { path: "/scripts/off.sh" } });
  });

  it("blanks the credentials of a provider it made a connection from and leaves the rest of its settings where they are", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/w");
    setSetting("discordEvents", "grabbed");
    setSetting("ntfyServerUrl", "https://ntfy.example");
    setSetting("ntfyTopic", "topic");
    setSetting("ntfyToken", "ntfy-tok");
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpTo", "to@example.com");
    setSetting("smtpFrom", "from@example.com");
    setSetting("smtpUsername", "mailer");
    setSetting("smtpPassword", "mail-pass");
    setSetting("smtpEvents", "failed");
    await migrateAgain();

    expect(getSetting("discordWebhookUrl")).toBe("");
    expect(getSetting("ntfyToken")).toBe("");
    expect(getSetting("smtpPassword")).toBe("");
    // The event lists and the settings that are no credential stay.
    expect(getSetting("discordEvents")).toBe("grabbed");
    expect(getSetting("smtpEvents")).toBe("failed");
    expect(getSetting("ntfyServerUrl")).toBe("https://ntfy.example");
    expect(getSetting("ntfyTopic")).toBe("topic");
    expect(getSetting("smtpHost")).toBe("smtp.example");
    expect(getSetting("smtpUsername")).toBe("mailer");
    // The connections hold what was blanked.
    const byKind = new Map((await connections.listNotificationConnections()).map((c) => [c.kind, c]));
    expect(byKind.get("discord")!.config.webhookUrl).toBe("https://discord.example/w");
    expect(byKind.get("email")!.config.password).toBe("mail-pass");
    expect(byKind.get("ntfy")!.config.token).toBe("ntfy-tok");
  });

  // The old keys are what GET /api/settings returns in plain text; a copy left there outlives the connection it became.
  it("leaves no credential of a moved provider in GET /api/settings, in the settings cache or in the database", async () => {
    const secrets: Record<string, string> = {
      discordWebhookUrl: "https://discord.example/api/webhooks/1/secret-discord",
      slackWebhookUrl: "https://hooks.slack.example/services/T/B/secret-slack",
      genericWebhookUrl: "https://hook.example/secret-generic",
      telegramBotToken: "secret-telegram-token",
      pushoverApiToken: "secret-pushover-api",
      pushoverUserKey: "secret-pushover-user",
      ntfyToken: "secret-ntfy-token",
      gotifyToken: "secret-gotify-token",
      matrixAccessToken: "secret-matrix-token",
      twilioAuthToken: "secret-twilio-token",
      smtpPassword: "secret-smtp-password",
    };
    for (const [key, value] of Object.entries(secrets)) setSetting(key, value);
    setSetting("telegramChatId", "chat-9");
    setSetting("pushoverEvents", "grabbed");
    setSetting("ntfyServerUrl", "https://ntfy.example");
    setSetting("ntfyTopic", "topic");
    setSetting("gotifyServerUrl", "https://gotify.example");
    setSetting("matrixHomeserverUrl", "https://matrix.example");
    setSetting("matrixRoomId", "!r:example");
    setSetting("twilioAccountSid", "AC1");
    setSetting("twilioFromNumber", "+1555000");
    setSetting("twilioToNumber", "+1555111");
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpTo", "to@example.com");
    setSetting("smtpFrom", "from@example.com");
    setSetting("customScriptEnabled", "1");
    setSetting("customScriptPath", "/scripts/on.sh");
    expect(await migrateAgain()).toBe(11);

    const text = JSON.stringify((await api.get("/api/settings")).body);
    for (const secret of Object.values(secrets)) expect(text, secret).not.toContain(secret);
    const all = JSON.stringify(getAllSettings());
    for (const secret of Object.values(secrets)) expect(all, secret).not.toContain(secret);
    // What the cache says is what the database holds (the write lands in the background).
    for (const key of Object.keys(secrets)) {
      await vi.waitFor(async () => expect(((await db.prepare("SELECT value FROM settings WHERE key = ?").get(key)) as { value: string }).value, key).toBe(""));
    }
    // What is no credential is still readable.
    expect(getSetting("telegramChatId")).toBe("chat-9");
    expect(getSetting("pushoverEvents")).toBe("grabbed");
    expect(getSetting("customScriptPath")).toBe("/scripts/on.sh");
  });

  it("deleting a connection afterwards leaves nothing behind in the settings", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/api/webhooks/1/leaked-url");
    await migrateAgain();
    const [discord] = await connections.listNotificationConnections();

    expect((await api.del(`/api/notifications/connections/${discord.id}`)).status).toBe(204);

    expect(JSON.stringify((await api.get("/api/settings")).body)).not.toContain("leaked-url");
  });

  it("keeps the SMTP settings of an install that has them only for Send to Kindle (no smtpTo, so no Email connection)", async () => {
    setSetting("smtpHost", "smtp.kindle.example");
    setSetting("smtpFrom", "aonarr@example.com");
    setSetting("smtpUsername", "mailer");
    setSetting("smtpPassword", "kindle-smtp-pass");
    setSetting("discordWebhookUrl", "https://discord.example/w");

    expect(await migrateAgain()).toBe(1);

    expect((await connections.listNotificationConnections()).map((c) => c.kind)).toEqual(["discord"]);
    expect(getSetting("smtpPassword")).toBe("kindle-smtp-pass");
    expect(getSetting("smtpHost")).toBe("smtp.kindle.example");
    expect(getSetting("discordWebhookUrl")).toBe("");
    expect(await connections.kindleSmtpConfig("reader@kindle.example")).toMatchObject({ host: "smtp.kindle.example", username: "mailer", password: "kindle-smtp-pass", to: "reader@kindle.example" });
  });

  it("keeps the credentials of a provider that was only half set up (no connection was made from them)", async () => {
    setSetting("telegramBotToken", "tg-token"); // no chat id
    setSetting("pushoverApiToken", "po-api"); // no user key
    expect(await migrateAgain()).toBe(0);
    expect(getSetting("telegramBotToken")).toBe("tg-token");
    expect(getSetting("pushoverApiToken")).toBe("po-api");
  });

  it("running it again, even with the marker lost, changes no setting", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/w");
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpTo", "to@example.com");
    setSetting("smtpFrom", "from@example.com");
    setSetting("smtpPassword", "mail-pass");
    await migrateAgain();
    const after = JSON.stringify(Object.entries(getAllSettings()).sort());

    expect(await connections.migrateNotificationConnections()).toBe(0);
    setSetting("notificationConnectionsMigrated", "");
    expect(await connections.migrateNotificationConnections()).toBe(0);

    expect(JSON.stringify(Object.entries(getAllSettings()).sort())).toBe(after);
    expect((await connections.listNotificationConnections()).map((c) => c.kind).sort()).toEqual(["discord", "email"]);
  });

  it("finishes the blanking when a run was cut off after the connections were made but before their old keys were blanked", async () => {
    await make("discord", { webhookUrl: "https://discord.example/w" });
    setSetting("discordWebhookUrl", "https://discord.example/w");
    setSetting("notificationConnectionsMigrated", "");

    expect(await connections.migrateNotificationConnections()).toBe(0);

    expect(getSetting("discordWebhookUrl")).toBe("");
    expect(getSetting("notificationConnectionsMigrated")).toBe("1");
    expect((await connections.listNotificationConnections()).length).toBe(1);
  });

  it("run twice adds nothing, even when the marker did not survive", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/w");
    setSetting("slackWebhookUrl", "https://slack.example/w");
    expect(await migrateAgain()).toBe(2);

    expect(await connections.migrateNotificationConnections()).toBe(0);
    expect((await connections.listNotificationConnections()).length).toBe(2);

    setSetting("notificationConnectionsMigrated", ""); // the marker is lost; the rows are there
    expect(await connections.migrateNotificationConnections()).toBe(0);
    expect((await connections.listNotificationConnections()).length).toBe(2);
    expect(getSetting("notificationConnectionsMigrated")).toBe("1");
  });

  it("stops sending from the old settings: only the connections send", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/old");
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Movie", "Release");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores every secret encrypted in the database", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/api/webhooks/1/secret-discord");
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpTo", "to@example.com");
    setSetting("smtpFrom", "from@example.com");
    setSetting("smtpPassword", "mail-pass-secret");
    await migrateAgain();

    const stored = (await db.prepare("SELECT config FROM notification_connections").all()) as { config: string }[];
    const text = stored.map((r) => r.config).join("\n");
    expect(text).not.toContain("secret-discord");
    expect(text).not.toContain("mail-pass-secret");
    expect(text).toContain("enc1:");
    expect(text).toContain("smtp.example"); // what is not a secret stays readable
  });
});

// ---------------------------------------------------------------------------
// the API
// ---------------------------------------------------------------------------

describe("/api/notifications/connections", () => {
  it("lists nothing at first, and the kinds, events and templates the page draws its forms from", async () => {
    expect((await api.get("/api/notifications/connections")).body).toEqual([]);
    const meta = (await api.get("/api/notifications/connections/meta")).body;
    expect(meta.kinds.map((k: any) => k.kind)).toEqual(["discord", "slack", "webhook", "telegram", "pushover", "ntfy", "gotify", "matrix", "twilio", "email", "customScript", "webPush"]);
    expect(meta.events.map((e: any) => e.key)).toHaveLength(13);
    expect(meta.events.filter((e: any) => e.optIn).map((e: any) => e.key)).toEqual(["added", "deleted", "renamed", "fileDeleted"]);
    expect(meta.templates).toHaveLength(13);
    expect(meta.templates.find((t: any) => t.event === "upgraded")).toMatchObject({ key: "notifyTemplateUpgraded", default: "{mediaTitle}\n{fileName}", tokens: ["mediaTitle", "fileName"], value: "" });
  });

  it("requires an admin", async () => {
    expect((await request(app).get("/api/notifications/connections")).status).toBe(401);
  });

  it("creates a connection, answers 201 and never returns a secret", async () => {
    const res = await api.post("/api/notifications/connections", {
      name: "Movies channel",
      kind: "discord",
      config: { webhookUrl: "https://discord.example/api/webhooks/1/super-secret" },
      events: ["grabbed", "added"],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Movies channel", kind: "discord", kindLabel: "Discord", enabled: true, events: ["grabbed", "added"], effectiveEvents: ["grabbed", "added"], tagIds: [] });
    expect(res.body.config).toEqual({ webhookUrl: "********" });
    expect(JSON.stringify(res.body)).not.toContain("super-secret");
    const listed = JSON.stringify((await api.get("/api/notifications/connections")).body);
    expect(listed).not.toContain("super-secret");
  });

  it("a connection with no event list sends the defaults, and says so", async () => {
    const res = await api.post("/api/notifications/connections", { name: "D", kind: "discord", config: { webhookUrl: "https://discord.example/w" } });
    expect(res.body.events).toBeNull();
    expect(res.body.effectiveEvents).toEqual(["grabbed", "imported", "upgraded", "failed", "duplicatesFound", "healthIssue", "healthRestored", "manualInteractionRequired", "updateAvailable"]);
  });

  it("answers 400 with a clear message for an unknown kind, a missing required field, a bad URL and bad events", async () => {
    const unknown = await api.post("/api/notifications/connections", { name: "X", kind: "carrier-pigeon", config: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('Unknown connection kind "carrier-pigeon"');
    expect(unknown.body.error).toContain("discord");

    expect((await api.post("/api/notifications/connections", { name: "X", config: {} })).body.error).toContain("kind is required");

    const missing = await api.post("/api/notifications/connections", { name: "T", kind: "telegram", config: { botToken: "abc123" } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("Telegram: Chat ID is required");

    const noName = await api.post("/api/notifications/connections", { kind: "slack", config: { webhookUrl: "https://slack.example/w" } });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toBe("name is required");

    const badUrl = await api.post("/api/notifications/connections", { name: "S", kind: "slack", config: { webhookUrl: "slack.example/services/SECRET-PATH" } });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error).toBe("Slack: Webhook URL must start with http:// or https://");
    expect(badUrl.body.error).not.toContain("SECRET-PATH");

    const badEvent = await api.post("/api/notifications/connections", { name: "D", kind: "discord", config: { webhookUrl: "https://discord.example/w" }, events: ["grabbed", "exploded"] });
    expect(badEvent.status).toBe(400);
    expect(badEvent.body.error).toContain('Unknown event "exploded"');

    const badPort = await api.post("/api/notifications/connections", { name: "E", kind: "email", config: { host: "h", from: "a@b.c", to: "d@e.f", port: 99999 } });
    expect(badPort.status).toBe(400);
    expect(badPort.body.error).toContain("whole number from 1 to 65535");

    const badTag = await api.post("/api/notifications/connections", { name: "D", kind: "discord", config: { webhookUrl: "https://discord.example/w" }, tagIds: [987654] });
    expect(badTag.status).toBe(400);
    expect(badTag.body.error).toContain("Tag 987654 doesn't exist");

    expect(await connections.listNotificationConnections()).toEqual([]);
  });

  it("validates each kind's required fields", async () => {
    const required: Record<string, Record<string, unknown>> = {
      discord: {},
      slack: {},
      webhook: {},
      telegram: { botToken: "t" },
      pushover: { apiToken: "t" },
      ntfy: { serverUrl: "https://ntfy.example" },
      gotify: { serverUrl: "https://gotify.example" },
      matrix: { homeserverUrl: "https://matrix.example", accessToken: "t" },
      twilio: { accountSid: "AC", authToken: "t", fromNumber: "+1" },
      email: { host: "h", from: "a@b.c" },
      customScript: {},
    };
    for (const [kind, config] of Object.entries(required)) {
      const res = await api.post("/api/notifications/connections", { name: kind, kind, config });
      expect(res.status, kind).toBe(400);
      expect(res.body.error, kind).toMatch(/is required$/);
    }
    // A web push connection has nothing to fill in.
    expect((await api.post("/api/notifications/connections", { name: "Browsers", kind: "webPush" })).status).toBe(201);
  });

  it("masks every secret field in every kind", async () => {
    const created = await api.post("/api/notifications/connections", {
      name: "Hook",
      kind: "webhook",
      config: { url: "https://hook.example/secret-path", username: "bob", password: "hunter22", headers: [{ name: "X-Api-Key", value: "key-12345" }] },
    });
    expect(created.body.config).toMatchObject({ url: "********", username: "bob", password: "********", method: "POST", payloadStyle: "aonarr", headers: [{ name: "X-Api-Key", value: "********" }] });
    const text = JSON.stringify((await api.get("/api/notifications/connections")).body);
    for (const secret of ["secret-path", "hunter22", "key-12345"]) expect(text).not.toContain(secret);
  });

  it("an edit that sends the mask back keeps the stored secret, and one that sends a new value replaces it", async () => {
    const created = (await api.post("/api/notifications/connections", { name: "Chat", kind: "telegram", config: { botToken: "original-token", chatId: "1" } })).body;

    const renamed = await api.put(`/api/notifications/connections/${created.id}`, { name: "Family chat", config: { botToken: "********", chatId: "2" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Family chat", config: { botToken: "********", chatId: "2" } });
    expect((await connections.getNotificationConnection(created.id))!.config).toEqual({ botToken: "original-token", chatId: "2" });

    // A field the request leaves out is kept too.
    await api.put(`/api/notifications/connections/${created.id}`, { config: { chatId: "3" } });
    expect((await connections.getNotificationConnection(created.id))!.config).toEqual({ botToken: "original-token", chatId: "3" });

    await api.put(`/api/notifications/connections/${created.id}`, { config: { botToken: "new-token" } });
    expect((await connections.getNotificationConnection(created.id))!.config.botToken).toBe("new-token");

    // Clearing a required field is refused.
    const cleared = await api.put(`/api/notifications/connections/${created.id}`, { config: { botToken: "" } });
    expect(cleared.status).toBe(400);
    expect((await connections.getNotificationConnection(created.id))!.config.botToken).toBe("new-token");
  });

  it("keeps a header's stored value when the mask comes back for it, and drops a header that is left out", async () => {
    const created = (
      await api.post("/api/notifications/connections", {
        name: "Hook",
        kind: "webhook",
        config: { url: "https://hook.example/x", headers: [{ name: "Authorization", value: "Bearer abcdef" }, { name: "X-Extra", value: "extra-value" }] },
      })
    ).body;

    await api.put(`/api/notifications/connections/${created.id}`, { config: { headers: [{ name: "authorization", value: "********" }, { name: "X-New", value: "new-value" }] } });

    const headers = (await connections.getNotificationConnection(created.id))!.config.headers;
    expect(headers).toEqual([{ name: "authorization", value: "Bearer abcdef" }, { name: "X-New", value: "new-value" }]);
  });

  it("refuses to change a kind, and unknown ids answer 404", async () => {
    const created = (await api.post("/api/notifications/connections", { name: "D", kind: "discord", config: { webhookUrl: "https://discord.example/w" } })).body;
    const res = await api.put(`/api/notifications/connections/${created.id}`, { kind: "slack" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("kind can't be changed");

    expect((await api.put("/api/notifications/connections/99999", { name: "x" })).status).toBe(404);
    expect((await api.del("/api/notifications/connections/99999")).status).toBe(404);
    expect((await api.post("/api/notifications/connections/99999/test")).status).toBe(404);
    expect((await api.put("/api/notifications/connections/abc", { name: "x" })).status).toBe(404);
  });

  it("changes events, tags and enabled, and deletes", async () => {
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('conn-tag')").run()).lastInsertRowid);
    const created = (await api.post("/api/notifications/connections", { name: "D", kind: "discord", config: { webhookUrl: "https://discord.example/w" } })).body;

    const changed = await api.put(`/api/notifications/connections/${created.id}`, { events: ["failed"], tagIds: [tagId], enabled: false });
    expect(changed.body).toMatchObject({ events: ["failed"], effectiveEvents: ["failed"], tagIds: [tagId], enabled: false });

    const back = await api.put(`/api/notifications/connections/${created.id}`, { events: null, tagIds: [] });
    expect(back.body).toMatchObject({ events: null, tagIds: [] });

    expect((await api.del(`/api/notifications/connections/${created.id}`)).status).toBe(204);
    expect((await api.get("/api/notifications/connections")).body).toEqual([]);
  });

  describe("the audit log", () => {
    const auditRows = async (eventType: string) =>
      (await db.prepare("SELECT detail FROM audit_log WHERE event_type = ? ORDER BY id").all(eventType)) as { detail: string }[];

    beforeEach(async () => {
      await db.prepare("DELETE FROM audit_log WHERE event_type LIKE 'notification_connection_%'").run();
    });

    it("records an edit with the names of the fields it changed and never a value", async () => {
      const created = (await api.post("/api/notifications/connections", { name: "Runner", kind: "customScript", config: { path: "/scripts/old-secret-name.sh" } })).body;
      expect((await api.put(`/api/notifications/connections/${created.id}`, { config: { path: "/scripts/new-secret-name.sh" } })).status).toBe(200);

      await vi.waitFor(async () => expect(await auditRows("notification_connection_updated")).toHaveLength(1));
      const [row] = await auditRows("notification_connection_updated");
      expect(row.detail).toBe("Runner (customScript): config.path");
      expect(row.detail).not.toContain("secret-name");
    });

    it("lists every field a single edit changed, and a secret kept as the mask is not one of them", async () => {
      const tag = Number((await db.prepare("INSERT INTO tags (name) VALUES ('audit-tag')").run()).lastInsertRowid);
      const created = (await api.post("/api/notifications/connections", { name: "Chat", kind: "telegram", config: { botToken: "audit-token-1", chatId: "1" } })).body;

      await api.put(`/api/notifications/connections/${created.id}`, {
        name: "Family chat",
        config: { botToken: "********", chatId: "2" },
        events: ["failed"],
        tagIds: [tag],
        enabled: false,
      });

      await vi.waitFor(async () => expect(await auditRows("notification_connection_updated")).toHaveLength(1));
      const [row] = await auditRows("notification_connection_updated");
      expect(row.detail).toBe("Family chat (telegram): name, events, tags, enabled, config.chatId");
      expect(row.detail).not.toContain("audit-token-1");
    });

    it("names a changed secret field but not its value", async () => {
      const created = (await api.post("/api/notifications/connections", { name: "Hook", kind: "discord", config: { webhookUrl: "https://discord.example/api/webhooks/1/audit-secret-a" } })).body;
      await api.put(`/api/notifications/connections/${created.id}`, { config: { webhookUrl: "https://discord.example/api/webhooks/1/audit-secret-b" } });

      await vi.waitFor(async () => expect(await auditRows("notification_connection_updated")).toHaveLength(1));
      const [row] = await auditRows("notification_connection_updated");
      expect(row.detail).toBe("Hook (discord): config.webhookUrl");
    });

    it("an edit that changes nothing is not an audit event, and add and remove still are", async () => {
      const created = (await api.post("/api/notifications/connections", { name: "Hook", kind: "discord", config: { webhookUrl: "https://discord.example/w" } })).body;
      await api.put(`/api/notifications/connections/${created.id}`, { name: "Hook", config: { webhookUrl: "********" }, enabled: true });
      await api.del(`/api/notifications/connections/${created.id}`);

      await vi.waitFor(async () => expect(await auditRows("notification_connection_removed")).toHaveLength(1));
      expect(await auditRows("notification_connection_added")).toEqual([{ detail: "Hook (discord)" }]);
      expect(await auditRows("notification_connection_updated")).toEqual([]);
    });
  });

  it("an event list saved empty stays empty (no events), not 'the defaults'", async () => {
    const created = (await api.post("/api/notifications/connections", { name: "Quiet", kind: "discord", config: { webhookUrl: "https://discord.example/w" }, events: [] })).body;
    expect(created.events).toEqual([]);
    expect(created.effectiveEvents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------

describe("sending to several connections", () => {
  it("two Discord connections get their own events", async () => {
    await make("discord", { webhookUrl: "https://discord.example/movies" }, { name: "Movies", events: "grabbed,imported" });
    await make("discord", { webhookUrl: "https://discord.example/problems" }, { name: "Problems", events: "failed,healthIssue" });
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Heat", "Heat.1995.1080p");
    expect(urls(fetchMock)).toEqual(["https://discord.example/movies"]);

    fetchMock.mockClear();
    await notifications.notifyFailed("Heat", "no seeders");
    expect(urls(fetchMock)).toEqual(["https://discord.example/problems"]);
    expect(bodyOf(fetchMock.mock.calls[0]).embeds[0].title).toBe("Failed");

    fetchMock.mockClear();
    await notifications.notifyHealthIssue("Indexer down");
    expect(urls(fetchMock)).toEqual(["https://discord.example/problems"]);
  });

  it("a connection that is switched off is not sent to, and the others still are", async () => {
    await make("discord", { webhookUrl: "https://discord.example/on" });
    await make("discord", { webhookUrl: "https://discord.example/off" }, { enabled: false });
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("X", "Y");

    expect(urls(fetchMock)).toEqual(["https://discord.example/on"]);
  });

  it("sends to every matching connection at once, each with its own timeout, and one failing does not stop the rest", async () => {
    await make("discord", { webhookUrl: "https://discord.example/a" });
    await make("slack", { webhookUrl: "https://slack.example/b" });
    await make("telegram", { botToken: "tg-tok", chatId: "7" });
    const releases: (() => void)[] = [];
    const signals: unknown[] = [];
    const fetchMock = vi.fn((url: string, init?: any) => {
      signals.push(init.signal);
      if (String(url).includes("discord")) return Promise.resolve({ ok: false, status: 500 });
      return new Promise((resolve) => releases.push(() => resolve({ ok: true, status: 200 })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = notifications.notifyGrabbed("X", "Y");
    // All three requests are out before any of the others has answered: they run in parallel.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    releases.forEach((release) => release());
    await expect(pending).resolves.toBeUndefined();
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("a connection scoped to tags hears only of titles that carry one of them; an untagged connection hears of everything", async () => {
    const kids = Number((await db.prepare("INSERT INTO tags (name) VALUES ('kids-n')").run()).lastInsertRowid);
    const adult = Number((await db.prepare("INSERT INTO tags (name) VALUES ('adult-n')").run()).lastInsertRowid);
    const tagged = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Kid Film', 'kid film')").run()).lastInsertRowid);
    const plain = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title) VALUES ('movie', 'Plain Film', 'plain film')").run()).lastInsertRowid);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(tagged, kids);
    // "deleted" is one of the events a connection gets only when its list names it.
    const events = "grabbed,imported,failed,deleted";
    await make("discord", { webhookUrl: "https://discord.example/kids" }, { name: "Kids", tagIds: [kids], events });
    await make("discord", { webhookUrl: "https://discord.example/adult" }, { name: "Adult", tagIds: [adult], events });
    await make("discord", { webhookUrl: "https://discord.example/everything" }, { name: "Everything", events });
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Kid Film", "Kid.Film.1080p", { mediaItemId: tagged });
    expect(urls(fetchMock).sort()).toEqual(["https://discord.example/everything", "https://discord.example/kids"]);

    fetchMock.mockClear();
    await notifications.notifyImported("Plain Film", "plain.mkv", undefined, { mediaItemId: plain });
    expect(urls(fetchMock)).toEqual(["https://discord.example/everything"]);

    // Tags the caller already has win (a title that is being deleted has no row left to ask).
    fetchMock.mockClear();
    await notifications.notifyDeleted("Gone Film", "movie", false, { tagIds: [adult] });
    expect(urls(fetchMock).sort()).toEqual(["https://discord.example/adult", "https://discord.example/everything"]);

    // A title event with no title given reaches only the connections that are not scoped.
    fetchMock.mockClear();
    await notifications.notifyFailed("Mystery", "boom");
    expect(urls(fetchMock)).toEqual(["https://discord.example/everything"]);
  });

  it("events that are about the instance, not a title, ignore tags", async () => {
    const tag = Number((await db.prepare("INSERT INTO tags (name) VALUES ('inst-tag')").run()).lastInsertRowid);
    await make("discord", { webhookUrl: "https://discord.example/tagged" }, { tagIds: [tag] });
    const fetchMock = stubFetch();

    await notifications.notifyHealthIssue("Disk is full");
    await notifications.notifyUpdateAvailable("v2");
    await notifications.notifyDuplicatesFound(1, ["A"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends every kind of connection its own way", async () => {
    await make("slack", { webhookUrl: "https://slack.example/w" });
    await make("telegram", { botToken: "tg-tok", chatId: "7" });
    await make("pushover", { apiToken: "po-api", userKey: "po-user" });
    await make("ntfy", { serverUrl: "https://ntfy.example", topic: "t", token: "ntfy-tok" });
    await make("gotify", { serverUrl: "https://gotify.example", token: "got-tok" });
    await make("matrix", { homeserverUrl: "https://matrix.example/", accessToken: "mx-tok", roomId: "!r:example" });
    await make("twilio", { accountSid: "AC1", authToken: "tw-tok", fromNumber: "+1", toNumber: "+2" });
    await make("email", { host: "smtp.example", from: "a@b.c", to: "d@e.f", port: 465, secure: true, username: "u", password: "p" });
    await make("customScript", { path: "/scripts/on.sh" });
    await make("webPush", {});
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Movie", "Rel");

    const sent = urls(fetchMock).sort();
    expect(sent).toHaveLength(7);
    expect(sent.filter((u) => u.startsWith("https://slack.example"))).toHaveLength(1);
    expect(sent).toContain("https://api.telegram.org/bottg-tok/sendMessage");
    expect(sent).toContain("https://api.pushover.net/1/messages.json");
    expect(sent).toContain("https://ntfy.example/t");
    expect(sent).toContain("https://gotify.example/message");
    expect(sent.some((u) => u.startsWith("https://matrix.example/_matrix/client/v3/rooms/!r%3Aexample/send/m.room.message/"))).toBe(true);
    expect(sent).toContain("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(sendEmail).toHaveBeenCalledWith({ host: "smtp.example", port: 465, secure: true, username: "u", password: "p", from: "a@b.c", to: "d@e.f" }, "AoNarr: Grabbed", "Movie\nRel");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect((execFileMock.mock.calls[0][2] as any).env.AONARR_MEDIA_TITLE).toBe("Movie");
    expect(sendPush).toHaveBeenCalledWith("Grabbed", "Movie\nRel");
  });

  it("does not break the caller when the connections cannot be read", async () => {
    const spy = vi.spyOn(connections, "listNotificationConnections").mockRejectedValue(new Error("db gone"));
    try {
      await expect(notifications.notifyGrabbed("X", "Y")).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Health, per connection
// ---------------------------------------------------------------------------

describe("failing connections (Health)", () => {
  it("reports two Discord connections separately, by name", async () => {
    const movies = await make("discord", { webhookUrl: "https://discord.example/movies" }, { name: "Movies" });
    const shows = await make("discord", { webhookUrl: "https://discord.example/shows" }, { name: "Shows" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("movies") ? { ok: false, status: 500 } : { ok: true, status: 200 })));

    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");

    const failing = notifications.failingNotificationProviders();
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ connectionId: movies.id, kind: "discord", provider: "Movies (Discord)", failures: 2, lastError: "Webhook POST to discord.example failed: HTTP 500" });
    expect(failing.map((f) => f.connectionId)).not.toContain(shows.id);
  });

  it("a name that already says the kind is not repeated", async () => {
    await make("discord", { webhookUrl: "https://discord.example/x" }, { name: "Discord alerts" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    expect(notifications.failingNotificationProviders()[0].provider).toBe("Discord alerts");
  });

  it("a success clears that connection and only it", async () => {
    const a = await make("discord", { webhookUrl: "https://discord.example/a" }, { name: "A" });
    const b = await make("discord", { webhookUrl: "https://discord.example/b" }, { name: "B" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    expect(notifications.failingNotificationProviders().map((f) => f.connectionId).sort()).toEqual([a.id, b.id].sort());

    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).endsWith("/a") ? { ok: true, status: 200 } : { ok: false, status: 500 })));
    await notifications.notifyGrabbed("X", "Y");

    expect(notifications.failingNotificationProviders(1).map((f) => f.connectionId)).toEqual([b.id]);
  });

  it("a deleted or disabled connection stops being reported", async () => {
    const gone = await make("discord", { webhookUrl: "https://discord.example/gone" }, { name: "Gone" });
    const off = await make("slack", { webhookUrl: "https://slack.example/off" }, { name: "Off" });
    const stays = await make("gotify", { serverUrl: "https://gotify.example", token: "tok-1234" }, { name: "Stays" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    expect(notifications.failingNotificationProviders()).toHaveLength(3);

    expect((await api.del(`/api/notifications/connections/${gone.id}`)).status).toBe(204);
    await api.put(`/api/notifications/connections/${off.id}`, { enabled: false });

    expect(notifications.failingNotificationProviders().map((f) => f.connectionId)).toEqual([stays.id]);
  });

  it("fixing a connection's address or credentials lifts its warning at once", async () => {
    const conn = await make("discord", { webhookUrl: "https://discord.example/bad" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    expect(notifications.failingNotificationProviders()).toHaveLength(1);

    await api.put(`/api/notifications/connections/${conn.id}`, { config: { webhookUrl: "https://discord.example/fixed" } });

    expect(notifications.failingNotificationProviders(1)).toEqual([]);
  });

  describe("a send that is still out when its connection changes", () => {
    /** A fetch that answers only when the test says so, so a connection can be changed while its send is in flight. */
    function heldFetch() {
      const waiting: ((answer: { ok: boolean; status: number }) => void)[] = [];
      const fetchMock = vi.fn(() => new Promise<{ ok: boolean; status: number }>((resolve) => waiting.push(resolve)));
      vi.stubGlobal("fetch", fetchMock);
      return { fetchMock, answer: (status: number) => waiting.splice(0).forEach((resolve) => resolve({ ok: status < 400, status })) };
    }

    it("a deleted connection does not come back into Health when its send fails afterwards", async () => {
      const gone = await make("discord", { webhookUrl: "https://discord.example/gone" }, { name: "Gone" });
      const stays = await make("slack", { webhookUrl: "https://slack.example/stays" }, { name: "Stays" });
      const held = heldFetch();

      const pending = notifications.notifyGrabbed("X", "Y");
      await vi.waitFor(() => expect(held.fetchMock).toHaveBeenCalledTimes(2));
      expect((await api.del(`/api/notifications/connections/${gone.id}`)).status).toBe(204);
      held.answer(500);
      await pending;

      // The one that is still there is reported (so the failure path works); the deleted one is not.
      expect(notifications.failingNotificationProviders(1).map((f) => f.connectionId)).toEqual([stays.id]);
    });

    it("a connection switched off meanwhile does not come back into Health either", async () => {
      const off = await make("discord", { webhookUrl: "https://discord.example/off" }, { name: "Off" });
      const held = heldFetch();

      const pending = notifications.notifyGrabbed("X", "Y");
      await vi.waitFor(() => expect(held.fetchMock).toHaveBeenCalledTimes(1));
      await api.put(`/api/notifications/connections/${off.id}`, { enabled: false });
      held.answer(500);
      await pending;

      expect(notifications.failingNotificationProviders(1)).toEqual([]);
    });

    it("a connection whose address was fixed meanwhile does not get the old address's failure", async () => {
      const conn = await make("discord", { webhookUrl: "https://discord.example/bad" });
      const held = heldFetch();

      const pending = notifications.notifyGrabbed("X", "Y");
      await vi.waitFor(() => expect(held.fetchMock).toHaveBeenCalledTimes(1));
      await api.put(`/api/notifications/connections/${conn.id}`, { config: { webhookUrl: "https://discord.example/fixed" } });
      held.answer(500);
      await pending;

      expect(notifications.failingNotificationProviders(1)).toEqual([]);
    });

    it("a send that starts after the connection is switched back on is reported as usual", async () => {
      const conn = await make("discord", { webhookUrl: "https://discord.example/x" });
      await api.put(`/api/notifications/connections/${conn.id}`, { enabled: false });
      await api.put(`/api/notifications/connections/${conn.id}`, { enabled: true });
      stubFetch(500);

      await notifications.notifyGrabbed("X", "Y");
      await notifications.notifyGrabbed("X", "Y");

      expect(notifications.failingNotificationProviders().map((f) => f.connectionId)).toEqual([conn.id]);
    });
  });

  it("shows up in the health report as its own issue, named, and goes away with the connection", async () => {
    const { getHealthReport, clearHealthReportCache } = await import("../src/services/healthReport.js");
    const conn = await make("discord", { webhookUrl: "https://discord.example/x" }, { name: "Movies" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    // The health probes (indexers, clients, update checks) all fail fast and offline.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    clearHealthReportCache();
    const issues = (await getHealthReport({ refresh: true })).issues.filter((i) => i.source.startsWith("notification:"));
    expect(issues).toHaveLength(1);
    expect(issues[0].source).toBe(`notification:${conn.id}`);
    expect(issues[0].message).toMatch(/^Notifications to Movies \(Discord\) have failed 2 times in a row since /);

    await api.del(`/api/notifications/connections/${conn.id}`);
    clearHealthReportCache();
    expect((await getHealthReport({ refresh: true })).issues.filter((i) => i.source.startsWith("notification:"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the Test button
// ---------------------------------------------------------------------------

describe("POST /api/notifications/connections/:id/test", () => {
  it("sends the fixed test message to that one connection whatever its events and tags say", async () => {
    const tag = Number((await db.prepare("INSERT INTO tags (name) VALUES ('test-tag')").run()).lastInsertRowid);
    const conn = await make("discord", { webhookUrl: "https://discord.example/t" }, { events: "", tagIds: [tag] });
    await make("discord", { webhookUrl: "https://discord.example/other" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    // The first connection hears of nothing (no events), the other fails twice.
    expect(notifications.failingNotificationProviders()).toHaveLength(1);

    const fetchMock = stubFetch();
    const res = await api.post(`/api/notifications/connections/${conn.id}/test`);

    expect(res.body).toEqual({ ok: true });
    expect(urls(fetchMock)).toEqual(["https://discord.example/t"]);
    expect(bodyOf(fetchMock.mock.calls[0]).embeds[0]).toMatchObject({ title: "AoNarr test notification", description: "If you're seeing this, this connection is configured correctly." });
  });

  it("lifts a connection's Health warning on success and leaves it on failure", async () => {
    const conn = await make("slack", { webhookUrl: "https://slack.example/hook" });
    stubFetch(500);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");

    const failed = await api.post(`/api/notifications/connections/${conn.id}/test`);
    expect(failed.body.ok).toBe(false);
    expect(notifications.failingNotificationProviders()[0].failures).toBe(2); // a test is not one more failed send

    stubFetch(200);
    expect((await api.post(`/api/notifications/connections/${conn.id}/test`)).body).toEqual({ ok: true });
    expect(notifications.failingNotificationProviders(1)).toEqual([]);
  });

  it("answers an error that names the host and carries neither a secret nor the full URL", async () => {
    const discord = await make("discord", { webhookUrl: "https://discord.example/api/webhooks/123/super-secret-token" });
    const telegram = await make("telegram", { botToken: "bot-secret-9999", chatId: "1" });
    const gotify = await make("gotify", { serverUrl: "https://gotify.example", token: "gotify-secret-token" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 })));

    for (const [conn, secret] of [[discord, "super-secret-token"], [telegram, "bot-secret-9999"], [gotify, "gotify-secret-token"]] as const) {
      const res = await api.post(`/api/notifications/connections/${conn.id}/test`);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("HTTP 429");
      expect(res.body.error).not.toContain(secret);
      expect(res.body.error).not.toContain("/api/webhooks/");
    }
    expect((await api.post(`/api/notifications/connections/${discord.id}/test`)).body.error).toContain("discord.example");
  });

  it("scrubs a secret that an underlying error message happens to carry", async () => {
    const conn = await make("pushover", { apiToken: "po-api-token-xyz", userKey: "po-user-key-abc" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up while sending token po-api-token-xyz for po-user-key-abc"); }));

    const res = await api.post(`/api/notifications/connections/${conn.id}/test`);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("socket hang up while sending token [hidden] for [hidden]");
  });

  it("a script failure and a web push test work through the same button", async () => {
    const script = await make("customScript", { path: "/scripts/on.sh" });
    const push = await make("webPush", {});

    expect((await api.post(`/api/notifications/connections/${script.id}/test`)).body).toEqual({ ok: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    execFileError = new Error("exit 1");
    expect((await api.post(`/api/notifications/connections/${script.id}/test`)).body).toEqual({ ok: false, error: "Custom script failed: exit 1" });
    expect((await api.post(`/api/notifications/connections/${push.id}/test`)).body).toEqual({ ok: true });
    expect(sendPush).toHaveBeenCalledWith("AoNarr test notification", expect.any(String));
  });

  it("the old test endpoint by provider key tests the first connection of that kind, and says so when there is none", async () => {
    const missing = await api.post("/api/settings/notifications/discord/test");
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error).toBe("There is no Discord connection yet. Add one under Settings > Notifications.");
    expect((await api.post("/api/settings/notifications/carrier-pigeon/test")).body.error).toBe('Unknown notification provider "carrier-pigeon"');

    await make("webhook", { url: "https://hook.example/first" }, { name: "First" });
    await make("webhook", { url: "https://hook.example/second" }, { name: "Second" });
    const fetchMock = stubFetch();
    expect((await api.post("/api/settings/notifications/generic/test")).body).toEqual({ ok: true });
    expect(urls(fetchMock)).toEqual(["https://hook.example/first"]);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ event: "test", title: "AoNarr test notification", text: "If you're seeing this, this connection is configured correctly." });

    await make("email", { host: "smtp.example", from: "a@b.c", to: "d@e.f" });
    await make("webPush", {});
    expect((await api.post("/api/settings/notifications/smtp/test")).body).toEqual({ ok: true });
    expect((await api.post("/api/settings/notifications/push/test")).body).toEqual({ ok: true });
  });

  it("a connection whose secret can't be read says what is missing instead of failing oddly", async () => {
    const conn = await make("telegram", { botToken: "tg-token", chatId: "1" });
    await db.prepare("UPDATE notification_connections SET config = ? WHERE id = ?").run(JSON.stringify({ botToken: "enc1:not-a-real-ciphertext", chatId: "1" }), conn.id);
    stubFetch();

    const res = await api.post(`/api/notifications/connections/${conn.id}/test`);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("has no Bot token");
  });
});

// ---------------------------------------------------------------------------
// the webhook kind
// ---------------------------------------------------------------------------

describe("the webhook kind", () => {
  it("POSTs AoNarr's own payload by default, as JSON", async () => {
    await make("webhook", { url: "https://hook.example/x" });
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Heat", "Heat.1995");

    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://hook.example/x");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ event: "grabbed", mediaTitle: "Heat", releaseTitle: "Heat.1995" });
  });

  it("can PUT, and sends extra headers and basic auth", async () => {
    await make("webhook", {
      url: "https://hook.example/x",
      method: "PUT",
      username: "bob",
      password: "hunter22",
      headers: [{ name: "X-Api-Key", value: "key-1" }, { name: "content-type", value: "application/vnd.aonarr+json" }],
    });
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Heat", "Heat.1995");

    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({
      "content-type": "application/vnd.aonarr+json",
      "X-Api-Key": "key-1",
      Authorization: `Basic ${Buffer.from("bob:hunter22").toString("base64")}`,
    });
  });

  it("a header the admin sets for Authorization wins over basic auth", async () => {
    await make("webhook", { url: "https://hook.example/x", username: "bob", password: "pw", headers: [{ name: "Authorization", value: "Bearer abc" }] });
    const fetchMock = stubFetch();

    await notifications.notifyGrabbed("Heat", "Heat.1995");

    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer abc");
  });

  it("refuses a method other than POST or PUT, and headers AoNarr sets itself", async () => {
    const method = await api.post("/api/notifications/connections", { name: "H", kind: "webhook", config: { url: "https://hook.example/x", method: "DELETE" } });
    expect(method.status).toBe(400);
    expect(method.body.error).toBe("Webhook: Method must be one of: POST, PUT");
    const header = await api.post("/api/notifications/connections", { name: "H", kind: "webhook", config: { url: "https://hook.example/x", headers: [{ name: "Content-Length", value: "1" }] } });
    expect(header.status).toBe(400);
    expect(header.body.error).toContain("Content-Length");
    const injected = await api.post("/api/notifications/connections", { name: "H", kind: "webhook", config: { url: "https://hook.example/x", headers: [{ name: "X-A", value: "a\r\nX-B: b" }] } });
    expect(injected.status).toBe(400);
    expect(injected.body.error).toContain("line break");
  });

  it("an error on a PUT names the method and the host only", async () => {
    await make("webhook", { url: "https://hook.example/very/secret/path", method: "PUT" });
    stubFetch(502);
    await notifications.notifyGrabbed("X", "Y");
    await notifications.notifyGrabbed("X", "Y");
    expect(notifications.failingNotificationProviders()[0].lastError).toBe("Webhook PUT to hook.example failed: HTTP 502");
  });

  describe("the Sonarr/Radarr payload style", () => {
    let movieId: number;
    let showId: number;
    let episodeId: number;

    beforeEach(async () => {
      await db.prepare("DELETE FROM media_items WHERE title IN ('Heat', 'The Wire')").run();
      movieId = Number(
        (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, path, external_ids, release_date) VALUES ('movie', 'Heat', 'heat', 1995, '/movies/Heat (1995)/Heat (1995).mkv', ?, '1995-12-15')").run(JSON.stringify({ tmdb: "949", imdb: "tt0113277" }))).lastInsertRowid
      );
      showId = Number(
        (await db.prepare("INSERT INTO media_items (type, title, sort_title, year, path, external_ids) VALUES ('series', 'The Wire', 'wire', 2002, '/tv/The Wire', ?)").run(JSON.stringify({ tvdb: "79126", imdb: "tt0306414", tmdb: "1438" }))).lastInsertRowid
      );
      episodeId = Number((await db.prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date) VALUES (?, 1, 1, 'The Target', '2002-06-02')").run(showId)).lastInsertRowid);
      await make("webhook", { url: "https://hook.example/starr", payloadStyle: "starr" }, { events: "grabbed,imported,upgraded,failed,manualInteractionRequired,healthIssue,healthRestored,updateAvailable,added,deleted,renamed,fileDeleted,duplicatesFound" });
    });

    async function sent(run: () => Promise<void>): Promise<any> {
      const fetchMock = stubFetch();
      await run();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      return bodyOf(fetchMock.mock.calls[0]);
    }

    it("Grab: the release, the client and the movie, with ids and a folder", async () => {
      const body = await sent(() =>
        notifications.notifyGrabbed("Heat", "Heat.1995.1080p.BluRay-GRP", {
          mediaItemId: movieId,
          release: { title: "Heat.1995.1080p.BluRay-GRP", indexer: "Indexer A", size: 123456, quality: "Bluray-1080p", releaseGroup: "GRP", protocol: "torrent" },
          downloadClient: { name: "qBit", type: "qbittorrent", downloadId: "ABC123" },
        })
      );

      expect(body).toEqual({
        eventType: "Grab",
        movie: { id: movieId, title: "Heat", year: 1995, releaseDate: "1995-12-15", folderPath: "/movies/Heat (1995)", tmdbId: 949, imdbId: "tt0113277" },
        release: { quality: "Bluray-1080p", releaseGroup: "GRP", releaseTitle: "Heat.1995.1080p.BluRay-GRP", indexer: "Indexer A", size: 123456 },
        downloadClient: "qBit",
        downloadClientType: "qbittorrent",
        downloadId: "ABC123",
        instanceName: "AoNarr",
        applicationUrl: "",
      });
    });

    it("Grab for a series names the series and the episode", async () => {
      const body = await sent(() => notifications.notifyGrabbed("The Wire", "The.Wire.S01E01", { mediaItemId: showId, episodeIds: [episodeId] }));

      expect(body.eventType).toBe("Grab");
      expect(body.series).toEqual({ id: showId, title: "The Wire", titleSlug: "the-wire", path: "/tv/The Wire", tvdbId: 79126, tmdbId: 1438, imdbId: "tt0306414", type: "standard", year: 2002 });
      expect(body.episodes).toEqual([{ id: episodeId, seasonNumber: 1, episodeNumber: 1, title: "The Target", airDate: "2002-06-02", seriesId: showId }]);
      expect(body.movie).toBeUndefined();
    });

    it("Download (and Download with isUpgrade) carries the file", async () => {
      const file = { path: "/movies/Heat (1995)/Heat (1995).mkv", size: 5000, quality: "Bluray-1080p", releaseGroup: "GRP", sceneName: "Heat.1995.1080p.BluRay-GRP" };
      const imported = await sent(() => notifications.notifyImported("Heat", "Heat (1995).mkv", undefined, { mediaItemId: movieId, file }));
      expect(imported).toMatchObject({ eventType: "Download", isUpgrade: false, movieFile: { relativePath: "Heat (1995).mkv", path: file.path, quality: "Bluray-1080p", releaseGroup: "GRP", sceneName: file.sceneName, size: 5000 } });

      const upgraded = await sent(() => notifications.notifyUpgraded("Heat", "Heat (1995).mkv", undefined, { mediaItemId: movieId, file }));
      expect(upgraded).toMatchObject({ eventType: "Download", isUpgrade: true });

      const episode = await sent(() => notifications.notifyImported("The Wire", "ep.mkv", undefined, { mediaItemId: showId, episodeIds: [episodeId], file: { path: "/tv/The Wire/Season 01/ep.mkv" } }));
      expect(episode.episodeFile).toEqual({ relativePath: "Season 01/ep.mkv", path: "/tv/The Wire/Season 01/ep.mkv" });
      expect(episode.series.title).toBe("The Wire");
    });

    it("Rename lists the files that moved", async () => {
      const body = await sent(() => notifications.notifyRenamed("The Wire", 1, { mediaItemId: showId, renamed: [{ from: "/tv/The Wire/old.mkv", to: "/tv/The Wire/Season 01/new.mkv" }] }));
      expect(body.eventType).toBe("Rename");
      expect(body.renamedEpisodeFiles).toEqual([{ relativePath: "Season 01/new.mkv", path: "/tv/The Wire/Season 01/new.mkv", previousRelativePath: "old.mkv", previousPath: "/tv/The Wire/old.mkv" }]);
    });

    it("SeriesAdd, MovieAdded, SeriesDelete, MovieDelete, EpisodeFileDelete and MovieFileDelete", async () => {
      expect((await sent(() => notifications.notifyAdded("The Wire", "series", { mediaItemId: showId }))).eventType).toBe("SeriesAdd");
      expect((await sent(() => notifications.notifyAdded("Heat", "movie", { mediaItemId: movieId }))).eventType).toBe("MovieAdded");

      // A deleted title has no row to look up: the context carries it.
      const media = { id: 77, type: "series", title: "Gone Show", year: 2001, path: "/tv/Gone Show", externalIds: { tvdb: "5" } };
      const deletedSeries = await sent(() => notifications.notifyDeleted("Gone Show", "series", true, { tagIds: [], media }));
      expect(deletedSeries).toMatchObject({ eventType: "SeriesDelete", deletedFiles: true, series: { id: 77, title: "Gone Show", tvdbId: 5 } });
      const deletedMovie = await sent(() => notifications.notifyDeleted("Gone", "movie", false, { tagIds: [], media: { id: 78, type: "movie", title: "Gone", year: 2000 } }));
      expect(deletedMovie).toMatchObject({ eventType: "MovieDelete", deletedFiles: false, movie: { id: 78, title: "Gone", year: 2000 } });

      const fileDeletedEpisode = await sent(() => notifications.notifyFileDeleted("The Wire", "ep.mkv", { mediaItemId: showId, episodeIds: [episodeId], file: { path: "/tv/The Wire/ep.mkv" } }));
      expect(fileDeletedEpisode).toMatchObject({ eventType: "EpisodeFileDelete", deleteReason: "manual", episodeFile: { relativePath: "ep.mkv" } });
      const fileDeletedMovie = await sent(() => notifications.notifyFileDeleted("Heat", "Heat (1995).mkv", { mediaItemId: movieId, file: { path: "/movies/Heat (1995)/Heat (1995).mkv" } }));
      expect(fileDeletedMovie).toMatchObject({ eventType: "MovieFileDelete", movieFile: { relativePath: "Heat (1995).mkv" } });
    });

    it("Health, HealthRestored, ApplicationUpdate, ManualInteractionRequired and the failure event", async () => {
      expect(await sent(() => notifications.notifyHealthIssue("Indexer down", { health: { level: "error", types: ["indexer:1"] } }))).toMatchObject({ eventType: "Health", level: "error", message: "Indexer down", type: "indexer:1" });
      expect(await sent(() => notifications.notifyHealthIssue("Two things"))).toMatchObject({ eventType: "Health", level: "warning", message: "Two things" });
      expect(await sent(() => notifications.notifyHealthRestored("Indexer down"))).toMatchObject({ eventType: "HealthRestored", message: "Indexer down" });
      expect(await sent(() => notifications.notifyUpdateAvailable("Round 400"))).toMatchObject({ eventType: "ApplicationUpdate", message: "Round 400" });
      const manual = await sent(() => notifications.notifyManualInteractionRequired("Heat", "files could not be matched", { mediaItemId: movieId, downloadClient: { downloadId: "DL1" } }));
      expect(manual).toMatchObject({ eventType: "ManualInteractionRequired", movie: { title: "Heat" }, downloadId: "DL1", downloadInfo: { statusMessages: [{ title: "Manual interaction required", messages: ["files could not be matched"] }] } });
      expect(await sent(() => notifications.notifyFailed("Heat", "no seeders", { mediaItemId: movieId }))).toMatchObject({ eventType: "DownloadFailure", message: "no seeders", movie: { title: "Heat" } });
      expect(await sent(() => notifications.notifyDuplicatesFound(2, ["A", "B"]))).toMatchObject({ eventType: "DuplicatesFound", count: 2, titles: ["A", "B"] });
    });

    it("leaves a field out rather than inventing it", async () => {
      const body = await sent(() => notifications.notifyGrabbed("Heat", "Heat.1995", { mediaItemId: movieId }));
      expect(body.release).toEqual({ releaseTitle: "Heat.1995" });
      expect(body).not.toHaveProperty("downloadClient");
      expect(body).not.toHaveProperty("downloadId");
      expect(body).not.toHaveProperty("episodes");
      const noTitle = await sent(() => notifications.notifyGrabbed("Heat", "Heat.1995"));
      expect(noTitle).not.toHaveProperty("movie");
      expect(noTitle).not.toHaveProperty("series");
    });

    it("a library Sonarr and Radarr have no word for gets a plain media object", async () => {
      const bookId = Number((await db.prepare("INSERT INTO media_items (type, title, sort_title, path) VALUES ('author', 'Some Author', 'some author', '/books/Some Author')").run()).lastInsertRowid);
      const body = await sent(() => notifications.notifyAdded("Some Author", "author", { mediaItemId: bookId }));
      expect(body.media).toMatchObject({ id: bookId, type: "author", title: "Some Author", path: "/books/Some Author" });
    });

    it("the Test button sends Sonarr's test body", async () => {
      const conn = (await connections.listNotificationConnections()).find((c) => c.config.payloadStyle === "starr")!;
      const fetchMock = stubFetch();
      expect((await api.post(`/api/notifications/connections/${conn.id}/test`)).body).toEqual({ ok: true });
      expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ eventType: "Test", series: { title: "Test Title" } });
    });

    it("uses the external URL setting for applicationUrl", async () => {
      setSetting("externalUrl", "https://aonarr.example.com/");
      try {
        const body = await sent(() => notifications.notifyUpdateAvailable("x"));
        expect(body.applicationUrl).toBe("https://aonarr.example.com");
      } finally {
        deleteSetting("externalUrl");
      }
    });

    it("puts the URL base after the external URL in applicationUrl, like every other link the server hands out", async () => {
      setSetting("externalUrl", "https://aonarr.example.com/");
      process.env.URL_BASE = "/aonarr";
      try {
        expect((await sent(() => notifications.notifyUpdateAvailable("x"))).applicationUrl).toBe("https://aonarr.example.com/aonarr");

        // An External URL that already ends with the base (typed before the base existed) is not given it twice.
        setSetting("externalUrl", "https://media.example.com/aonarr");
        expect((await sent(() => notifications.notifyUpdateAvailable("x"))).applicationUrl).toBe("https://media.example.com/aonarr");

        // No External URL: nothing, not a bare path that is no address.
        deleteSetting("externalUrl");
        expect((await sent(() => notifications.notifyUpdateAvailable("x"))).applicationUrl).toBe("");
      } finally {
        delete process.env.URL_BASE;
        deleteSetting("externalUrl");
      }
    });

    describe("a title's folder", () => {
      const movie = (path: string) => ({ media: { id: 91, type: "movie", title: "Blade Runner 2049", year: 2017, path } });

      it("is the path itself when it is a folder named like a file (Blade.Runner.2049, Mr.Robot)", async () => {
        const body = await sent(() => notifications.notifyAdded("Blade Runner 2049", "movie", movie("/movies/Blade.Runner.2049")));
        expect(body.movie.folderPath).toBe("/movies/Blade.Runner.2049");

        const show = await sent(() => notifications.notifyAdded("Mr. Robot", "series", { media: { id: 92, type: "series", title: "Mr. Robot", path: "/tv/Mr.Robot" } }));
        expect(show.series.path).toBe("/tv/Mr.Robot");
      });

      it("is the parent folder when the path is the title's one file, in any case", async () => {
        expect((await sent(() => notifications.notifyAdded("Blade Runner 2049", "movie", movie("/movies/Blade.Runner.2049/Blade.Runner.2049.mkv")))).movie.folderPath).toBe("/movies/Blade.Runner.2049");
        expect((await sent(() => notifications.notifyAdded("Blade Runner 2049", "movie", movie("/movies/Blade.Runner.2049/Blade.Runner.2049.MP4")))).movie.folderPath).toBe("/movies/Blade.Runner.2049");
      });

      it("keeps a file's path relative to the dotted folder, not to its parent", async () => {
        const media = { id: 92, type: "series", title: "Mr. Robot", path: "/tv/Mr.Robot" };
        const body = await sent(() => notifications.notifyImported("Mr. Robot", "ep.mkv", undefined, { media, file: { path: "/tv/Mr.Robot/Season 01/ep.mkv" } }));
        expect(body.episodeFile.relativePath).toBe("Season 01/ep.mkv");
      });

      it("uses every library's extensions for a title whose type this version does not know", async () => {
        const unknown = (path: string) => ({ media: { id: 93, type: "hologram", title: "Odd", path } });
        expect((await sent(() => notifications.notifyAdded("Odd", "hologram", unknown("/x/Odd.Title")))).media.path).toBe("/x/Odd.Title");
        expect((await sent(() => notifications.notifyAdded("Odd", "hologram", unknown("/x/Odd.Title/Odd.Title.mkv")))).media.path).toBe("/x/Odd.Title");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// templates, for every event
// ---------------------------------------------------------------------------

describe("message templates for every event (ST21)", () => {
  async function slackText(run: () => Promise<void>): Promise<string> {
    const fetchMock = stubFetch();
    await run();
    return bodyOf(fetchMock.mock.calls[0]).text;
  }

  beforeEach(async () => {
    await make("slack", { webhookUrl: "https://slack.example/w" }, { events: connections.EVENT_KEYS.join(",") });
  });

  it("every event has a template with its tokens, and the defaults give the text that was always sent", async () => {
    expect(notifications.NOTIFICATION_TEMPLATES.map((t) => t.event)).toEqual([...connections.EVENT_KEYS]);
    expect(notifications.NOTIFICATION_TEMPLATES.map((t) => t.key).sort()).toEqual([...TEMPLATE_KEYS].sort());

    expect(await slackText(() => notifications.notifyUpgraded("M", "m.mkv"))).toBe("*Upgraded*\nM\nm.mkv");
    expect(await slackText(() => notifications.notifyAdded("M", "movie"))).toBe("*Added*\nM (movie)");
    expect(await slackText(() => notifications.notifyDeleted("M", "movie", true))).toBe("*Deleted*\nM (files deleted too)");
    expect(await slackText(() => notifications.notifyRenamed("M", 3))).toBe("*Renamed*\nM: 3 file(s)");
    expect(await slackText(() => notifications.notifyFileDeleted("M", "m.mkv"))).toBe("*File deleted*\nM: m.mkv");
    expect(await slackText(() => notifications.notifyHealthRestored("Indexer down"))).toBe("*Health restored*\nEverything is healthy again. It had been reporting: Indexer down");
  });

  it("each new template overrides its event's text, with the tokens it offers", async () => {
    setSetting("notifyTemplateUpgraded", "Better copy of {mediaTitle}: {fileName}");
    setSetting("notifyTemplateManualInteractionRequired", "Look at {mediaTitle} ({reason})");
    setSetting("notifyTemplateHealthIssue", "PROBLEM: {summary}");
    setSetting("notifyTemplateHealthRestored", "Fixed, it was: {summary}");
    setSetting("notifyTemplateUpdateAvailable", "New build: {title}");
    setSetting("notifyTemplateDuplicatesFound", "{count} dupes: {titles}");
    setSetting("notifyTemplateAdded", "Added {mediaTitle} to {mediaType}");
    setSetting("notifyTemplateDeleted", "Removed {mediaTitle} ({mediaType}){filesNote}");
    setSetting("notifyTemplateRenamed", "{count} renamed in {mediaTitle}");
    setSetting("notifyTemplateFileDeleted", "Lost {fileName} of {mediaTitle}");

    expect(await slackText(() => notifications.notifyUpgraded("M", "m.mkv"))).toBe("*Upgraded*\nBetter copy of M: m.mkv");
    expect(await slackText(() => notifications.notifyManualInteractionRequired("M", "why"))).toBe("*Manual interaction required*\nLook at M (why)");
    expect(await slackText(() => notifications.notifyHealthIssue("disk full"))).toBe("*Health issue*\nPROBLEM: disk full");
    expect(await slackText(() => notifications.notifyHealthRestored("disk full"))).toBe("*Health restored*\nFixed, it was: disk full");
    expect(await slackText(() => notifications.notifyUpdateAvailable("v9"))).toBe("*Update available*\nNew build: v9");
    expect(await slackText(() => notifications.notifyDuplicatesFound(2, ["A", "B"]))).toBe("*Duplicates found*\n2 dupes: A, B");
    expect(await slackText(() => notifications.notifyAdded("M", "movie"))).toBe("*Added*\nAdded M to movie");
    expect(await slackText(() => notifications.notifyDeleted("M", "movie", false))).toBe("*Deleted*\nRemoved M (movie)");
    expect(await slackText(() => notifications.notifyRenamed("M", 4))).toBe("*Renamed*\n4 renamed in M");
    expect(await slackText(() => notifications.notifyFileDeleted("M", "m.mkv"))).toBe("*File deleted*\nLost m.mkv of M");
  });

  it("the templates are saved through the settings API under the keys the page uses", async () => {
    for (const key of TEMPLATE_KEYS) expect((await api.put(`/api/settings/${key}`, { value: "{mediaTitle}" })).status, key).toBe(200);
    const meta = (await api.get("/api/notifications/connections/meta")).body;
    expect(meta.templates.every((t: any) => t.value === "{mediaTitle}")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// a browser subscribing
// ---------------------------------------------------------------------------

describe("web push subscriptions", () => {
  it("the first admin browser to subscribe makes a web push connection, and the next does not make another", async () => {
    const subscribe = (endpoint: string) => api.post("/api/push/subscribe", { endpoint, keys: { p256dh: "k", auth: "a" } });
    expect((await subscribe("https://push.example/a")).status).toBe(201);
    expect((await connections.listNotificationConnections()).map((c) => [c.kind, c.name, c.events])).toEqual([["webPush", "Web push", null]]);

    expect((await subscribe("https://push.example/b")).status).toBe(201);
    expect(await connections.listNotificationConnections()).toHaveLength(1);

    await notifications.notifyGrabbed("X", "Y");
    expect(sendPush).toHaveBeenCalledWith("Grabbed", "X\nY");
  });

  it("two browsers subscribing together make one web push connection, not one each", async () => {
    const subscribe = (endpoint: string) => api.post("/api/push/subscribe", { endpoint, keys: { p256dh: "k", auth: "a" } });

    const answers = await Promise.all([subscribe("https://push.example/a"), subscribe("https://push.example/b"), subscribe("https://push.example/c")]);

    expect(answers.map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await connections.listNotificationConnections()).filter((c) => c.kind === "webPush")).toHaveLength(1);
    // So every event is pushed once to each browser, not once per duplicate connection.
    await notifications.notifyGrabbed("X", "Y");
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("ensureWebPushConnection called twice at once shares one check, and a later call after that finds the connection", async () => {
    await Promise.all([connections.ensureWebPushConnection(), connections.ensureWebPushConnection()]);
    expect((await connections.listNotificationConnections()).filter((c) => c.kind === "webPush")).toHaveLength(1);

    await connections.ensureWebPushConnection();
    expect((await connections.listNotificationConnections()).filter((c) => c.kind === "webPush")).toHaveLength(1);

    // Deleted, the next subscription makes one again.
    await db.prepare("DELETE FROM notification_connections").run();
    await connections.ensureWebPushConnection();
    expect((await connections.listNotificationConnections()).filter((c) => c.kind === "webPush")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the mail server Send to Kindle uses
// ---------------------------------------------------------------------------

describe("the mail server for Send to Kindle", () => {
  const KINDLE = "reader@kindle.example";

  it("is the Email connection when there is one, whatever the old SMTP settings say", async () => {
    setSetting("smtpHost", "old.smtp.example");
    setSetting("smtpFrom", "old@example.com");
    await make("email", { host: "smtp.example", from: "a@b.c", to: "d@e.f", port: 465, secure: true, username: "u", password: "p" });

    expect(await connections.kindleSmtpConfig(KINDLE)).toEqual({ host: "smtp.example", port: 465, secure: true, username: "u", password: "p", from: "a@b.c", to: KINDLE });
  });

  it("prefers an Email connection that is on to one that is off, and still uses one that is off when it is the only one", async () => {
    await make("email", { host: "off.example", from: "a@b.c", to: "d@e.f" }, { enabled: false });
    expect((await connections.kindleSmtpConfig(KINDLE))!.host).toBe("off.example");
    await make("email", { host: "on.example", from: "a@b.c", to: "d@e.f" });
    expect((await connections.kindleSmtpConfig(KINDLE))!.host).toBe("on.example");
  });

  it("falls back to the old SMTP settings only when there is no Email connection and the old host is set", async () => {
    // Neither: not set up.
    expect(await connections.kindleSmtpConfig(KINDLE)).toBeNull();

    // An old host with no sender address cannot send.
    setSetting("smtpHost", "smtp.kindle.example");
    expect(await connections.kindleSmtpConfig(KINDLE)).toBeNull();

    // An old sender address with no host cannot either.
    deleteSetting("smtpHost");
    setSetting("smtpFrom", "aonarr@example.com");
    expect(await connections.kindleSmtpConfig(KINDLE)).toBeNull();

    // Host and sender: the install that has SMTP only for Kindle.
    setSetting("smtpHost", "smtp.kindle.example");
    setSetting("smtpPort", "465");
    setSetting("smtpSecure", "1");
    expect(await connections.kindleSmtpConfig(KINDLE)).toEqual({ host: "smtp.kindle.example", port: 465, secure: true, username: undefined, password: undefined, from: "aonarr@example.com", to: KINDLE });

    // The first Email connection takes over from then on.
    await make("email", { host: "smtp.example", from: "a@b.c", to: "d@e.f" });
    expect((await connections.kindleSmtpConfig(KINDLE))!.host).toBe("smtp.example");
  });

  it("an Email connection moved from the old settings and then deleted leaves no password behind for the fallback to use", async () => {
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpTo", "to@example.com");
    setSetting("smtpFrom", "from@example.com");
    setSetting("smtpUsername", "mailer");
    setSetting("smtpPassword", "mail-pass");
    await migrateAgain();
    const [email] = await connections.listNotificationConnections();
    await connections.deleteNotificationConnection(email.id);

    const fallback = await connections.kindleSmtpConfig(KINDLE);

    expect(fallback?.password).toBeUndefined();
    expect(JSON.stringify(getAllSettings())).not.toContain("mail-pass");
  });
});
