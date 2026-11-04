import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

// push.js/smtp.js/mediaServer.js each have their own dedicated test file exercising their real
// internals (real sockets for SMTP, real web-push library calls) — mocked here via the established
// closure-indirection pattern so notifications.ts's own dispatch/gating/template logic is what's
// under test, not those providers' own wire protocols.
const sendPush = vi.fn();
const sendEmail = vi.fn();
const refreshMediaServerLibrary = vi.fn();
vi.mock("../src/services/push.js", () => ({ sendPush: (...args: unknown[]) => sendPush(...args) }));
vi.mock("../src/services/smtp.js", () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));
vi.mock("../src/services/mediaServer.js", () => ({ refreshMediaServerLibrary: (...args: unknown[]) => refreshMediaServerLibrary(...args) }));

// runCustomScript promisifies node:child_process's execFile at notifications.ts's own module-load
// time, so the raw callback-style function must be mocked (not a promise-returning one) for
// promisify to wrap correctly. Real execFile signature as called here: (file, args, options, cb).
let execFileError: Error | null = null;
const execFileMock = vi.fn((_file: string, _args: string[], _options: any, callback: (err: Error | null, result?: any) => void) => {
  callback(execFileError, { stdout: "", stderr: "" });
});
vi.mock("node:child_process", () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

let eventAllowed: (typeof import("../src/services/notifications.js"))["eventAllowed"];
let notifyGrabbed: (typeof import("../src/services/notifications.js"))["notifyGrabbed"];
let notifyImported: (typeof import("../src/services/notifications.js"))["notifyImported"];
let notifyUpgraded: (typeof import("../src/services/notifications.js"))["notifyUpgraded"];
let notifyManualInteractionRequired: (typeof import("../src/services/notifications.js"))["notifyManualInteractionRequired"];
let notifyUpdateAvailable: (typeof import("../src/services/notifications.js"))["notifyUpdateAvailable"];
let notifyFailed: (typeof import("../src/services/notifications.js"))["notifyFailed"];
let notifyDuplicatesFound: (typeof import("../src/services/notifications.js"))["notifyDuplicatesFound"];
let notifyHealthIssue: (typeof import("../src/services/notifications.js"))["notifyHealthIssue"];
let sendTestNotification: (typeof import("../src/services/notifications.js"))["sendTestNotification"];
let failingNotificationProviders: (typeof import("../src/services/notifications.js"))["failingNotificationProviders"];
let resetNotificationFailures: (typeof import("../src/services/notifications.js"))["__resetNotificationFailuresForTests"];
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];
let connections: typeof import("../src/services/notificationConnections.js");
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  connections = await import("../src/services/notificationConnections.js");
  ({
    eventAllowed,
    notifyGrabbed,
    notifyImported,
    notifyUpgraded,
    notifyManualInteractionRequired,
    notifyUpdateAvailable,
    notifyFailed,
    notifyDuplicatesFound,
    notifyHealthIssue,
    sendTestNotification,
    failingNotificationProviders,
    __resetNotificationFailuresForTests: resetNotificationFailures,
  } = await import("../src/services/notifications.js"));
  ({ setSetting } = await import("../src/services/settingsStore.js"));
});

// Providers are connections now (Round 30e); each test makes the ones it needs.
const SETTINGS_TO_RESET = [
  "mediaServerRefreshOnImport",
  "notifyTemplateGrabbed", "notifyTemplateImported", "notifyTemplateUpgraded", "notifyTemplateFailed",
  "notifyTemplateDuplicatesFound", "notifyTemplateHealthIssue", "notifyTemplateManualInteractionRequired",
  "notifyTemplateUpdateAvailable",
];

beforeEach(async () => {
  for (const key of SETTINGS_TO_RESET) setSetting(key, "");
  await db.prepare("DELETE FROM notification_connections").run();
  resetNotificationFailures();
  sendPush.mockReset().mockResolvedValue(undefined);
  sendEmail.mockReset().mockResolvedValue(undefined);
  refreshMediaServerLibrary.mockReset().mockResolvedValue(undefined);
  execFileMock.mockClear();
  execFileError = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Route = { test: (url: string, init?: any) => boolean; response: any };
function routedFetch(routes: Route[]) {
  return vi.fn(async (url: string, init?: any) => {
    const route = routes.find((r) => r.test(url, init));
    if (!route) throw new Error(`unmocked fetch call: ${url}`);
    return typeof route.response === "function" ? route.response(url, init) : route.response;
  });
}
function ok() {
  return { ok: true, status: 200 };
}
function notOk(status: number) {
  return { ok: false, status };
}

/** Makes a connection. Its name is the provider's, as the old provider list showed it. */
async function connect(kind: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return connections.createNotificationConnection({ name: PROVIDER_NAMES[kind] ?? kind, kind, config, ...extra });
}
const PROVIDER_NAMES: Record<string, string> = {
  discord: "Discord", slack: "Slack", webhook: "Webhook", telegram: "Telegram", pushover: "Pushover", ntfy: "ntfy", gotify: "Gotify",
  matrix: "Matrix", twilio: "SMS (Twilio)", email: "Email", customScript: "Custom Script", webPush: "Web push",
};
const removeConnections = async () => void (await db.prepare("DELETE FROM notification_connections").run());

type Extra = Record<string, unknown>;
const configureDiscord = (extra?: Extra) => connect("discord", { webhookUrl: "https://discord.example/webhook" }, extra);
const configureSlack = (extra?: Extra) => connect("slack", { webhookUrl: "https://slack.example/webhook" }, extra);
const configureGeneric = (extra?: Extra) => connect("webhook", { url: "https://generic.example/webhook" }, extra);
const configureTelegram = (extra?: Extra) => connect("telegram", { botToken: "bot-tok", chatId: "chat-1" }, extra);
const configurePushover = (extra?: Extra) => connect("pushover", { apiToken: "po-tok", userKey: "po-user" }, extra);
const configureMatrix = (extra?: Extra) => connect("matrix", { homeserverUrl: "https://matrix.example/", accessToken: "mx-tok", roomId: "!room:example" }, extra);
const configureTwilio = (extra?: Extra) => connect("twilio", { accountSid: "AC123", authToken: "tw-tok", fromNumber: "+15550001111", toNumber: "+15550002222" }, extra);
const configureSmtp = (config: Record<string, unknown> = {}, extra?: Extra) => connect("email", { host: "smtp.example.com", to: "to@example.com", from: "from@example.com", ...config }, extra);
const configureCustomScript = (extra?: Extra) => connect("customScript", { path: "/scripts/notify.sh" }, extra);
const configureWebPush = (extra?: Extra) => connect("webPush", {}, extra);

// ---------------------------------------------------------------------------
// eventAllowed (was isEventEnabledFor, which read <provider>Events settings) — the same rules on a connection's list
// ---------------------------------------------------------------------------

describe("eventAllowed", () => {
  it("defaults to enabled when the list was never saved at all", async () => {
    expect(eventAllowed(null, "grabbed")).toBe(true);
  });

  it("is disabled for every event once explicitly saved as an empty selection", async () => {
    expect(eventAllowed("", "grabbed")).toBe(false);
    expect(eventAllowed("", "imported")).toBe(false);
  });

  it("only enables the specific events listed in a partial selection", async () => {
    expect(eventAllowed("grabbed,failed", "grabbed")).toBe(true);
    expect(eventAllowed("grabbed,failed", "failed")).toBe(true);
    expect(eventAllowed("grabbed,failed", "imported")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fanOut — every provider sink, driven through notifyGrabbed (the simplest event)
// ---------------------------------------------------------------------------

describe("fanOut dispatch: Discord", () => {
  it("posts an embed with the rendered title/text/color, and sends nothing when unconfigured", async () => {
    await configureDiscord();
    const fetchMock = routedFetch([{ test: (u) => u === "https://discord.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.embeds[0]).toEqual({ title: "Grabbed", description: "Movie Title\nRelease.Name.1080p", color: 0x4f8cff });

    fetchMock.mockClear();
    await removeConnections();
    const unconfiguredFetch = vi.fn();
    vi.stubGlobal("fetch", unconfiguredFetch);
    await notifyGrabbed("X", "Y");
    expect(unconfiguredFetch).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: Slack", () => {
  it("posts a bold-title text message", async () => {
    await configureSlack();
    const fetchMock = routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.text).toBe("*Grabbed*\nMovie Title\nRelease.Name.1080p");
  });
});

describe("fanOut dispatch: webhook", () => {
  it("posts the raw payload object as-is (not a provider-shaped body)", async () => {
    await configureGeneric();
    const fetchMock = routedFetch([{ test: (u) => u === "https://generic.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body).toEqual({ event: "grabbed", mediaTitle: "Movie Title", releaseTitle: "Release.Name.1080p" });
  });
});

describe("fanOut dispatch: Telegram", () => {
  it("form-POSTs to the bot's sendMessage endpoint with chat_id and text, and requires both settings", async () => {
    await configureTelegram();
    const fetchMock = routedFetch([{ test: (u) => u === "https://api.telegram.org/botbot-tok/sendMessage", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const params = (fetchMock.mock.calls[0][1] as any).body as URLSearchParams;
    expect(params.get("chat_id")).toBe("chat-1");
    expect(params.get("text")).toBe("Grabbed\nMovie Title\nRelease.Name.1080p");

    // A bot token alone isn't enough to make a connection.
    await expect(connect("telegram", { botToken: "bot-tok" })).rejects.toThrow("Telegram: Chat ID is required");
  });
});

describe("fanOut dispatch: Pushover", () => {
  it("form-POSTs token/user/title/message, and requires both settings", async () => {
    await configurePushover();
    const fetchMock = routedFetch([{ test: (u) => u === "https://api.pushover.net/1/messages.json", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const params = (fetchMock.mock.calls[0][1] as any).body as URLSearchParams;
    expect(params.get("token")).toBe("po-tok");
    expect(params.get("user")).toBe("po-user");
    expect(params.get("title")).toBe("Grabbed");
    expect(params.get("message")).toBe("Movie Title\nRelease.Name.1080p");
  });
});

describe("fanOut dispatch: Matrix", () => {
  it("PUTs an m.room.message to a unique transaction id, stripping a trailing slash from the homeserver URL", async () => {
    await configureMatrix();
    // encodeURIComponent leaves "!" unescaped (it's in the unreserved set) but does escape ":" --
    // the real room id "!room:example" becomes "!room%3Aexample", not "%21room%3Aexample".
    const fetchMock = routedFetch([
      { test: (u) => u.startsWith("https://matrix.example/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/"), response: ok() },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one call, and it matched the route above (no "unmocked fetch call" swallowed internally)
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("access_token=mx-tok");
    expect((init as any).method).toBe("PUT");
    expect(JSON.parse((init as any).body)).toEqual({ msgtype: "m.text", body: "Grabbed\nMovie Title\nRelease.Name.1080p" });
  });

  it("throws HTTP status details for a failed send, requires all three settings, and is caught (not fatal) by fanOut", async () => {
    await configureMatrix();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("/_matrix/"), response: notOk(403) }]));

    await expect(notifyGrabbed("X", "Y")).resolves.toBeUndefined(); // fanOut swallows the rejection

    await expect(connect("matrix", { homeserverUrl: "https://matrix.example", accessToken: "mx-tok" })).rejects.toThrow("Matrix: Room ID is required");
  });
});

describe("fanOut dispatch: Twilio (SMS)", () => {
  it("POSTs with Basic auth and a combined title:body, requiring all four settings", async () => {
    await configureTwilio();
    const fetchMock = routedFetch([{ test: (u) => u === "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const [, init] = fetchMock.mock.calls[0];
    expect((init as any).headers.Authorization).toBe(`Basic ${Buffer.from("AC123:tw-tok").toString("base64")}`);
    const params = (init as any).body as URLSearchParams;
    expect(params.get("From")).toBe("+15550001111");
    expect(params.get("To")).toBe("+15550002222");
    expect(params.get("Body")).toBe("Grabbed: Movie Title\nRelease.Name.1080p");

    await expect(connect("twilio", { accountSid: "AC123", authToken: "tw-tok", fromNumber: "+1" })).rejects.toThrow("SMS (Twilio): To number is required");
  });
});

describe("fanOut dispatch: SMTP (email)", () => {
  it("calls sendEmail with the assembled config, subject, and body, defaulting port/secure when unset", async () => {
    await configureSmtp();

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(sendEmail).toHaveBeenCalledWith(
      { host: "smtp.example.com", port: 587, secure: false, username: undefined, password: undefined, from: "from@example.com", to: "to@example.com" },
      "AoNarr: Grabbed",
      "Movie Title\nRelease.Name.1080p"
    );
  });

  it("uses a custom port/secure/credentials when configured, and requires host/to/from", async () => {
    await configureSmtp({ port: 465, secure: true, username: "user1", password: "pass1" });

    await notifyGrabbed("X", "Y");

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, username: "user1", password: "pass1" }),
      expect.anything(),
      expect.anything()
    );

    await expect(connect("email", { host: "smtp.example.com", to: "to@example.com" })).rejects.toThrow("Email: Send from is required"); // host+to alone isn't enough
  });
});

describe("fanOut dispatch: web push", () => {
  it("sends through a web push connection, which has nothing to fill in", async () => {
    await configureWebPush();
    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(sendPush).toHaveBeenCalledWith("Grabbed", "Movie Title\nRelease.Name.1080p");
  });

  it("sends nothing without a web push connection (a subscribed browser alone no longer does)", async () => {
    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("is still gated by its own events like every other connection", async () => {
    await configureWebPush({ events: ["imported"] }); // grabbed excluded
    await notifyGrabbed("X", "Y");
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: custom script", () => {
  it("passes AONARR_-prefixed, SNAKE_CASE env vars converted from the payload's camelCase tokens", async () => {
    await configureCustomScript();

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("/scripts/notify.sh");
    expect(args).toEqual([]);
    expect((options as any).env.AONARR_EVENT).toBe("grabbed");
    expect((options as any).env.AONARR_MEDIA_TITLE).toBe("Movie Title");
    expect((options as any).env.AONARR_RELEASE_TITLE).toBe("Release.Name.1080p");
    expect((options as any).timeout).toBe(30_000);
  });

  it("is a silent no-op (not called at all) when there is no connection, or it is switched off", async () => {
    await notifyGrabbed("X", "Y");
    expect(execFileMock).not.toHaveBeenCalled();

    await configureCustomScript({ enabled: false });
    await notifyGrabbed("X", "Y");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a script failure is caught by fanOut's Promise.allSettled -- notifyGrabbed itself never rejects", async () => {
    await configureCustomScript();
    execFileError = new Error("script exploded");

    await expect(notifyGrabbed("X", "Y")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fanOut: cross-cutting behavior -- event gating actually wired in, and resilience
// ---------------------------------------------------------------------------

describe("fanOut: per-connection event gating is actually wired in (not just eventAllowed working in isolation)", () => {
  it("a connection whose events exclude this event is skipped while an unrestricted one still fires", async () => {
    await configureDiscord({ events: ["imported"] }); // grabbed excluded for Discord only
    await configureSlack();
    const fetchMock = routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("X", "Y");

    expect(fetchMock).toHaveBeenCalledTimes(1); // only Slack's webhook was ever requested
  });
});

describe("fanOut: resilience", () => {
  it("one sink failing (a non-OK response) doesn't stop the others, and doesn't reject the caller", async () => {
    await configureDiscord();
    await configureSlack();
    const fetchMock = routedFetch([
      { test: (u) => u === "https://discord.example/webhook", response: notOk(500) },
      { test: (u) => u === "https://slack.example/webhook", response: ok() },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyGrabbed("X", "Y")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2); // both were attempted despite Discord's failure
  });
});

// ---------------------------------------------------------------------------
// renderTemplate (private, exercised through notifyGrabbed)
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  it("uses a custom template when configured, and leaves an unknown {token} untouched rather than blanking it", async () => {
    await configureGeneric();
    setSetting("notifyTemplateGrabbed", "Got {mediaTitle} via {bogusToken}!");
    const fetchMock = routedFetch([{ test: (u) => u === "https://generic.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.mediaTitle).toBe("Movie Title"); // payload itself is unaffected by the template
    // The rendered text only shows up on providers that use `content.text` (e.g. Slack), not the
    // generic webhook (which sends the raw payload) -- check via Slack instead. Clear the generic
    // webhook first so this second call doesn't also (harmlessly, but sloppily) hit it against a
    // fetch mock with no route registered for it.
    await removeConnections();
    await configureSlack();
    const slackFetch = routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", slackFetch);
    await notifyGrabbed("Movie Title", "Release.Name.1080p");
    const slackBody = JSON.parse((slackFetch.mock.calls[0][1] as any).body);
    expect(slackBody.text).toBe("*Grabbed*\nGot Movie Title via {bogusToken}!");
  });
});

// ---------------------------------------------------------------------------
// The remaining notify* event functions -- title/color/template/payload per event
// ---------------------------------------------------------------------------

describe("notify* event functions", () => {
  async function slackTextFor(send: () => Promise<void>): Promise<string> {
    await configureSlack();
    const fetchMock = routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);
    await send();
    return JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
  }

  it("notifyImported: title/template, and opt-in media-server refresh on a provided filePath", async () => {
    expect(await slackTextFor(() => notifyImported("Movie Title", "movie.mkv"))).toBe("*Imported*\nMovie Title\nmovie.mkv");

    await notifyImported("X", "y.mkv", "/library/y.mkv"); // no opt-in setting -- no refresh
    expect(refreshMediaServerLibrary).not.toHaveBeenCalled();

    setSetting("mediaServerRefreshOnImport", "1");
    await notifyImported("X", "y.mkv", "/library/y.mkv");
    expect(refreshMediaServerLibrary).toHaveBeenCalledWith("/library/y.mkv");

    refreshMediaServerLibrary.mockClear();
    await notifyImported("X", "y.mkv"); // opted in, but no filePath given at all
    expect(refreshMediaServerLibrary).not.toHaveBeenCalled();
  });

  it("notifyImported: a media-server refresh failure is caught and logged, never surfaces to the caller", async () => {
    setSetting("mediaServerRefreshOnImport", "1");
    refreshMediaServerLibrary.mockRejectedValue(new Error("media server unreachable"));

    await expect(notifyImported("X", "y.mkv", "/library/y.mkv")).resolves.toBeUndefined();
  });

  it("notifyUpgraded: title/template, and the same opt-in media-server refresh behavior as notifyImported", async () => {
    expect(await slackTextFor(() => notifyUpgraded("Movie Title", "movie.mkv"))).toBe("*Upgraded*\nMovie Title\nmovie.mkv");

    setSetting("mediaServerRefreshOnImport", "1");
    await notifyUpgraded("X", "y.mkv", "/library/y.mkv");
    expect(refreshMediaServerLibrary).toHaveBeenCalledWith("/library/y.mkv");
  });

  it("notifyManualInteractionRequired: title/template", async () => {
    expect(await slackTextFor(() => notifyManualInteractionRequired("Show Title", "unmatched season pack"))).toBe(
      "*Manual interaction required*\nShow Title: unmatched season pack"
    );
  });

  it("notifyUpdateAvailable: title/template", async () => {
    expect(await slackTextFor(() => notifyUpdateAvailable("v2.0.0"))).toBe("*Update available*\nv2.0.0");
  });

  it("notifyFailed: title/template", async () => {
    expect(await slackTextFor(() => notifyFailed("Movie Title", "disk full"))).toBe("*Failed*\nMovie Title: disk full");
  });

  it("notifyDuplicatesFound: title/template, with a trailing '...' only when there are more than the sample shown", async () => {
    expect(await slackTextFor(() => notifyDuplicatesFound(2, ["A", "B"]))).toBe("*Duplicates found*\n2 new duplicate group(s) found: A, B");
    expect(await slackTextFor(() => notifyDuplicatesFound(5, ["A", "B"]))).toBe("*Duplicates found*\n5 new duplicate group(s) found: A, B, ...");
  });

  it("notifyHealthIssue: title/template", async () => {
    expect(await slackTextFor(() => notifyHealthIssue("Indexer X is unreachable"))).toBe("*Health issue*\nIndexer X is unreachable");
  });
});

// ---------------------------------------------------------------------------
// sendTestNotification -- one provider per branch, ignoring the event filter entirely
// ---------------------------------------------------------------------------

describe("sendTestNotification (the test button by provider key: the first connection of that kind)", () => {
  const NONE = (label: string) => new RegExp(`There is no ${label} connection yet`);

  it("Discord: throws when there is no connection, sends when there is, ignoring the events list", async () => {
    await expect(sendTestNotification("discord")).rejects.toThrow(NONE("Discord"));

    await configureDiscord({ events: [] }); // would silence every real event, but a Test send ignores this
    const fetchMock = routedFetch([{ test: (u) => u === "https://discord.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);
    await sendTestNotification("discord");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Slack: throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("slack")).rejects.toThrow(NONE("Slack"));
    await configureSlack();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]));
    await expect(sendTestNotification("slack")).resolves.toBeUndefined();
  });

  it("Generic webhook ('generic'): throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("generic")).rejects.toThrow(NONE("Webhook"));
    await configureGeneric();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://generic.example/webhook", response: ok() }]));
    await expect(sendTestNotification("generic")).resolves.toBeUndefined();
  });

  it("Telegram: throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("telegram")).rejects.toThrow(NONE("Telegram"));
    await configureTelegram();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://api.telegram.org/botbot-tok/sendMessage", response: ok() }]));
    await expect(sendTestNotification("telegram")).resolves.toBeUndefined();
  });

  it("Pushover: throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("pushover")).rejects.toThrow(NONE("Pushover"));
    await configurePushover();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://api.pushover.net/1/messages.json", response: ok() }]));
    await expect(sendTestNotification("pushover")).resolves.toBeUndefined();
  });

  it("Matrix: throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("matrix")).rejects.toThrow(NONE("Matrix"));
    await configureMatrix();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("/_matrix/"), response: ok() }]));
    await expect(sendTestNotification("matrix")).resolves.toBeUndefined();
  });

  it("Twilio: throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("twilio")).rejects.toThrow(NONE("SMS \\(Twilio\\)"));
    await configureTwilio();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("api.twilio.com"), response: ok() }]));
    await expect(sendTestNotification("twilio")).resolves.toBeUndefined();
  });

  it("SMTP ('smtp'): throws when there is no connection, sends when there is", async () => {
    await expect(sendTestNotification("smtp")).rejects.toThrow(NONE("Email"));
    await configureSmtp();
    await sendTestNotification("smtp");
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com" }), "AoNarr: AoNarr test notification", expect.any(String));
  });

  it("push: needs a web push connection, then always attempts the send", async () => {
    await expect(sendTestNotification("push")).rejects.toThrow(NONE("Web push"));
    await configureWebPush();
    await sendTestNotification("push");
    expect(sendPush).toHaveBeenCalledWith("AoNarr test notification", expect.any(String));
  });

  it("custom script: throws when there is no connection, runs when there is, and a failure propagates (unlike fanOut's swallowed version)", async () => {
    await expect(sendTestNotification("customScript")).rejects.toThrow(NONE("Custom Script"));

    await configureCustomScript({ enabled: false }); // a test runs it even though real events do not
    await sendTestNotification("customScript");
    expect(execFileMock).toHaveBeenCalledTimes(1);

    execFileError = new Error("script exploded");
    await expect(sendTestNotification("customScript")).rejects.toThrow("Custom script failed: script exploded");
  });

  it("throws for an unrecognized provider key", async () => {
    await expect(sendTestNotification("carrier-pigeon")).rejects.toThrow('Unknown notification provider "carrier-pigeon"');
  });
});

// ---------------------------------------------------------------------------
// Provider HTTP calls: bounded by a timeout, and credential-bearing URLs kept out of errors/logs
// ---------------------------------------------------------------------------

describe("provider HTTP calls: timeout", () => {
  it("every fetch-based provider passes an abort signal, so a silent target can't stall fanOut for undici's 300s default", async () => {
    await configureDiscord();
    await configureSlack();
    await configureGeneric();
    await configureTelegram();
    await configurePushover();
    await configureMatrix();
    await configureTwilio();
    const fetchMock = vi.fn(async (_url: string, _init?: any) => ok());
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("X", "Y");

    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a target that never answers is aborted by its signal: fanOut still resolves and a Test send rejects", async () => {
    await configureGeneric();
    // Stands in for the real timer so the test doesn't wait: the signal each call gets is already
    // expired, and the hung fetch below only ever settles by honoring it.
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    const hungFetch = vi.fn(
      (_url: string, init?: any) =>
        new Promise((_resolve, reject) => {
          const signal: AbortSignal = init.signal;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason));
        })
    );
    vi.stubGlobal("fetch", hungFetch);
    try {
      await expect(notifyGrabbed("X", "Y")).resolves.toBeUndefined();
      await expect(sendTestNotification("generic")).rejects.toThrow(/timeout/i);
      expect(timeoutSpy).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("provider HTTP calls: credential redaction", () => {
  it("a failing webhook's error names only the host, never the secret-bearing URL", async () => {
    await connect("discord", { webhookUrl: "https://discord.example/api/webhooks/123/super-secret-token" });
    vi.stubGlobal("fetch", vi.fn(async () => notOk(429)));

    const err = await sendTestNotification("discord").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("discord.example");
    expect((err as Error).message).toContain("HTTP 429");
    expect((err as Error).message).not.toContain("super-secret-token");
  });

  it("a failing Telegram send doesn't leak the bot token into the error or fanOut's warn log", async () => {
    await configureTelegram();
    vi.stubGlobal("fetch", vi.fn(async () => notOk(429)));
    const { log } = await import("../src/services/logger.js");
    const warnSpy = vi.spyOn(log, "warn");
    try {
      const err = await sendTestNotification("telegram").catch((e: Error) => e);
      expect((err as Error).message).toMatch(/api\.telegram\.org.*HTTP 429/);
      expect((err as Error).message).not.toContain("bot-tok");

      await notifyGrabbed("X", "Y");
      const logged = warnSpy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).toContain("HTTP 429");
      expect(logged).not.toContain("bot-tok");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Which provider keeps failing (Sonarr's NotificationStatus): the outcome of every send is remembered per provider
// ---------------------------------------------------------------------------

describe("failing notification providers", () => {
  beforeEach(() => {
    resetNotificationFailures();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNotificationFailures();
  });

  const configureNtfy = (extra?: Extra) => connect("ntfy", { serverUrl: "https://ntfy.example", topic: "aonarr" }, extra);
  const configureGotify = (extra?: Extra) => connect("gotify", { serverUrl: "https://gotify.example", token: "gotify-app-token" }, extra);
  /** Every fetch-based provider answers with this status. */
  function everyWebhookAnswers(status: number): void {
    vi.stubGlobal("fetch", vi.fn(async () => (status === 200 ? ok() : notOk(status))));
  }

  it("reports nothing while no send has failed", async () => {
    await configureDiscord();
    everyWebhookAnswers(200);

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()).toEqual([]);
  });

  it("reports a provider only after its sends have failed twice in a row, with how many and what the last error was", async () => {
    await configureDiscord();
    everyWebhookAnswers(500);

    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toEqual([]);

    await notifyGrabbed("X", "Y");
    const failing = failingNotificationProviders();
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ provider: "Discord", failures: 2, lastError: "Webhook POST to discord.example failed: HTTP 500" });
    expect(new Date(failing[0].since).toISOString()).toBe(failing[0].since);

    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()[0].failures).toBe(3);
  });

  it("takes the number of failures that counts as 'failing' as a parameter", async () => {
    await configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders(1).map((f) => f.provider)).toEqual(["Discord"]);
    expect(failingNotificationProviders(2).map((f) => f.provider)).toEqual(["Discord"]);
    expect(failingNotificationProviders(3)).toEqual([]);
  });

  it("clears a provider with a single successful send, and counts from one again after that", async () => {
    await configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toHaveLength(1);

    everyWebhookAnswers(200);
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders(1)).toEqual([]);

    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toEqual([]); // one failure again, below the threshold
    expect(failingNotificationProviders(1)[0].failures).toBe(1);
  });

  it("keeps the time of the first failure of the run while the count and the last error move on", async () => {
    await configureDiscord();
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => notOk(500)));
    await notifyGrabbed("X", "Y");
    vi.setSystemTime(new Date("2026-03-01T12:30:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => notOk(429)));
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()[0]).toMatchObject({
      failures: 2,
      since: "2026-03-01T10:00:00.000Z",
      lastError: "Webhook POST to discord.example failed: HTTP 429",
    });

    // A success ends the run: the next failures start a new one with a new first time.
    vi.setSystemTime(new Date("2026-03-01T13:00:00.000Z"));
    everyWebhookAnswers(200);
    await notifyGrabbed("X", "Y");
    vi.setSystemTime(new Date("2026-03-01T14:00:00.000Z"));
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()[0]).toMatchObject({ failures: 2, since: "2026-03-01T14:00:00.000Z" });
  });

  it("tracks each provider on its own, so a working one is never reported for a broken neighbour", async () => {
    await configureDiscord();
    await configureSlack();
    await configureGeneric();
    vi.stubGlobal(
      "fetch",
      routedFetch([
        { test: (u) => u === "https://discord.example/webhook", response: notOk(500) },
        { test: (u) => u === "https://slack.example/webhook", response: ok() },
        { test: (u) => u === "https://generic.example/webhook", response: notOk(502) },
      ])
    );

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders().map((f) => f.provider).sort()).toEqual(["Discord", "Webhook"]);
  });

  it("does not count a send that an event filter skipped as either a failure or a success", async () => {
    const discord = await configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toHaveLength(1);

    await connections.updateNotificationConnection(discord.id, { events: ["imported"] }); // grabbed is no longer sent to Discord
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()[0].failures).toBe(2);
  });

  // The name is what Health shows: a connection is recorded under its own (here the one a migrated provider gets).
  // `testKey` is the provider's key on the old Test endpoint, which is not always the name of the connection.
  const failWebhook = () => everyWebhookAnswers(500);
  const recoverWebhook = () => everyWebhookAnswers(200);
  const providers: { name: string; testKey: string; configure: () => Promise<unknown>; fail: () => void; recover: () => void }[] = [
    { name: "Discord", testKey: "discord", configure: configureDiscord, fail: failWebhook, recover: recoverWebhook },
    { name: "Slack", testKey: "slack", configure: configureSlack, fail: failWebhook, recover: recoverWebhook },
    { name: "Webhook", testKey: "generic", configure: configureGeneric, fail: failWebhook, recover: recoverWebhook },
    { name: "Telegram", testKey: "telegram", configure: configureTelegram, fail: failWebhook, recover: recoverWebhook },
    { name: "Pushover", testKey: "pushover", configure: configurePushover, fail: failWebhook, recover: recoverWebhook },
    { name: "ntfy", testKey: "ntfy", configure: configureNtfy, fail: failWebhook, recover: recoverWebhook },
    { name: "Gotify", testKey: "gotify", configure: configureGotify, fail: failWebhook, recover: recoverWebhook },
    { name: "Matrix", testKey: "matrix", configure: configureMatrix, fail: failWebhook, recover: recoverWebhook },
    { name: "SMS (Twilio)", testKey: "twilio", configure: configureTwilio, fail: failWebhook, recover: recoverWebhook },
    {
      name: "Email",
      testKey: "smtp",
      configure: configureSmtp,
      fail: () => sendEmail.mockRejectedValue(new Error("smtp.example.com refused the connection")),
      recover: () => sendEmail.mockResolvedValue(undefined),
    },
    {
      name: "Web push",
      testKey: "push",
      configure: configureWebPush,
      fail: () => sendPush.mockRejectedValue(new Error("push service down")),
      recover: () => sendPush.mockResolvedValue(undefined),
    },
    {
      name: "Custom Script",
      testKey: "customScript",
      configure: configureCustomScript,
      fail: () => {
        execFileError = new Error("exit code 1");
      },
      recover: () => {
        execFileError = null;
      },
    },
  ];

  it.each(providers)("clears a failing $name provider when its Test button ($testKey) goes through", async ({ name, testKey, configure, fail, recover }) => {
    await configure();
    fail();
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders().map((f) => f.provider)).toEqual([name]);

    recover();
    await sendTestNotification(testKey);

    expect(failingNotificationProviders(1)).toEqual([]);
  });

  it.each(providers)("leaves a failing $name provider reported when its Test button ($testKey) fails too", async ({ name, testKey, configure, fail }) => {
    await configure();
    fail();
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    await expect(sendTestNotification(testKey)).rejects.toThrow();

    const failing = failingNotificationProviders();
    expect(failing.map((f) => f.provider)).toEqual([name]);
    expect(failing[0].failures).toBe(2); // a test is not one more failed send
  });

  it("clears only the provider that was tested", async () => {
    await configureDiscord();
    await configureSlack();
    vi.stubGlobal("fetch", routedFetch([
      { test: (u) => u === "https://discord.example/webhook", response: notOk(500) },
      { test: (u) => u === "https://slack.example/webhook", response: notOk(500) },
    ]));
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders().map((f) => f.provider).sort()).toEqual(["Discord", "Slack"]);

    everyWebhookAnswers(200);
    await sendTestNotification("slack");

    expect(failingNotificationProviders().map((f) => f.provider)).toEqual(["Discord"]);
  });

  it("a Test of a provider that never failed, or of an unknown key, records nothing", async () => {
    await configureDiscord();
    everyWebhookAnswers(200);

    await sendTestNotification("discord");
    await expect(sendTestNotification("carrier-pigeon")).rejects.toThrow("Unknown notification provider");

    expect(failingNotificationProviders(1)).toEqual([]);
  });

  it("stops reporting a provider a day after its last failed send, and reports it again after a new failure", async () => {
    await configureDiscord();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-01T10:00:00.000Z");
    const hour = 60 * 60 * 1000;
    vi.setSystemTime(start);
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    vi.setSystemTime(start + 24 * hour - 1000);
    expect(failingNotificationProviders().map((f) => f.provider)).toEqual(["Discord"]);

    vi.setSystemTime(start + 24 * hour);
    expect(failingNotificationProviders()).toEqual([]);
    vi.setSystemTime(start + 30 * hour);
    expect(failingNotificationProviders()).toEqual([]);

    // The provider is still configured, and its next send fails as well: it is back.
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders().map((f) => f.provider)).toEqual(["Discord"]);
  });

  it("measures the day from the latest failed send, not the first", async () => {
    await configureDiscord();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-01T10:00:00.000Z");
    const hour = 60 * 60 * 1000;
    everyWebhookAnswers(500);
    vi.setSystemTime(start);
    await notifyGrabbed("X", "Y");
    vi.setSystemTime(start + 20 * hour);
    await notifyGrabbed("X", "Y");

    vi.setSystemTime(start + 30 * hour); // 30 h after the first failure, 10 h after the latest
    expect(failingNotificationProviders()[0]).toMatchObject({ provider: "Discord", failures: 2, since: new Date(start).toISOString() });
  });

  it("does not keep reporting a connection that was switched off or deleted (Health stops naming it at once)", async () => {
    const discord = await configureDiscord();
    const slack = await configureSlack();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toHaveLength(2);

    await connections.updateNotificationConnection(discord.id, { enabled: false }); // the admin switched Discord off; nothing is sent to it any more
    await connections.deleteNotificationConnection(slack.id);

    expect(failingNotificationProviders(1)).toEqual([]);
  });

  it.each(providers)("records a failing $name send under that name", async ({ name, configure, fail }) => {
    await configure();
    fail();

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    const failing = failingNotificationProviders();
    expect(failing.map((f) => f.provider)).toEqual([name]);
    expect(failing[0].failures).toBe(2);
    expect(failing[0].lastError).not.toBe("");
  });

  it("records a connection that is set up wrongly (a Gotify URL with no scheme, as an old setting could be) as failing, with the reason", async () => {
    // The API refuses such a URL now; one that came over from the old settings is stored as it was.
    const gotify = await configureGotify();
    const row = (await db.prepare("SELECT config FROM notification_connections WHERE id = ?").get(gotify.id)) as { config: string };
    await db.prepare("UPDATE notification_connections SET config = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.config), serverUrl: "gotify.example" }), gotify.id);
    vi.stubGlobal("fetch", vi.fn());

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()).toMatchObject([
      { provider: "Gotify", failures: 2, lastError: "The Gotify server URL must start with http:// or https://" },
    ]);
  });

  it("keeps the secret-bearing URL out of what it remembers, and cuts a very long error to 300 characters", async () => {
    await connect("discord", { webhookUrl: "https://discord.example/api/webhooks/123/super-secret-token" });
    everyWebhookAnswers(429);
    await configureSmtp();
    sendEmail.mockRejectedValue(new Error("e".repeat(500)));

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    const failing = failingNotificationProviders();
    const discord = failing.find((f) => f.provider === "Discord")!;
    expect(discord.lastError).toContain("discord.example");
    expect(JSON.stringify(failing)).not.toContain("super-secret-token");
    expect(failing.find((f) => f.provider === "Email")!.lastError).toBe("e".repeat(300));
  });

  it("forgets every failure when reset for a test", async () => {
    await configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toHaveLength(1);

    resetNotificationFailures();

    expect(failingNotificationProviders(1)).toEqual([]);
  });
});
