import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";
import { sendPush } from "./push.js";
import { sendEmail } from "./smtp.js";
import { refreshMediaServerLibrary } from "./mediaServer.js";

const execFileAsync = promisify(execFile);

/**
 * Runs an admin-configured local script on each notification event, passing the same data every
 * other provider gets as `AONARR_*` environment variables — the same idea as Sonarr/Radarr's
 * "Custom Script" connection, for whatever automation (a personal Home Assistant call, a local log,
 * anything) a webhook alone can't cover. The script path is instance configuration set by the
 * admin themselves in Settings, not user-supplied input from an external source.
 */
async function runCustomScript(event: string, tokens: Record<string, string>): Promise<void> {
  const enabled = getSetting("customScriptEnabled");
  const scriptPath = getSetting("customScriptPath");
  if (enabled !== "1" || !scriptPath) return;

  const env: NodeJS.ProcessEnv = { ...process.env, AONARR_EVENT: event };
  for (const [key, value] of Object.entries(tokens)) {
    env[`AONARR_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`] = value;
  }

  try {
    await execFileAsync(scriptPath, [], { env, timeout: 30_000 });
  } catch (err) {
    throw new Error(`Custom script failed: ${(err as Error).message}`);
  }
}

// Import/grab paths await fanOut, so a target that accepts the connection but never answers must
// not be left to undici's 300s default.
const NOTIFY_TIMEOUT_MS = 15_000;

/** Webhook URLs (Discord/Slack/generic) and the Telegram API URL embed the credential itself, and
 * these errors land in the persistent log — so they name only the host, never the full URL. */
function describeTarget(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured URL";
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Webhook POST to ${describeTarget(url)} failed: HTTP ${res.status}`);
  }
}

async function postForm(url: string, params: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`POST to ${describeTarget(url)} failed: HTTP ${res.status}`);
  }
}

interface NotificationContent {
  title: string;
  text: string; // plain text, used by Slack/Telegram/Pushover/generic
  color: number; // Discord embed color
  payload: Record<string, unknown>; // generic webhook body
}

/** Sonarr/Radarr-style per-connection event triggers: each provider has an optional
 * `<providerKey>Events` setting, a comma-separated subset of EVENT_KEYS. Unset means "every event"
 * — the pre-existing behavior — so upgrading doesn't silently mute anyone's existing setup. */
export const EVENT_KEYS = [
  "grabbed",
  "imported",
  "upgraded",
  "failed",
  "duplicatesFound",
  "healthIssue",
  "healthRestored",
  "manualInteractionRequired",
  "updateAvailable",
  "added",
  "deleted",
  "renamed",
  "fileDeleted",
] as const;
export type EventKey = (typeof EVENT_KEYS)[number];

/**
 * Events added after providers already existed. A connection that never saved an event list used to get
 * "every event", which stays true for the events it knew; these arrive in bulk (a list adds a hundred
 * titles, a rename touches a whole library), so a connection gets one only when its list names it.
 */
const OPT_IN_EVENTS: ReadonlySet<string> = new Set(["added", "deleted", "renamed", "fileDeleted"]);

export function isEventEnabledFor(providerKey: string, event: string): boolean {
  const raw = getSetting(`${providerKey}Events`);
  // A truly-unset setting (never saved) means "every event" — but an explicitly-saved empty
  // string means every event was deliberately unchecked, which must NOT also mean "every event"
  // (the empty-string split below already correctly evaluates to false for a real event key once
  // this distinguishes the two instead of treating both as falsy).
  if (raw == null) return !OPT_IN_EVENTS.has(event);
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(event);
}

/**
 * A server URL the admin typed, checked without echoing it: one typed without its scheme made fetch throw an
 * error that quoted the whole URL, and these errors land in the persistent log.
 */
function serverBase(server: string, name: string): string {
  let url: URL;
  try {
    url = new URL(server.trim());
  } catch {
    throw new Error(`The ${name} server URL must start with http:// or https://`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`The ${name} server URL must start with http:// or https://`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** ntfy.sh or a self-hosted ntfy: the message is the body, the title a header. A token (if the topic is protected) is sent as a bearer. */
async function sendNtfy(server: string, topic: string, token: string, title: string, text: string): Promise<void> {
  const url = `${serverBase(server, "ntfy")}/${encodeURIComponent(topic)}`;
  const headers: Record<string, string> = { Title: title.replace(/[^\x20-\x7e]/g, "?") };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: text, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ntfy send to ${describeTarget(url)} failed: HTTP ${res.status}`);
}

/** Gotify: the application token travels in a header, never in the URL, so no error or log line can carry it. */
async function sendGotify(server: string, token: string, title: string, text: string): Promise<void> {
  const url = `${serverBase(server, "Gotify")}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gotify-Key": token },
    body: JSON.stringify({ title, message: text, priority: 5 }),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gotify send to ${describeTarget(url)} failed: HTTP ${res.status}`);
}

async function fanOut(content: NotificationContent): Promise<void> {
  const event = (content.payload as { event: string }).event;
  const discordUrl = getSetting("discordWebhookUrl");
  const slackUrl = getSetting("slackWebhookUrl");
  const genericUrl = getSetting("genericWebhookUrl");
  const telegramBotToken = getSetting("telegramBotToken");
  const telegramChatId = getSetting("telegramChatId");
  const pushoverApiToken = getSetting("pushoverApiToken");
  const pushoverUserKey = getSetting("pushoverUserKey");

  const jobs: Promise<void>[] = [];

  if (discordUrl && isEventEnabledFor("discord", event)) {
    jobs.push(
      postJson(discordUrl, { embeds: [{ title: content.title, description: content.text, color: content.color }] })
    );
  }
  if (slackUrl && isEventEnabledFor("slack", event)) {
    jobs.push(postJson(slackUrl, { text: `*${content.title}*\n${content.text}` }));
  }
  if (genericUrl && isEventEnabledFor("generic", event)) {
    jobs.push(postJson(genericUrl, content.payload));
  }
  if (telegramBotToken && telegramChatId && isEventEnabledFor("telegram", event)) {
    jobs.push(
      postForm(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        chat_id: telegramChatId,
        text: `${content.title}\n${content.text}`,
      })
    );
  }
  if (pushoverApiToken && pushoverUserKey && isEventEnabledFor("pushover", event)) {
    jobs.push(
      postForm("https://api.pushover.net/1/messages.json", {
        token: pushoverApiToken,
        user: pushoverUserKey,
        title: content.title,
        message: content.text,
      })
    );
  }

  const ntfyServer = getSetting("ntfyServerUrl");
  const ntfyTopic = getSetting("ntfyTopic");
  if (ntfyServer && ntfyTopic && isEventEnabledFor("ntfy", event)) {
    jobs.push(sendNtfy(ntfyServer, ntfyTopic, getSetting("ntfyToken") ?? "", content.title, content.text));
  }
  const gotifyServer = getSetting("gotifyServerUrl");
  const gotifyToken = getSetting("gotifyToken");
  if (gotifyServer && gotifyToken && isEventEnabledFor("gotify", event)) {
    jobs.push(sendGotify(gotifyServer, gotifyToken, content.title, content.text));
  }

  const matrixHomeserver = getSetting("matrixHomeserverUrl");
  const matrixAccessToken = getSetting("matrixAccessToken");
  const matrixRoomId = getSetting("matrixRoomId");
  if (matrixHomeserver && matrixAccessToken && matrixRoomId && isEventEnabledFor("matrix", event)) {
    const txnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `${matrixHomeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(
      matrixRoomId
    )}/send/m.room.message/${txnId}?access_token=${encodeURIComponent(matrixAccessToken)}`;
    jobs.push(
      (async () => {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "m.text", body: `${content.title}\n${content.text}` }),
          signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Matrix send failed: HTTP ${res.status}`);
      })()
    );
  }

  const twilioSid = getSetting("twilioAccountSid");
  const twilioToken = getSetting("twilioAuthToken");
  const twilioFrom = getSetting("twilioFromNumber");
  const twilioTo = getSetting("twilioToNumber");
  if (twilioSid && twilioToken && twilioFrom && twilioTo && isEventEnabledFor("twilio", event)) {
    jobs.push(
      (async () => {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ From: twilioFrom, To: twilioTo, Body: `${content.title}: ${content.text}` }),
          signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`SMS (Twilio) send failed: HTTP ${res.status}`);
      })()
    );
  }

  const smtpHost = getSetting("smtpHost");
  const smtpTo = getSetting("smtpTo");
  const smtpFrom = getSetting("smtpFrom");
  if (smtpHost && smtpTo && smtpFrom && isEventEnabledFor("smtp", event)) {
    jobs.push(
      sendEmail(
        {
          host: smtpHost,
          port: Number(getSetting("smtpPort") || 587),
          secure: getSetting("smtpSecure") === "1",
          username: getSetting("smtpUsername") || undefined,
          password: getSetting("smtpPassword") || undefined,
          from: smtpFrom,
          to: smtpTo,
        },
        `AoNarr: ${content.title}`,
        content.text
      )
    );
  }

  // Web push always fans out too — it has no separate "configured" gate since it's opt-in per
  // browser (no subscriptions means no-op), unlike the webhook/bot providers above.
  if (isEventEnabledFor("push", event)) jobs.push(sendPush(content.title, content.text));

  if (isEventEnabledFor("customScript", event)) {
    const { event: _event, ...tokens } = content.payload as { event: string } & Record<string, string>;
    jobs.push(runCustomScript(event, tokens));
  }

  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === "rejected") log.warn("[notifications]", s.reason?.message ?? s.reason);
  }
}

const DEFAULT_TEMPLATES = {
  grabbed: "{mediaTitle}\n{releaseTitle}",
  imported: "{mediaTitle}\n{fileName}",
  upgraded: "{mediaTitle}\n{fileName}",
  failed: "{mediaTitle}: {reason}",
  duplicatesFound: "{count} new duplicate group(s) found: {titles}",
  healthIssue: "{summary}",
  manualInteractionRequired: "{mediaTitle}: {reason}",
  updateAvailable: "{title}",
  added: "{mediaTitle} ({mediaType})",
  deleted: "{mediaTitle}{filesNote}",
  renamed: "{mediaTitle}: {count} file(s)",
  fileDeleted: "{mediaTitle}: {fileName}",
};

/** Renders a {token}-based template from Settings, falling back to the built-in default when
 * unset or when it references a token this event doesn't have (rather than leaving a literal
 * "{typo}" in the sent message). */
function renderTemplate(settingKey: string, defaultTemplate: string, tokens: Record<string, string>): string {
  const template = getSetting(settingKey) || defaultTemplate;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in tokens ? tokens[key] : match));
}

export async function notifyGrabbed(mediaTitle: string, releaseTitle: string): Promise<void> {
  await fanOut({
    title: "Grabbed",
    text: renderTemplate("notifyTemplateGrabbed", DEFAULT_TEMPLATES.grabbed, { mediaTitle, releaseTitle }),
    color: 0x4f8cff,
    payload: { event: "grabbed", mediaTitle, releaseTitle },
  });
}

/**
 * `filePath` is separate from the human-readable `fileName` shown in the notification text — it's
 * only used, when present, to tell the configured media server to pick up the new file (see
 * mediaServer.ts's refreshMediaServerLibrary) rather than waiting for its own scan interval. Opt-in
 * via the `mediaServerRefreshOnImport` setting, off by default so upgrading doesn't change behavior
 * for anyone who already has a media server configured just for watch-state sync.
 */
export async function notifyImported(mediaTitle: string, fileName: string, filePath?: string): Promise<void> {
  await fanOut({
    title: "Imported",
    text: renderTemplate("notifyTemplateImported", DEFAULT_TEMPLATES.imported, { mediaTitle, fileName }),
    color: 0x4fbf6a,
    payload: { event: "imported", mediaTitle, fileName },
  });

  if (filePath && getSetting("mediaServerRefreshOnImport") === "1") {
    refreshMediaServerLibrary(filePath).catch((err) => log.warn("[notifications] media server refresh failed:", err.message));
  }
}

/** Fired instead of notifyImported when the import replaces a file the item already had — Radarr/
 * Sonarr's "On Upgrade" event, distinct from a first-time import so a notification provider can be
 * configured to care about one but not the other. */
export async function notifyUpgraded(mediaTitle: string, fileName: string, filePath?: string): Promise<void> {
  await fanOut({
    title: "Upgraded",
    text: renderTemplate("notifyTemplateUpgraded", DEFAULT_TEMPLATES.upgraded, { mediaTitle, fileName }),
    color: 0x8f6fff,
    payload: { event: "upgraded", mediaTitle, fileName },
  });

  if (filePath && getSetting("mediaServerRefreshOnImport") === "1") {
    refreshMediaServerLibrary(filePath).catch((err) => log.warn("[notifications] media server refresh failed:", err.message));
  }
}

/** Radarr/Sonarr v4+'s "On Manual Interaction Required" — a download finished but couldn't be
 * auto-imported unambiguously (e.g. a season pack whose files couldn't be matched to known
 * episodes), distinct from "Failed" — the download itself succeeded, it just needs a person to
 * pick via the Activity page's "Manual import..." rather than being retried automatically the way
 * an actually-failed grab is. */
export async function notifyManualInteractionRequired(mediaTitle: string, reason: string): Promise<void> {
  await fanOut({
    title: "Manual interaction required",
    text: renderTemplate("notifyTemplateManualInteractionRequired", DEFAULT_TEMPLATES.manualInteractionRequired, { mediaTitle, reason }),
    color: 0xe0a95c,
    payload: { event: "manualInteractionRequired", mediaTitle, reason },
  });
}

/** Fired by the scheduler's own daily update-check job (see scheduler.ts's checkAndNotifyUpdate),
 * not the on-demand System page fetch — same "push, not just pull" reasoning as On Health Issue. */
export async function notifyUpdateAvailable(title: string): Promise<void> {
  await fanOut({
    title: "Update available",
    text: renderTemplate("notifyTemplateUpdateAvailable", DEFAULT_TEMPLATES.updateAvailable, { title }),
    color: 0x4fbf6a,
    payload: { event: "updateAvailable", title },
  });
}

/** Sonarr's "On Series Add" and Radarr's "On Movie Added": a title entered the library, by hand, from a list or from a request. */
export async function notifyAdded(mediaTitle: string, mediaType: string): Promise<void> {
  await fanOut({
    title: "Added",
    text: renderTemplate("notifyTemplateAdded", DEFAULT_TEMPLATES.added, { mediaTitle, mediaType }),
    color: 0x4f8cff,
    payload: { event: "added", mediaTitle, mediaType },
  });
}

/** "On Series Delete" and "On Movie Delete". `deletedFiles`: the files went to the recycle bin with the title. */
export async function notifyDeleted(mediaTitle: string, mediaType: string, deletedFiles: boolean): Promise<void> {
  await fanOut({
    title: "Deleted",
    text: renderTemplate("notifyTemplateDeleted", DEFAULT_TEMPLATES.deleted, { mediaTitle, filesNote: deletedFiles ? " (files deleted too)" : "" }),
    color: 0xe05c5c,
    payload: { event: "deleted", mediaTitle, mediaType, deletedFiles },
  });
}

/** "On Rename": Organize & Rename moved or renamed files of one title. */
export async function notifyRenamed(mediaTitle: string, count: number): Promise<void> {
  await fanOut({
    title: "Renamed",
    text: renderTemplate("notifyTemplateRenamed", DEFAULT_TEMPLATES.renamed, { mediaTitle, count: String(count) }),
    color: 0x4f8cff,
    payload: { event: "renamed", mediaTitle, count },
  });
}

/** "On Episode File Delete" and "On Movie File Delete": one file was deleted from a title that stays in the library. */
export async function notifyFileDeleted(mediaTitle: string, fileName: string): Promise<void> {
  await fanOut({
    title: "File deleted",
    text: renderTemplate("notifyTemplateFileDeleted", DEFAULT_TEMPLATES.fileDeleted, { mediaTitle, fileName }),
    color: 0xe0a95c,
    payload: { event: "fileDeleted", mediaTitle, fileName },
  });
}

export async function notifyFailed(mediaTitle: string, reason: string): Promise<void> {
  await fanOut({
    title: "Failed",
    text: renderTemplate("notifyTemplateFailed", DEFAULT_TEMPLATES.failed, { mediaTitle, reason }),
    color: 0xe05c5c,
    payload: { event: "failed", mediaTitle, reason },
  });
}

/** `sampleTitles` is a short preview (a handful of titles), not every new group — the full list is
 * always available on the Duplicates page, this is just enough for the notification to be useful
 * at a glance without becoming an unreadable wall of text for a library with dozens of new hits. */
export async function notifyDuplicatesFound(count: number, sampleTitles: string[]): Promise<void> {
  const titles = sampleTitles.join(", ") + (count > sampleTitles.length ? ", ..." : "");
  await fanOut({
    title: "Duplicates found",
    text: renderTemplate("notifyTemplateDuplicatesFound", DEFAULT_TEMPLATES.duplicatesFound, { count: String(count), titles }),
    color: 0xe0a95c,
    payload: { event: "duplicatesFound", count, titles: sampleTitles },
  });
}

/**
 * Radarr/Sonarr's "Test" button per notification connection — sends a fixed message to exactly
 * one provider, ignoring its event-filter setting entirely (a test should always go through
 * regardless of which events that provider is configured to care about) so an admin can verify
 * credentials/URL are right without waiting for (or faking) a real grab/import/failure. Throws a
 * descriptive error when the provider isn't configured, rather than silently no-op'ing.
 */
export async function sendTestNotification(providerKey: string): Promise<void> {
  const title = "AoNarr test notification";
  const text = "If you're seeing this, this connection is configured correctly.";
  const payload = { event: "test", title, text };

  switch (providerKey) {
    case "discord": {
      const url = getSetting("discordWebhookUrl");
      if (!url) throw new Error("Discord webhook URL isn't set");
      await postJson(url, { embeds: [{ title, description: text, color: 0x4f8cff }] });
      return;
    }
    case "slack": {
      const url = getSetting("slackWebhookUrl");
      if (!url) throw new Error("Slack webhook URL isn't set");
      await postJson(url, { text: `*${title}*\n${text}` });
      return;
    }
    case "generic": {
      const url = getSetting("genericWebhookUrl");
      if (!url) throw new Error("Generic webhook URL isn't set");
      await postJson(url, payload);
      return;
    }
    case "telegram": {
      const botToken = getSetting("telegramBotToken");
      const chatId = getSetting("telegramChatId");
      if (!botToken || !chatId) throw new Error("Telegram bot token and chat ID must both be set");
      await postForm(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: `${title}\n${text}` });
      return;
    }
    case "pushover": {
      const apiToken = getSetting("pushoverApiToken");
      const userKey = getSetting("pushoverUserKey");
      if (!apiToken || !userKey) throw new Error("Pushover API token and user key must both be set");
      await postForm("https://api.pushover.net/1/messages.json", { token: apiToken, user: userKey, title, message: text });
      return;
    }
    case "matrix": {
      const homeserver = getSetting("matrixHomeserverUrl");
      const accessToken = getSetting("matrixAccessToken");
      const roomId = getSetting("matrixRoomId");
      if (!homeserver || !accessToken || !roomId) throw new Error("Matrix homeserver URL, access token, and room ID must all be set");
      const txnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}?access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: `${title}\n${text}` }),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Matrix send failed: HTTP ${res.status}`);
      return;
    }
    case "twilio": {
      const sid = getSetting("twilioAccountSid");
      const token = getSetting("twilioAuthToken");
      const from = getSetting("twilioFromNumber");
      const to = getSetting("twilioToNumber");
      if (!sid || !token || !from || !to) throw new Error("Twilio account SID, auth token, from number, and to number must all be set");
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: `${title}: ${text}` }),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`SMS (Twilio) send failed: HTTP ${res.status}`);
      return;
    }
    case "smtp": {
      const host = getSetting("smtpHost");
      const to = getSetting("smtpTo");
      const from = getSetting("smtpFrom");
      if (!host || !to || !from) throw new Error("SMTP host, from, and to must all be set");
      await sendEmail(
        {
          host,
          port: Number(getSetting("smtpPort") || 587),
          secure: getSetting("smtpSecure") === "1",
          username: getSetting("smtpUsername") || undefined,
          password: getSetting("smtpPassword") || undefined,
          from,
          to,
        },
        `AoNarr: ${title}`,
        text
      );
      return;
    }
    case "ntfy": {
      const server = getSetting("ntfyServerUrl");
      const topic = getSetting("ntfyTopic");
      if (!server || !topic) throw new Error("ntfy server URL and topic must both be set");
      await sendNtfy(server, topic, getSetting("ntfyToken") ?? "", title, text);
      return;
    }
    case "gotify": {
      const server = getSetting("gotifyServerUrl");
      const token = getSetting("gotifyToken");
      if (!server || !token) throw new Error("Gotify server URL and application token must both be set");
      await sendGotify(server, token, title, text);
      return;
    }
    case "push":
      await sendPush(title, text);
      return;
    case "customScript": {
      if (getSetting("customScriptEnabled") !== "1" || !getSetting("customScriptPath")) {
        throw new Error("Custom script isn't enabled or has no path set");
      }
      await runCustomScript("test", { title, text });
      return;
    }
    default:
      throw new Error(`Unknown notification provider "${providerKey}"`);
  }
}

/** Radarr/Sonarr-style "On Health Issue" — fired by the scheduler's own periodic health check
 * (see scheduler.ts's checkHealthAndNotify), not from the on-demand System page GET, so an admin
 * who isn't actively looking at the System page still finds out. `summary` is a short, human
 * combined description of everything currently wrong, not a single-issue message — kept as one
 * notification per check rather than one per problem, so a bad indexer + low disk space doesn't
 * spam every configured provider twice in the same minute. */
export async function notifyHealthIssue(summary: string): Promise<void> {
  await fanOut({
    title: "Health issue",
    text: renderTemplate("notifyTemplateHealthIssue", DEFAULT_TEMPLATES.healthIssue, { summary }),
    color: 0xe05c5c,
    payload: { event: "healthIssue", summary },
  });
}

/** The "restored" half of the health notification (Sonarr sends both): everything the last "Health issue" listed has
 * cleared. Its own event key, so a webhook that acts on "healthIssue" is not raised when everything is fine again. */
export async function notifyHealthRestored(previousSummary: string): Promise<void> {
  const shown = previousSummary.length > 1500 ? `${previousSummary.slice(0, 1500)}...` : previousSummary;
  await fanOut({
    title: "Health restored",
    text: `Everything is healthy again. It had been reporting: ${shown}`,
    color: 0x4fbf6a,
    payload: { event: "healthRestored", summary: previousSummary },
  });
}
