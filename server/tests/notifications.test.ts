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

let isEventEnabledFor: (typeof import("../src/services/notifications.js"))["isEventEnabledFor"];
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
let deleteSetting: (typeof import("../src/services/settingsStore.js"))["deleteSetting"];

beforeAll(async () => {
  await setupTestDb();
  ({
    isEventEnabledFor,
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
  ({ setSetting, deleteSetting } = await import("../src/services/settingsStore.js"));
});

const SETTINGS_TO_RESET = [
  "discordWebhookUrl", "slackWebhookUrl", "genericWebhookUrl",
  "telegramBotToken", "telegramChatId",
  "pushoverApiToken", "pushoverUserKey",
  "matrixHomeserverUrl", "matrixAccessToken", "matrixRoomId",
  "twilioAccountSid", "twilioAuthToken", "twilioFromNumber", "twilioToNumber",
  "smtpHost", "smtpTo", "smtpFrom", "smtpPort", "smtpSecure", "smtpUsername", "smtpPassword",
  "customScriptEnabled", "customScriptPath",
  "mediaServerRefreshOnImport",
  "notifyTemplateGrabbed", "notifyTemplateImported", "notifyTemplateUpgraded", "notifyTemplateFailed",
  "notifyTemplateDuplicatesFound", "notifyTemplateHealthIssue", "notifyTemplateManualInteractionRequired",
  "notifyTemplateUpdateAvailable",
];

// isEventEnabledFor treats a truly-unset setting (null) as "every event enabled" but an
// EXPLICITLY-saved empty string as "every event disabled" (that distinction is the whole point of
// the Round-227 bug it guards against) -- so these must be reset via deleteSetting, never
// setSetting(key, ""), or every provider would look silenced before each test even starts.
const EVENTS_SETTINGS_TO_RESET = [
  "discordEvents", "slackEvents", "genericEvents", "telegramEvents", "pushoverEvents", "matrixEvents",
  "twilioEvents", "smtpEvents", "pushEvents", "customScriptEvents",
];

beforeEach(() => {
  for (const key of SETTINGS_TO_RESET) setSetting(key, "");
  for (const key of EVENTS_SETTINGS_TO_RESET) deleteSetting(key);
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

function configureDiscord(): void {
  setSetting("discordWebhookUrl", "https://discord.example/webhook");
}
function configureSlack(): void {
  setSetting("slackWebhookUrl", "https://slack.example/webhook");
}
function configureGeneric(): void {
  setSetting("genericWebhookUrl", "https://generic.example/webhook");
}
function configureTelegram(): void {
  setSetting("telegramBotToken", "bot-tok");
  setSetting("telegramChatId", "chat-1");
}
function configurePushover(): void {
  setSetting("pushoverApiToken", "po-tok");
  setSetting("pushoverUserKey", "po-user");
}
function configureMatrix(): void {
  setSetting("matrixHomeserverUrl", "https://matrix.example/");
  setSetting("matrixAccessToken", "mx-tok");
  setSetting("matrixRoomId", "!room:example");
}
function configureTwilio(): void {
  setSetting("twilioAccountSid", "AC123");
  setSetting("twilioAuthToken", "tw-tok");
  setSetting("twilioFromNumber", "+15550001111");
  setSetting("twilioToNumber", "+15550002222");
}
function configureSmtp(): void {
  setSetting("smtpHost", "smtp.example.com");
  setSetting("smtpTo", "to@example.com");
  setSetting("smtpFrom", "from@example.com");
}
function configureCustomScript(): void {
  setSetting("customScriptEnabled", "1");
  setSetting("customScriptPath", "/scripts/notify.sh");
}

// ---------------------------------------------------------------------------
// isEventEnabledFor — pre-existing regression coverage, kept as-is
// ---------------------------------------------------------------------------

describe("isEventEnabledFor", () => {
  it("defaults to enabled when the setting was never saved at all", async () => {
    expect(isEventEnabledFor("neverConfigured", "grabbed")).toBe(true);
  });

  it("is disabled for every event once explicitly saved as an empty selection", async () => {
    setSetting("discordEvents", "");
    expect(isEventEnabledFor("discord", "grabbed")).toBe(false);
    expect(isEventEnabledFor("discord", "imported")).toBe(false);
  });

  it("only enables the specific events listed in a partial selection", async () => {
    setSetting("slackEvents", "grabbed,failed");
    expect(isEventEnabledFor("slack", "grabbed")).toBe(true);
    expect(isEventEnabledFor("slack", "failed")).toBe(true);
    expect(isEventEnabledFor("slack", "imported")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fanOut — every provider sink, driven through notifyGrabbed (the simplest event)
// ---------------------------------------------------------------------------

describe("fanOut dispatch: Discord", () => {
  it("posts an embed with the rendered title/text/color, and sends nothing when unconfigured", async () => {
    configureDiscord();
    const fetchMock = routedFetch([{ test: (u) => u === "https://discord.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.embeds[0]).toEqual({ title: "Grabbed", description: "Movie Title\nRelease.Name.1080p", color: 0x4f8cff });

    fetchMock.mockClear();
    setSetting("discordWebhookUrl", "");
    const unconfiguredFetch = vi.fn();
    vi.stubGlobal("fetch", unconfiguredFetch);
    await notifyGrabbed("X", "Y");
    expect(unconfiguredFetch).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: Slack", () => {
  it("posts a bold-title text message", async () => {
    configureSlack();
    const fetchMock = routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.text).toBe("*Grabbed*\nMovie Title\nRelease.Name.1080p");
  });
});

describe("fanOut dispatch: generic webhook", () => {
  it("posts the raw payload object as-is (not a provider-shaped body)", async () => {
    configureGeneric();
    const fetchMock = routedFetch([{ test: (u) => u === "https://generic.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body).toEqual({ event: "grabbed", mediaTitle: "Movie Title", releaseTitle: "Release.Name.1080p" });
  });
});

describe("fanOut dispatch: Telegram", () => {
  it("form-POSTs to the bot's sendMessage endpoint with chat_id and text, and requires both settings", async () => {
    configureTelegram();
    const fetchMock = routedFetch([{ test: (u) => u === "https://api.telegram.org/botbot-tok/sendMessage", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const params = (fetchMock.mock.calls[0][1] as any).body as URLSearchParams;
    expect(params.get("chat_id")).toBe("chat-1");
    expect(params.get("text")).toBe("Grabbed\nMovie Title\nRelease.Name.1080p");

    fetchMock.mockClear();
    setSetting("telegramChatId", ""); // bot token alone isn't enough
    const partialFetch = vi.fn();
    vi.stubGlobal("fetch", partialFetch);
    await notifyGrabbed("X", "Y");
    expect(partialFetch).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: Pushover", () => {
  it("form-POSTs token/user/title/message, and requires both settings", async () => {
    configurePushover();
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
    configureMatrix();
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
    configureMatrix();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("/_matrix/"), response: notOk(403) }]));

    await expect(notifyGrabbed("X", "Y")).resolves.toBeUndefined(); // fanOut swallows the rejection

    setSetting("matrixRoomId", "");
    const partialFetch = vi.fn();
    vi.stubGlobal("fetch", partialFetch);
    await notifyGrabbed("X", "Y");
    expect(partialFetch.mock.calls.some((c) => String(c[0]).includes("_matrix"))).toBe(false);
  });
});

describe("fanOut dispatch: Twilio (SMS)", () => {
  it("POSTs with Basic auth and a combined title:body, requiring all four settings", async () => {
    configureTwilio();
    const fetchMock = routedFetch([{ test: (u) => u === "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    const [, init] = fetchMock.mock.calls[0];
    expect((init as any).headers.Authorization).toBe(`Basic ${Buffer.from("AC123:tw-tok").toString("base64")}`);
    const params = (init as any).body as URLSearchParams;
    expect(params.get("From")).toBe("+15550001111");
    expect(params.get("To")).toBe("+15550002222");
    expect(params.get("Body")).toBe("Grabbed: Movie Title\nRelease.Name.1080p");

    fetchMock.mockClear();
    setSetting("twilioToNumber", "");
    const partialFetch = vi.fn();
    vi.stubGlobal("fetch", partialFetch);
    await notifyGrabbed("X", "Y");
    expect(partialFetch).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: SMTP (email)", () => {
  it("calls sendEmail with the assembled config, subject, and body, defaulting port/secure when unset", async () => {
    configureSmtp();

    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(sendEmail).toHaveBeenCalledWith(
      { host: "smtp.example.com", port: 587, secure: false, username: undefined, password: undefined, from: "from@example.com", to: "to@example.com" },
      "AoNarr: Grabbed",
      "Movie Title\nRelease.Name.1080p"
    );
  });

  it("uses a custom port/secure/credentials when configured, and requires host/to/from", async () => {
    configureSmtp();
    setSetting("smtpPort", "465");
    setSetting("smtpSecure", "1");
    setSetting("smtpUsername", "user1");
    setSetting("smtpPassword", "pass1");

    await notifyGrabbed("X", "Y");

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, username: "user1", password: "pass1" }),
      expect.anything(),
      expect.anything()
    );

    sendEmail.mockClear();
    setSetting("smtpFrom", ""); // host+to alone isn't enough
    await notifyGrabbed("X", "Y");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: web push", () => {
  it("always attempts sendPush -- no separate 'configured' gate, unlike every webhook/bot provider", async () => {
    await notifyGrabbed("Movie Title", "Release.Name.1080p");

    expect(sendPush).toHaveBeenCalledWith("Grabbed", "Movie Title\nRelease.Name.1080p");
  });

  it("is still gated by its own Events setting like every other provider", async () => {
    setSetting("pushEvents", "imported"); // grabbed excluded
    await notifyGrabbed("X", "Y");
    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe("fanOut dispatch: custom script", () => {
  it("passes AONARR_-prefixed, SNAKE_CASE env vars converted from the payload's camelCase tokens", async () => {
    configureCustomScript();

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

  it("is a silent no-op (not called at all) when not enabled or no path is set", async () => {
    await notifyGrabbed("X", "Y"); // customScriptEnabled/-Path both reset to "" in beforeEach
    expect(execFileMock).not.toHaveBeenCalled();

    setSetting("customScriptEnabled", "1"); // enabled but no path
    await notifyGrabbed("X", "Y");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("a script failure is caught by fanOut's Promise.allSettled -- notifyGrabbed itself never rejects", async () => {
    configureCustomScript();
    execFileError = new Error("script exploded");

    await expect(notifyGrabbed("X", "Y")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fanOut: cross-cutting behavior -- event gating actually wired in, and resilience
// ---------------------------------------------------------------------------

describe("fanOut: per-sink event gating is actually wired in (not just isEventEnabledFor working in isolation)", () => {
  it("a provider whose Events setting excludes this event is skipped while an unrestricted one still fires", async () => {
    configureDiscord();
    configureSlack();
    setSetting("discordEvents", "imported"); // grabbed excluded for Discord only
    const fetchMock = routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("X", "Y");

    expect(fetchMock).toHaveBeenCalledTimes(1); // only Slack's webhook was ever requested
  });
});

describe("fanOut: resilience", () => {
  it("one sink failing (a non-OK response) doesn't stop the others, and doesn't reject the caller", async () => {
    configureDiscord();
    configureSlack();
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
    configureGeneric();
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
    setSetting("genericWebhookUrl", "");
    configureSlack();
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
    configureSlack();
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

describe("sendTestNotification", () => {
  it("Discord: throws when unconfigured, sends when configured, ignoring the Events filter", async () => {
    await expect(sendTestNotification("discord")).rejects.toThrow("Discord webhook URL isn't set");

    configureDiscord();
    setSetting("discordEvents", ""); // would silence every real event, but a Test send ignores this
    const fetchMock = routedFetch([{ test: (u) => u === "https://discord.example/webhook", response: ok() }]);
    vi.stubGlobal("fetch", fetchMock);
    await sendTestNotification("discord");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Slack: throws when unconfigured, sends when configured", async () => {
    await expect(sendTestNotification("slack")).rejects.toThrow("Slack webhook URL isn't set");
    configureSlack();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://slack.example/webhook", response: ok() }]));
    await expect(sendTestNotification("slack")).resolves.toBeUndefined();
  });

  it("Generic: throws when unconfigured, sends when configured", async () => {
    await expect(sendTestNotification("generic")).rejects.toThrow("Generic webhook URL isn't set");
    configureGeneric();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://generic.example/webhook", response: ok() }]));
    await expect(sendTestNotification("generic")).resolves.toBeUndefined();
  });

  it("Telegram: throws when either setting is missing, sends when both are configured", async () => {
    await expect(sendTestNotification("telegram")).rejects.toThrow("Telegram bot token and chat ID must both be set");
    configureTelegram();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://api.telegram.org/botbot-tok/sendMessage", response: ok() }]));
    await expect(sendTestNotification("telegram")).resolves.toBeUndefined();
  });

  it("Pushover: throws when either setting is missing, sends when both are configured", async () => {
    await expect(sendTestNotification("pushover")).rejects.toThrow("Pushover API token and user key must both be set");
    configurePushover();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u === "https://api.pushover.net/1/messages.json", response: ok() }]));
    await expect(sendTestNotification("pushover")).resolves.toBeUndefined();
  });

  it("Matrix: throws when any setting is missing, sends when all three are configured", async () => {
    await expect(sendTestNotification("matrix")).rejects.toThrow("Matrix homeserver URL, access token, and room ID must all be set");
    configureMatrix();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("/_matrix/"), response: ok() }]));
    await expect(sendTestNotification("matrix")).resolves.toBeUndefined();
  });

  it("Twilio: throws when any setting is missing, sends when all four are configured", async () => {
    await expect(sendTestNotification("twilio")).rejects.toThrow("Twilio account SID, auth token, from number, and to number must all be set");
    configureTwilio();
    vi.stubGlobal("fetch", routedFetch([{ test: (u) => u.includes("api.twilio.com"), response: ok() }]));
    await expect(sendTestNotification("twilio")).resolves.toBeUndefined();
  });

  it("SMTP: throws when any setting is missing, sends when host/to/from are configured", async () => {
    await expect(sendTestNotification("smtp")).rejects.toThrow("SMTP host, from, and to must all be set");
    configureSmtp();
    await sendTestNotification("smtp");
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com" }), "AoNarr: AoNarr test notification", expect.any(String));
  });

  it("push: has no 'unconfigured' throw case at all -- always attempts the send", async () => {
    await sendTestNotification("push");
    expect(sendPush).toHaveBeenCalledWith("AoNarr test notification", expect.any(String));
  });

  it("custom script: throws when not enabled or no path is set, runs when configured, and a failure propagates (unlike fanOut's swallowed version)", async () => {
    await expect(sendTestNotification("customScript")).rejects.toThrow("Custom script isn't enabled or has no path set");

    configureCustomScript();
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
    configureDiscord();
    configureSlack();
    configureGeneric();
    configureTelegram();
    configurePushover();
    configureMatrix();
    configureTwilio();
    const fetchMock = vi.fn(async (_url: string, _init?: any) => ok());
    vi.stubGlobal("fetch", fetchMock);

    await notifyGrabbed("X", "Y");

    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a target that never answers is aborted by its signal: fanOut still resolves and a Test send rejects", async () => {
    configureGeneric();
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
    setSetting("discordWebhookUrl", "https://discord.example/api/webhooks/123/super-secret-token");
    vi.stubGlobal("fetch", vi.fn(async () => notOk(429)));

    const err = await sendTestNotification("discord").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("discord.example");
    expect((err as Error).message).toContain("HTTP 429");
    expect((err as Error).message).not.toContain("super-secret-token");
  });

  it("a failing Telegram send doesn't leak the bot token into the error or fanOut's warn log", async () => {
    configureTelegram();
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
    for (const key of ["ntfyServerUrl", "ntfyTopic", "ntfyToken", "gotifyServerUrl", "gotifyToken"]) setSetting(key, "");
    for (const key of ["ntfyEvents", "gotifyEvents"]) deleteSetting(key);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNotificationFailures();
  });

  function configureNtfy(): void {
    setSetting("ntfyServerUrl", "https://ntfy.example");
    setSetting("ntfyTopic", "aonarr");
  }
  function configureGotify(): void {
    setSetting("gotifyServerUrl", "https://gotify.example");
    setSetting("gotifyToken", "gotify-app-token");
  }
  /** Every fetch-based provider answers with this status. */
  function everyWebhookAnswers(status: number): void {
    vi.stubGlobal("fetch", vi.fn(async () => (status === 200 ? ok() : notOk(status))));
  }

  it("reports nothing while no send has failed", async () => {
    configureDiscord();
    everyWebhookAnswers(200);

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()).toEqual([]);
  });

  it("reports a provider only after its sends have failed twice in a row, with how many and what the last error was", async () => {
    configureDiscord();
    everyWebhookAnswers(500);

    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toEqual([]);

    await notifyGrabbed("X", "Y");
    const failing = failingNotificationProviders();
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ provider: "discord", failures: 2, lastError: "Webhook POST to discord.example failed: HTTP 500" });
    expect(new Date(failing[0].since).toISOString()).toBe(failing[0].since);

    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()[0].failures).toBe(3);
  });

  it("takes the number of failures that counts as 'failing' as a parameter", async () => {
    configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders(1).map((f) => f.provider)).toEqual(["discord"]);
    expect(failingNotificationProviders(2).map((f) => f.provider)).toEqual(["discord"]);
    expect(failingNotificationProviders(3)).toEqual([]);
  });

  it("clears a provider with a single successful send, and counts from one again after that", async () => {
    configureDiscord();
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
    configureDiscord();
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
    configureDiscord();
    configureSlack();
    configureGeneric();
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

    expect(failingNotificationProviders().map((f) => f.provider).sort()).toEqual(["discord", "generic webhook"]);
  });

  it("does not count a send that an event filter skipped as either a failure or a success", async () => {
    configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toHaveLength(1);

    setSetting("discordEvents", "imported"); // grabbed is no longer sent to Discord
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()[0].failures).toBe(2);
  });

  // The name is what Health shows, so each provider is recorded under its own readable one.
  // `testKey` is the provider's key on the Settings page's Test button, which is not always the name its sends are recorded under.
  const failWebhook = () => everyWebhookAnswers(500);
  const recoverWebhook = () => everyWebhookAnswers(200);
  const providers: { name: string; testKey: string; configure: () => void; fail: () => void; recover: () => void }[] = [
    { name: "discord", testKey: "discord", configure: configureDiscord, fail: failWebhook, recover: recoverWebhook },
    { name: "slack", testKey: "slack", configure: configureSlack, fail: failWebhook, recover: recoverWebhook },
    { name: "generic webhook", testKey: "generic", configure: configureGeneric, fail: failWebhook, recover: recoverWebhook },
    { name: "telegram", testKey: "telegram", configure: configureTelegram, fail: failWebhook, recover: recoverWebhook },
    { name: "pushover", testKey: "pushover", configure: configurePushover, fail: failWebhook, recover: recoverWebhook },
    { name: "ntfy", testKey: "ntfy", configure: configureNtfy, fail: failWebhook, recover: recoverWebhook },
    { name: "gotify", testKey: "gotify", configure: configureGotify, fail: failWebhook, recover: recoverWebhook },
    { name: "matrix", testKey: "matrix", configure: configureMatrix, fail: failWebhook, recover: recoverWebhook },
    { name: "SMS (Twilio)", testKey: "twilio", configure: configureTwilio, fail: failWebhook, recover: recoverWebhook },
    {
      name: "email",
      testKey: "smtp",
      configure: configureSmtp,
      fail: () => sendEmail.mockRejectedValue(new Error("smtp.example.com refused the connection")),
      recover: () => sendEmail.mockResolvedValue(undefined),
    },
    {
      name: "web push",
      testKey: "push",
      configure: () => {},
      fail: () => sendPush.mockRejectedValue(new Error("push service down")),
      recover: () => sendPush.mockResolvedValue(undefined),
    },
    {
      name: "custom script",
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
    configure();
    fail();
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders().map((f) => f.provider)).toEqual([name]);

    recover();
    await sendTestNotification(testKey);

    expect(failingNotificationProviders(1)).toEqual([]);
  });

  it.each(providers)("leaves a failing $name provider reported when its Test button ($testKey) fails too", async ({ name, testKey, configure, fail }) => {
    configure();
    fail();
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    await expect(sendTestNotification(testKey)).rejects.toThrow();

    const failing = failingNotificationProviders();
    expect(failing.map((f) => f.provider)).toEqual([name]);
    expect(failing[0].failures).toBe(2); // a test is not one more failed send
  });

  it("clears only the provider that was tested", async () => {
    configureDiscord();
    configureSlack();
    vi.stubGlobal("fetch", routedFetch([
      { test: (u) => u === "https://discord.example/webhook", response: notOk(500) },
      { test: (u) => u === "https://slack.example/webhook", response: notOk(500) },
    ]));
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders().map((f) => f.provider).sort()).toEqual(["discord", "slack"]);

    everyWebhookAnswers(200);
    await sendTestNotification("slack");

    expect(failingNotificationProviders().map((f) => f.provider)).toEqual(["discord"]);
  });

  it("a Test of a provider that never failed, or of an unknown key, records nothing", async () => {
    configureDiscord();
    everyWebhookAnswers(200);

    await sendTestNotification("discord");
    await expect(sendTestNotification("carrier-pigeon")).rejects.toThrow("Unknown notification provider");

    expect(failingNotificationProviders(1)).toEqual([]);
  });

  it("stops reporting a provider a day after its last failed send, and reports it again after a new failure", async () => {
    configureDiscord();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-01T10:00:00.000Z");
    const hour = 60 * 60 * 1000;
    vi.setSystemTime(start);
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    vi.setSystemTime(start + 24 * hour - 1000);
    expect(failingNotificationProviders().map((f) => f.provider)).toEqual(["discord"]);

    vi.setSystemTime(start + 24 * hour);
    expect(failingNotificationProviders()).toEqual([]);
    vi.setSystemTime(start + 30 * hour);
    expect(failingNotificationProviders()).toEqual([]);

    // The provider is still configured, and its next send fails as well: it is back.
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders().map((f) => f.provider)).toEqual(["discord"]);
  });

  it("measures the day from the latest failed send, not the first", async () => {
    configureDiscord();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-01T10:00:00.000Z");
    const hour = 60 * 60 * 1000;
    everyWebhookAnswers(500);
    vi.setSystemTime(start);
    await notifyGrabbed("X", "Y");
    vi.setSystemTime(start + 20 * hour);
    await notifyGrabbed("X", "Y");

    vi.setSystemTime(start + 30 * hour); // 30 h after the first failure, 10 h after the latest
    expect(failingNotificationProviders()[0]).toMatchObject({ provider: "discord", failures: 2, since: new Date(start).toISOString() });
  });

  it("does not keep reporting a provider whose settings were cleared, once its failures are a day old", async () => {
    configureDiscord();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-03-01T10:00:00.000Z");
    vi.setSystemTime(start);
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    setSetting("discordWebhookUrl", ""); // the admin switched Discord off; nothing is sent to it any more
    vi.setSystemTime(start + 25 * 60 * 60 * 1000);
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders(1)).toEqual([]);
  });

  it.each(providers)("records a failing $name send under that name", async ({ name, configure, fail }) => {
    configure();
    fail();

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    const failing = failingNotificationProviders();
    expect(failing.map((f) => f.provider)).toEqual([name]);
    expect(failing[0].failures).toBe(2);
    expect(failing[0].lastError).not.toBe("");
  });

  it("records a provider that is set up wrongly (a Gotify URL with no scheme) as failing, with the reason", async () => {
    setSetting("gotifyServerUrl", "gotify.example");
    setSetting("gotifyToken", "gotify-app-token");
    vi.stubGlobal("fetch", vi.fn());

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    expect(failingNotificationProviders()).toMatchObject([
      { provider: "gotify", failures: 2, lastError: "The Gotify server URL must start with http:// or https://" },
    ]);
  });

  it("keeps the secret-bearing URL out of what it remembers, and cuts a very long error to 300 characters", async () => {
    setSetting("discordWebhookUrl", "https://discord.example/api/webhooks/123/super-secret-token");
    everyWebhookAnswers(429);
    configureSmtp();
    sendEmail.mockRejectedValue(new Error("e".repeat(500)));

    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");

    const failing = failingNotificationProviders();
    const discord = failing.find((f) => f.provider === "discord")!;
    expect(discord.lastError).toContain("discord.example");
    expect(JSON.stringify(failing)).not.toContain("super-secret-token");
    expect(failing.find((f) => f.provider === "email")!.lastError).toBe("e".repeat(300));
  });

  it("forgets every failure when reset for a test", async () => {
    configureDiscord();
    everyWebhookAnswers(500);
    await notifyGrabbed("X", "Y");
    await notifyGrabbed("X", "Y");
    expect(failingNotificationProviders()).toHaveLength(1);

    resetNotificationFailures();

    expect(failingNotificationProviders(1)).toEqual([]);
  });
});
