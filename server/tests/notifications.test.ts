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
