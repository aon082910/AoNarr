import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";
import { sendPush } from "./push.js";
import { sendEmail } from "./smtp.js";
import { refreshMediaServerLibrary } from "./mediaServer.js";
import {
  CONNECTION_KIND_KEYS,
  EVENT_KEYS,
  eventAllowed,
  firstConnectionOfKind,
  kindSpec,
  labelOf,
  listNotificationConnections,
  missingRequiredField,
  secretsOf,
  type ConnectionKind,
  type EventKey,
  type NotificationConnection,
} from "./notificationConnections.js";
import { notificationSendStarted, recordNotificationOutcome } from "./notificationStatus.js";
import { buildStarrPayload, mediaFromRow, type NotifyContext, type NotifyEpisode, type ResolvedNotifyContext } from "./notificationPayloads.js";
import { scopeAllows, tagIdsOfItem } from "./tagScope.js";

export { EVENT_KEYS, eventAllowed, type EventKey };
export { failingNotificationProviders, __resetNotificationFailuresForTests } from "./notificationStatus.js";
export type { NotifyContext } from "./notificationPayloads.js";

const execFileAsync = promisify(execFile);

/**
 * Runs an admin-configured local script on each notification event, passing the same data every
 * other connection gets as `AONARR_*` environment variables — the same idea as Sonarr/Radarr's
 * "Custom Script" connection, for whatever automation (a personal Home Assistant call, a local log,
 * anything) a webhook alone can't cover. The script path is instance configuration set by the
 * admin themselves in Settings, not user-supplied input from an external source.
 */
async function runCustomScript(scriptPath: string, event: string, tokens: Record<string, string>): Promise<void> {
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

/**
 * A URL the admin typed, checked without echoing it: one typed without its scheme made fetch throw an error that
 * quoted the whole URL, and for a webhook that URL is the credential.
 */
function checkedUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`The ${name} URL must start with http:// or https://`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`The ${name} URL must start with http:// or https://`);
  return raw.trim();
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(checkedUrl(url, "webhook"), {
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

/** A generic webhook: the URL, the method, extra headers and basic auth are the connection's own, and the body is
 * AoNarr's payload or the one Sonarr and Radarr send. */
async function sendWebhook(config: Record<string, any>, content: NotificationContent, ctx: ResolvedNotifyContext): Promise<void> {
  const url = checkedUrl(str(config.url), "webhook");
  const method = config.method === "PUT" ? "PUT" : "POST";
  const headers = new Map<string, [string, string]>([["content-type", ["Content-Type", "application/json"]]]);
  for (const h of Array.isArray(config.headers) ? (config.headers as { name: string; value: string }[]) : []) headers.set(h.name.toLowerCase(), [h.name, h.value]);
  if ((config.username || config.password) && !headers.has("authorization")) {
    headers.set("authorization", ["Authorization", `Basic ${Buffer.from(`${str(config.username)}:${str(config.password)}`).toString("base64")}`]);
  }
  const body = config.payloadStyle === "starr" ? buildStarrPayload(content, ctx) : content.payload;
  const res = await fetch(url, {
    method,
    headers: Object.fromEntries(headers.values()),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Webhook ${method} to ${describeTarget(url)} failed: HTTP ${res.status}`);
}

const str = (value: unknown): string => (value == null ? "" : String(value));

type Sender = (config: Record<string, any>, content: NotificationContent, ctx: ResolvedNotifyContext) => Promise<void>;

/** How each kind of connection delivers a message. A kind's required fields are checked before this runs. */
const SENDERS: Record<ConnectionKind, Sender> = {
  discord: (c, content) => postJson(str(c.webhookUrl), { embeds: [{ title: content.title, description: content.text, color: content.color }] }),
  slack: (c, content) => postJson(str(c.webhookUrl), { text: `*${content.title}*\n${content.text}` }),
  webhook: sendWebhook,
  telegram: (c, content) => postForm(`https://api.telegram.org/bot${str(c.botToken)}/sendMessage`, { chat_id: str(c.chatId), text: `${content.title}\n${content.text}` }),
  pushover: (c, content) => postForm("https://api.pushover.net/1/messages.json", { token: str(c.apiToken), user: str(c.userKey), title: content.title, message: content.text }),
  ntfy: (c, content) => sendNtfy(str(c.serverUrl), str(c.topic), str(c.token), content.title, content.text),
  gotify: (c, content) => sendGotify(str(c.serverUrl), str(c.token), content.title, content.text),
  matrix: async (c, content) => {
    const txnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `${serverBase(str(c.homeserverUrl), "Matrix")}/_matrix/client/v3/rooms/${encodeURIComponent(str(c.roomId))}/send/m.room.message/${txnId}?access_token=${encodeURIComponent(str(c.accessToken))}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: `${content.title}\n${content.text}` }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Matrix send failed: HTTP ${res.status}`);
  },
  twilio: async (c, content) => {
    const sid = str(c.accountSid);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${str(c.authToken)}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: str(c.fromNumber), To: str(c.toNumber), Body: `${content.title}: ${content.text}` }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SMS (Twilio) send failed: HTTP ${res.status}`);
  },
  email: (c, content) =>
    sendEmail(
      {
        host: str(c.host),
        port: Number(c.port || 587),
        secure: c.secure === true,
        username: str(c.username) || undefined,
        password: str(c.password) || undefined,
        from: str(c.from),
        to: str(c.to),
      },
      `AoNarr: ${content.title}`,
      content.text
    ),
  customScript: (c, content) => {
    const { event, ...tokens } = content.payload as { event: string } & Record<string, string>;
    return runCustomScript(str(c.path), event, tokens);
  },
  // Web push has no per-connection address: it goes to every browser that subscribed.
  webPush: (_c, content) => sendPush(content.title, content.text),
};

/** Replaces any of a connection's secrets that ended up in an error message, so neither the log, Health nor the
 * Test button's answer can show one. (The senders already name only a host; this is the net under them.) */
function scrubbed(err: unknown, secrets: string[]): Error {
  let message = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) message = message.split(secret).join("[hidden]");
  return new Error(message);
}

/** One connection's send. Throws what went wrong, in words that carry no secret. */
async function deliver(conn: NotificationConnection, content: NotificationContent, ctx: ResolvedNotifyContext): Promise<void> {
  const missing = missingRequiredField(conn);
  if (missing) throw new Error(`The ${labelOf(conn)} connection has no ${missing} (if it was saved before, it may need to be entered again)`);
  try {
    await SENDERS[conn.kind](conn.config, content, ctx);
  } catch (err) {
    throw scrubbed(err, secretsOf(conn));
  }
}

/** Events that are about one title, and so can be held back from a connection scoped to tags the title does not carry.
 * The others (health, updates, duplicates) are about the instance. */
const TITLE_EVENTS: ReadonlySet<string> = new Set(["grabbed", "imported", "upgraded", "failed", "manualInteractionRequired", "added", "deleted", "renamed", "fileDeleted"]);

/** The most episodes a Sonarr-shaped body lists (a season pack can name every episode of a long season). */
const MAX_EPISODES_IN_PAYLOAD = 200;

/** The title and episodes a Sonarr/Radarr-shaped body names, looked up when the caller only gave their ids. */
async function resolveContext(ctx: NotifyContext): Promise<ResolvedNotifyContext> {
  const resolved: ResolvedNotifyContext = { ...ctx };
  try {
    if (!resolved.media && ctx.mediaItemId) {
      const row = await db
        .prepare("SELECT id, type, title, year, path, external_ids, release_date, series_type FROM media_items WHERE id = ?")
        .get(ctx.mediaItemId);
      if (row) resolved.media = mediaFromRow(row);
    }
    const ids = (ctx.episodeIds ?? []).slice(0, MAX_EPISODES_IN_PAYLOAD);
    if (ids.length > 0) {
      const rows = (await db
        .prepare(`SELECT id, season_number, episode_number, title, air_date FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY season_number, episode_number`)
        .all(...ids)) as { id: number; season_number: number; episode_number: number; title: string | null; air_date: string | null }[];
      resolved.episodes = rows.map((r): NotifyEpisode => ({ id: Number(r.id), seasonNumber: Number(r.season_number), episodeNumber: Number(r.episode_number), title: r.title, airDate: r.air_date }));
    }
  } catch (err) {
    log.warn("[notifications] couldn't look up the title for a webhook body:", (err as Error).message);
  }
  return resolved;
}

async function fanOut(content: NotificationContent, ctx: NotifyContext = {}): Promise<void> {
  const event = (content.payload as { event: string }).event;
  // Noted before anything is read: a connection deleted, switched off or fixed from here until its send answers must not
  // get its failure back into Health.
  const startedAt = notificationSendStarted();

  // Notifications must never break the grab, the import or the health check that fired them.
  let connections: NotificationConnection[];
  try {
    connections = (await listNotificationConnections()).filter((c) => c.enabled && eventAllowed(c.events, event));
  } catch (err) {
    log.warn("[notifications] couldn't read the notification connections:", (err as Error).message);
    return;
  }

  // A connection scoped to tags hears of a title only when the title carries one of them.
  if (TITLE_EVENTS.has(event) && connections.some((c) => c.tagIds.length > 0)) {
    let itemTags = ctx.tagIds;
    if (!itemTags) itemTags = await tagIdsOfItem(ctx.mediaItemId).catch(() => []);
    connections = connections.filter((c) => scopeAllows(c.tagIds, itemTags!));
  }
  if (connections.length === 0) return;

  const detailed = connections.some((c) => c.kind === "webhook" && c.config.payloadStyle === "starr") ? await resolveContext(ctx) : ctx;

  const settled = await Promise.allSettled(connections.map((c) => deliver(c, content, detailed)));
  settled.forEach((s, i) => {
    const conn = connections[i];
    const target = { id: conn.id, kind: conn.kind, label: labelOf(conn) };
    if (s.status === "rejected") {
      const message = s.reason?.message ?? String(s.reason);
      log.warn("[notifications]", `${target.label}: ${message}`);
      recordNotificationOutcome(target, false, message, startedAt);
    } else {
      recordNotificationOutcome(target, true);
    }
  });
}

// --- templates ---------------------------------------------------------------------------------------------------

/** The message text of each event: the setting that overrides it, the built-in default and the tokens it can use. */
export const NOTIFICATION_TEMPLATES: { event: EventKey; label: string; key: string; default: string; tokens: string[] }[] = [
  { event: "grabbed", label: "Grabbed", key: "notifyTemplateGrabbed", default: "{mediaTitle}\n{releaseTitle}", tokens: ["mediaTitle", "releaseTitle"] },
  { event: "imported", label: "Imported", key: "notifyTemplateImported", default: "{mediaTitle}\n{fileName}", tokens: ["mediaTitle", "fileName"] },
  { event: "upgraded", label: "Upgraded", key: "notifyTemplateUpgraded", default: "{mediaTitle}\n{fileName}", tokens: ["mediaTitle", "fileName"] },
  { event: "failed", label: "Failed", key: "notifyTemplateFailed", default: "{mediaTitle}: {reason}", tokens: ["mediaTitle", "reason"] },
  { event: "duplicatesFound", label: "Duplicates found", key: "notifyTemplateDuplicatesFound", default: "{count} new duplicate group(s) found: {titles}", tokens: ["count", "titles"] },
  { event: "healthIssue", label: "Health issue", key: "notifyTemplateHealthIssue", default: "{summary}", tokens: ["summary"] },
  { event: "healthRestored", label: "Health restored", key: "notifyTemplateHealthRestored", default: "Everything is healthy again. It had been reporting: {summary}", tokens: ["summary"] },
  { event: "manualInteractionRequired", label: "Manual interaction required", key: "notifyTemplateManualInteractionRequired", default: "{mediaTitle}: {reason}", tokens: ["mediaTitle", "reason"] },
  { event: "updateAvailable", label: "Update available", key: "notifyTemplateUpdateAvailable", default: "{title}", tokens: ["title"] },
  { event: "added", label: "Title added", key: "notifyTemplateAdded", default: "{mediaTitle} ({mediaType})", tokens: ["mediaTitle", "mediaType"] },
  { event: "deleted", label: "Title deleted", key: "notifyTemplateDeleted", default: "{mediaTitle}{filesNote}", tokens: ["mediaTitle", "mediaType", "filesNote"] },
  { event: "renamed", label: "Files renamed", key: "notifyTemplateRenamed", default: "{mediaTitle}: {count} file(s)", tokens: ["mediaTitle", "count"] },
  { event: "fileDeleted", label: "File deleted", key: "notifyTemplateFileDeleted", default: "{mediaTitle}: {fileName}", tokens: ["mediaTitle", "fileName"] },
];

/** Renders an event's {token}-based template from Settings, falling back to the built-in default when
 * unset or when it references a token this event doesn't have (rather than leaving a literal
 * "{typo}" in the sent message). */
function renderTemplate(event: EventKey, tokens: Record<string, string>): string {
  const t = NOTIFICATION_TEMPLATES.find((tpl) => tpl.event === event)!;
  const template = getSetting(t.key) || t.default;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in tokens ? tokens[key] : match));
}

export async function notifyGrabbed(mediaTitle: string, releaseTitle: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Grabbed",
      text: renderTemplate("grabbed", { mediaTitle, releaseTitle }),
      color: 0x4f8cff,
      payload: { event: "grabbed", mediaTitle, releaseTitle },
    },
    ctx
  );
}

/**
 * `filePath` is separate from the human-readable `fileName` shown in the notification text — it's
 * only used, when present, to tell the configured media server to pick up the new file (see
 * mediaServer.ts's refreshMediaServerLibrary) rather than waiting for its own scan interval. Opt-in
 * via the `mediaServerRefreshOnImport` setting, off by default so upgrading doesn't change behavior
 * for anyone who already has a media server configured just for watch-state sync.
 */
export async function notifyImported(mediaTitle: string, fileName: string, filePath?: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Imported",
      text: renderTemplate("imported", { mediaTitle, fileName }),
      color: 0x4fbf6a,
      payload: { event: "imported", mediaTitle, fileName },
    },
    ctx
  );

  if (filePath && getSetting("mediaServerRefreshOnImport") === "1") {
    refreshMediaServerLibrary(filePath).catch((err) => log.warn("[notifications] media server refresh failed:", err.message));
  }
}

/** Fired instead of notifyImported when the import replaces a file the item already had — Radarr/
 * Sonarr's "On Upgrade" event, distinct from a first-time import so a notification connection can be
 * configured to care about one but not the other. */
export async function notifyUpgraded(mediaTitle: string, fileName: string, filePath?: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Upgraded",
      text: renderTemplate("upgraded", { mediaTitle, fileName }),
      color: 0x8f6fff,
      payload: { event: "upgraded", mediaTitle, fileName },
    },
    ctx
  );

  if (filePath && getSetting("mediaServerRefreshOnImport") === "1") {
    refreshMediaServerLibrary(filePath).catch((err) => log.warn("[notifications] media server refresh failed:", err.message));
  }
}

/** Radarr/Sonarr v4+'s "On Manual Interaction Required" — a download finished but couldn't be
 * auto-imported unambiguously (e.g. a season pack whose files couldn't be matched to known
 * episodes), distinct from "Failed" — the download itself succeeded, it just needs a person to
 * pick via the Activity page's "Manual import..." rather than being retried automatically the way
 * an actually-failed grab is. */
export async function notifyManualInteractionRequired(mediaTitle: string, reason: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Manual interaction required",
      text: renderTemplate("manualInteractionRequired", { mediaTitle, reason }),
      color: 0xe0a95c,
      payload: { event: "manualInteractionRequired", mediaTitle, reason },
    },
    ctx
  );
}

/** Fired by the scheduler's own daily update-check job (see scheduler.ts's checkAndNotifyUpdate),
 * not the on-demand System page fetch — same "push, not just pull" reasoning as On Health Issue. */
export async function notifyUpdateAvailable(title: string): Promise<void> {
  await fanOut({
    title: "Update available",
    text: renderTemplate("updateAvailable", { title }),
    color: 0x4fbf6a,
    payload: { event: "updateAvailable", title },
  });
}

/** Sonarr's "On Series Add" and Radarr's "On Movie Added": a title entered the library, by hand, from a list or from a request. */
export async function notifyAdded(mediaTitle: string, mediaType: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Added",
      text: renderTemplate("added", { mediaTitle, mediaType }),
      color: 0x4f8cff,
      payload: { event: "added", mediaTitle, mediaType },
    },
    ctx
  );
}

/** "On Series Delete" and "On Movie Delete". `deletedFiles`: the files went to the recycle bin with the title. The title's row
 * and tags are gone by the time this is sent, so the caller passes them in the context. */
export async function notifyDeleted(mediaTitle: string, mediaType: string, deletedFiles: boolean, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Deleted",
      text: renderTemplate("deleted", { mediaTitle, mediaType, filesNote: deletedFiles ? " (files deleted too)" : "" }),
      color: 0xe05c5c,
      payload: { event: "deleted", mediaTitle, mediaType, deletedFiles },
    },
    ctx
  );
}

/** "On Rename": Organize & Rename moved or renamed files of one title. */
export async function notifyRenamed(mediaTitle: string, count: number, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Renamed",
      text: renderTemplate("renamed", { mediaTitle, count: String(count) }),
      color: 0x4f8cff,
      payload: { event: "renamed", mediaTitle, count },
    },
    ctx
  );
}

/** "On Episode File Delete" and "On Movie File Delete": one file was deleted from a title that stays in the library. */
export async function notifyFileDeleted(mediaTitle: string, fileName: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "File deleted",
      text: renderTemplate("fileDeleted", { mediaTitle, fileName }),
      color: 0xe0a95c,
      payload: { event: "fileDeleted", mediaTitle, fileName },
    },
    ctx
  );
}

export async function notifyFailed(mediaTitle: string, reason: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Failed",
      text: renderTemplate("failed", { mediaTitle, reason }),
      color: 0xe05c5c,
      payload: { event: "failed", mediaTitle, reason },
    },
    ctx
  );
}

/** `sampleTitles` is a short preview (a handful of titles), not every new group — the full list is
 * always available on the Duplicates page, this is just enough for the notification to be useful
 * at a glance without becoming an unreadable wall of text for a library with dozens of new hits. */
export async function notifyDuplicatesFound(count: number, sampleTitles: string[]): Promise<void> {
  const titles = sampleTitles.join(", ") + (count > sampleTitles.length ? ", ..." : "");
  await fanOut({
    title: "Duplicates found",
    text: renderTemplate("duplicatesFound", { count: String(count), titles }),
    color: 0xe0a95c,
    payload: { event: "duplicatesFound", count, titles: sampleTitles },
  });
}

// --- the Test button ---------------------------------------------------------------------------------------------

const TEST_TITLE = "AoNarr test notification";
const TEST_TEXT = "If you're seeing this, this connection is configured correctly.";

/**
 * Radarr/Sonarr's "Test" button per notification connection — sends a fixed message to exactly that one connection,
 * ignoring its events and tags entirely (a test should always go through regardless of which events it is set to
 * care about) so an admin can verify credentials/URL are right without waiting for (or faking) a real grab/import/
 * failure. Throws what went wrong, in words that carry no secret and no full URL (the host only). A test that goes
 * through shows the connection works again: the Health warning about failed sends is lifted now, not at the next real
 * notification.
 */
export async function testNotificationConnection(conn: NotificationConnection): Promise<void> {
  await deliver(conn, { title: TEST_TITLE, text: TEST_TEXT, color: 0x4f8cff, payload: { event: "test", title: TEST_TITLE, text: TEST_TEXT } }, {});
  recordNotificationOutcome({ id: conn.id, kind: conn.kind, label: labelOf(conn) }, true);
}

/** The test button's key on the old settings page, where it differs from the connection kind. */
const KIND_BY_TEST_KEY: Record<string, ConnectionKind> = { generic: "webhook", smtp: "email", push: "webPush" };

/** The old test endpoint, by provider name: tests the first connection of that kind. */
export async function sendTestNotification(providerKey: string): Promise<void> {
  const kind = KIND_BY_TEST_KEY[providerKey] ?? ((CONNECTION_KIND_KEYS as readonly string[]).includes(providerKey) ? (providerKey as ConnectionKind) : null);
  if (!kind) throw new Error(`Unknown notification provider "${providerKey}"`);
  const conn = await firstConnectionOfKind(kind);
  if (!conn) throw new Error(`There is no ${kindSpec(kind)!.label} connection yet. Add one under Settings > Notifications.`);
  await testNotificationConnection(conn);
}

/** Radarr/Sonarr-style "On Health Issue" — fired by the scheduler's own periodic health check
 * (see scheduler.ts's checkHealthAndNotify), not from the on-demand System page GET, so an admin
 * who isn't actively looking at the System page still finds out. `summary` is a short, human
 * combined description of everything currently wrong, not a single-issue message — kept as one
 * notification per check rather than one per problem, so a bad indexer + low disk space doesn't
 * spam every configured connection twice in the same minute. */
export async function notifyHealthIssue(summary: string, ctx?: NotifyContext): Promise<void> {
  await fanOut(
    {
      title: "Health issue",
      text: renderTemplate("healthIssue", { summary }),
      color: 0xe05c5c,
      payload: { event: "healthIssue", summary },
    },
    ctx
  );
}

/** The "restored" half of the health notification (Sonarr sends both): everything the last "Health issue" listed has
 * cleared. Its own event key, so a webhook that acts on "healthIssue" is not raised when everything is fine again. */
export async function notifyHealthRestored(previousSummary: string): Promise<void> {
  const shown = previousSummary.length > 1500 ? `${previousSummary.slice(0, 1500)}...` : previousSummary;
  await fanOut({
    title: "Health restored",
    text: renderTemplate("healthRestored", { summary: shown }),
    color: 0x4fbf6a,
    payload: { event: "healthRestored", summary: previousSummary },
  });
}
