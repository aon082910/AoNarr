import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { log } from "./logger.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { decryptValue, encryptValue } from "./encryption.js";
import { checkedTagIdsColumn, parseTagIds } from "./tagScope.js";
import { forgetNotificationFailures } from "./notificationStatus.js";
import type { SmtpConfig } from "./smtp.js";

/**
 * Notifications as connections (Sonarr/Radarr's Settings > Connect): any number of named destinations, each of one
 * kind, each with its own events and tags. Two Discord channels can get different events. This file is the data
 * side: what a kind needs, validating and storing a connection (secrets encrypted at rest, masked in the API), and
 * the one-time move from the old one-fixed-set-of-settings-per-provider layout. Sending is services/notifications.ts.
 */

// --- events ------------------------------------------------------------------------------------------------------

/** Sonarr/Radarr-style per-connection event triggers: a connection's `events` is a comma-separated subset of these. */
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
export const OPT_IN_EVENTS: ReadonlySet<string> = new Set(["added", "deleted", "renamed", "fileDeleted"]);

/** The events a connection with no saved list gets. */
export function defaultEvents(): EventKey[] {
  return EVENT_KEYS.filter((key) => !OPT_IN_EVENTS.has(key));
}

/**
 * Whether a connection with this stored event list wants the event. A list that was never saved (null) means "every
 * event" — but an explicitly saved empty string means every event was deliberately unchecked, which must NOT also mean
 * "every event".
 */
export function eventAllowed(events: string | null | undefined, event: string): boolean {
  if (events == null) return !OPT_IN_EVENTS.has(event);
  return events
    .split(",")
    .map((s) => s.trim())
    .includes(event);
}

/** The events a connection sends, as a list. */
export function effectiveEvents(events: string | null): string[] {
  return EVENT_KEYS.filter((key) => eventAllowed(events, key));
}

// --- kinds -------------------------------------------------------------------------------------------------------

export const CONNECTION_KIND_KEYS = ["discord", "slack", "webhook", "telegram", "pushover", "ntfy", "gotify", "matrix", "twilio", "email", "customScript", "webPush"] as const;
export type ConnectionKind = (typeof CONNECTION_KIND_KEYS)[number];

export type ConnectionFieldType = "text" | "password" | "number" | "boolean" | "select" | "headers";

export interface ConnectionField {
  key: string;
  label: string;
  type: ConnectionFieldType;
  required?: boolean;
  /** Stored encrypted and never returned: a webhook URL is the credential itself. (A "password" field always is.) */
  secret?: boolean;
  /** A value that must be an http(s) URL. */
  url?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
}

export interface ConnectionKindSpec {
  kind: ConnectionKind;
  label: string;
  description?: string;
  fields: ConnectionField[];
}

export const CONNECTION_KINDS: ConnectionKindSpec[] = [
  {
    kind: "discord",
    label: "Discord",
    fields: [{ key: "webhookUrl", label: "Webhook URL", type: "text", secret: true, required: true, url: true, placeholder: "https://discord.com/api/webhooks/..." }],
  },
  {
    kind: "slack",
    label: "Slack",
    fields: [{ key: "webhookUrl", label: "Webhook URL", type: "text", secret: true, required: true, url: true, placeholder: "https://hooks.slack.com/services/..." }],
  },
  {
    kind: "webhook",
    label: "Webhook",
    description: "Sends the event as JSON to a URL, in AoNarr's own shape or in the shape Sonarr and Radarr send.",
    fields: [
      { key: "url", label: "Webhook URL", type: "text", secret: true, required: true, url: true, placeholder: "https://example.com/hooks/aonarr" },
      {
        key: "method",
        label: "Method",
        type: "select",
        default: "POST",
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
        ],
      },
      {
        key: "payloadStyle",
        label: "Payload",
        type: "select",
        default: "aonarr",
        help: "AoNarr: the raw event data. Sonarr/Radarr: the body those apps send, for a receiver written for them.",
        options: [
          { value: "aonarr", label: "AoNarr" },
          { value: "starr", label: "Sonarr/Radarr" },
        ],
      },
      { key: "username", label: "Username (basic auth, optional)", type: "text" },
      { key: "password", label: "Password (basic auth, optional)", type: "password" },
      { key: "headers", label: "Headers", type: "headers", help: "Extra request headers. Values are hidden once saved." },
    ],
  },
  {
    kind: "telegram",
    label: "Telegram",
    fields: [
      { key: "botToken", label: "Bot token", type: "password", required: true, placeholder: "123456:ABC-DEF..." },
      { key: "chatId", label: "Chat ID", type: "text", required: true, placeholder: "-100123456789" },
    ],
  },
  {
    kind: "pushover",
    label: "Pushover",
    fields: [
      { key: "apiToken", label: "API token", type: "password", required: true },
      { key: "userKey", label: "User key", type: "password", required: true },
    ],
  },
  {
    kind: "ntfy",
    label: "ntfy",
    description: "ntfy.sh or your own ntfy server: the message goes to a topic.",
    fields: [
      { key: "serverUrl", label: "Server URL", type: "text", required: true, url: true, placeholder: "https://ntfy.sh" },
      { key: "topic", label: "Topic", type: "text", required: true, placeholder: "aonarr" },
      { key: "token", label: "Access token (only for a protected topic)", type: "password" },
    ],
  },
  {
    kind: "gotify",
    label: "Gotify",
    fields: [
      { key: "serverUrl", label: "Server URL", type: "text", required: true, url: true, placeholder: "https://gotify.example.com" },
      { key: "token", label: "Application token", type: "password", required: true },
    ],
  },
  {
    kind: "matrix",
    label: "Matrix",
    fields: [
      { key: "homeserverUrl", label: "Homeserver URL", type: "text", required: true, url: true, placeholder: "https://matrix.org" },
      { key: "accessToken", label: "Access token", type: "password", required: true },
      { key: "roomId", label: "Room ID", type: "text", required: true, placeholder: "!roomid:matrix.org" },
    ],
  },
  {
    kind: "twilio",
    label: "SMS (Twilio)",
    fields: [
      { key: "accountSid", label: "Account SID", type: "text", required: true },
      { key: "authToken", label: "Auth token", type: "password", required: true },
      { key: "fromNumber", label: "From number", type: "text", required: true, placeholder: "+15551234567" },
      { key: "toNumber", label: "To number", type: "text", required: true, placeholder: "+15557654321" },
    ],
  },
  {
    kind: "email",
    label: "Email",
    description: "Sends through your own SMTP server.",
    fields: [
      { key: "host", label: "SMTP host", type: "text", required: true, placeholder: "smtp.gmail.com" },
      { key: "port", label: "SMTP port", type: "number", default: 587, placeholder: "587" },
      { key: "secure", label: "Implicit TLS (port 465); off = STARTTLS (587/25)", type: "boolean", default: false },
      { key: "username", label: "Username", type: "text" },
      { key: "password", label: "Password", type: "password" },
      { key: "from", label: "Send from", type: "text", required: true, placeholder: "aonarr@yourdomain.com" },
      { key: "to", label: "Send to", type: "text", required: true, placeholder: "you@yourdomain.com" },
    ],
  },
  {
    kind: "customScript",
    label: "Custom Script",
    description: "Invoked directly (no shell) with event data as AONARR_* environment variables.",
    fields: [
      {
        key: "path",
        label: "Script path (inside the container; must be executable)",
        type: "text",
        required: true,
        placeholder: "/config/scripts/on-event.sh",
        help: "chmod +x it and mount it into the container (e.g. under /config).",
      },
    ],
  },
  {
    kind: "webPush",
    label: "Web push",
    description: "Browser notifications for every browser that turned them on (Account > Notifications).",
    fields: [],
  },
];

export function kindSpec(kind: string): ConnectionKindSpec | undefined {
  return CONNECTION_KINDS.find((spec) => spec.kind === kind);
}

const isSecretField = (field: ConnectionField): boolean => field.secret === true || field.type === "password";

// --- the connection ----------------------------------------------------------------------------------------------

/** What an API answer shows in place of a secret that is set. Sent back unchanged, it keeps the stored value. */
export const SECRET_MASK = "********";

export interface HeaderEntry {
  name: string;
  value: string;
}

export interface NotificationConnection {
  id: number;
  name: string;
  kind: ConnectionKind;
  /** Decrypted: for sending only, never for an API answer (see connectionToApi). */
  config: Record<string, any>;
  /** The stored comma list; null = the defaults. */
  events: string | null;
  tagIds: number[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A request the caller got wrong: the route answers 400 with the message. */
export class ConnectionInputError extends Error {}

function openValue(stored: unknown, where: string): string {
  if (typeof stored !== "string" || !stored) return "";
  try {
    return decryptValue(stored);
  } catch {
    // encryption.key does not match the one this was encrypted with (a restored backup): it reads as empty, and the
    // send names the field that is missing.
    log.error(`[notifications] couldn't decrypt ${where}; it needs to be entered again`);
    return "";
  }
}

function sealValue(plain: unknown): string {
  return typeof plain === "string" && plain ? encryptValue(plain) : "";
}

function headerList(value: unknown): HeaderEntry[] {
  return Array.isArray(value)
    ? value
        .filter((h): h is { name: unknown; value: unknown } => !!h && typeof h === "object")
        .map((h) => ({ name: String(h.name ?? ""), value: String(h.value ?? "") }))
        .filter((h) => h.name)
    : [];
}

/** The config as stored: every secret field encrypted. */
function sealConfig(spec: ConnectionKindSpec, config: Record<string, any>): string {
  const out: Record<string, unknown> = { ...config };
  for (const field of spec.fields) {
    if (field.type === "headers") out[field.key] = headerList(config[field.key]).map((h) => ({ name: h.name, value: sealValue(h.value) }));
    else if (isSecretField(field) && config[field.key] !== undefined) out[field.key] = sealValue(config[field.key]);
  }
  return JSON.stringify(out);
}

function openConfig(spec: ConnectionKindSpec, raw: string, label: string): Record<string, any> {
  let stored: Record<string, any> = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    // A config that is not JSON reads as empty; the send then names what is missing.
  }
  const out: Record<string, any> = { ...stored };
  for (const field of spec.fields) {
    if (field.type === "headers") out[field.key] = headerList(stored[field.key]).map((h) => ({ name: h.name, value: openValue(h.value, `${label}: header ${h.name}`) }));
    else if (isSecretField(field) && stored[field.key] !== undefined) out[field.key] = openValue(stored[field.key], `${label}: ${field.label}`);
  }
  return out;
}

interface ConnectionRow {
  id: number;
  name: string;
  kind: string;
  config: string;
  events: string | null;
  tag_ids: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ConnectionRow): NotificationConnection | null {
  const spec = kindSpec(row.kind);
  // A kind this version does not know (a row written by a newer one) is left alone, not sent to.
  if (!spec) return null;
  return {
    id: Number(row.id),
    name: row.name,
    kind: spec.kind,
    config: openConfig(spec, row.config, `${row.name} (${spec.label})`),
    events: row.events ?? null,
    tagIds: parseTagIds(row.tag_ids),
    enabled: !!Number(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listNotificationConnections(): Promise<NotificationConnection[]> {
  const rows = (await db.prepare("SELECT * FROM notification_connections ORDER BY id").all()) as ConnectionRow[];
  return rows.map(fromRow).filter((c): c is NotificationConnection => c !== null);
}

export async function getNotificationConnection(id: number): Promise<NotificationConnection | null> {
  const row = (await db.prepare("SELECT * FROM notification_connections WHERE id = ?").get(id)) as ConnectionRow | undefined;
  return row ? fromRow(row) : null;
}

/** The first connection of a kind, for the old test endpoint that names a provider. */
export async function firstConnectionOfKind(kind: ConnectionKind): Promise<NotificationConnection | null> {
  return (await listNotificationConnections()).find((c) => c.kind === kind) ?? null;
}

/** The label a connection shows under in Health and in a log line. */
export function labelOf(conn: { name: string; kind: string }): string {
  const spec = kindSpec(conn.kind);
  return spec && !conn.name.toLowerCase().includes(spec.label.toLowerCase()) ? `${conn.name} (${spec.label})` : conn.name;
}

/** The secret strings of a connection, so an error message can be scrubbed of them before it is shown or logged. */
export function secretsOf(conn: NotificationConnection): string[] {
  const spec = kindSpec(conn.kind);
  if (!spec) return [];
  const found: string[] = [];
  for (const field of spec.fields) {
    if (field.type === "headers") found.push(...headerList(conn.config[field.key]).map((h) => h.value));
    else if (isSecretField(field)) found.push(String(conn.config[field.key] ?? ""));
  }
  return found.filter((s) => s.length >= 4);
}

/** The first required field a connection has no value for, or null. A send says so instead of failing in some odd way. */
export function missingRequiredField(conn: Pick<NotificationConnection, "kind" | "config">): string | null {
  const spec = kindSpec(conn.kind);
  if (!spec) return null;
  const missing = spec.fields.find((f) => f.required && !String(conn.config[f.key] ?? "").trim());
  return missing ? missing.label : null;
}

// --- API shape ---------------------------------------------------------------------------------------------------

export interface ApiConnection {
  id: number;
  name: string;
  kind: ConnectionKind;
  kindLabel: string;
  /** Secrets are SECRET_MASK when set and "" when not. */
  config: Record<string, unknown>;
  /** The saved list, or null when it was never saved (the defaults apply). */
  events: string[] | null;
  /** What this connection actually sends. */
  effectiveEvents: string[];
  tagIds: number[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function connectionToApi(conn: NotificationConnection): ApiConnection {
  const spec = kindSpec(conn.kind)!;
  const config: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const value = conn.config[field.key];
    if (field.type === "headers") config[field.key] = headerList(value).map((h) => ({ name: h.name, value: h.value ? SECRET_MASK : "" }));
    else if (isSecretField(field)) config[field.key] = value ? SECRET_MASK : "";
    else if (value !== undefined) config[field.key] = value;
  }
  return {
    id: conn.id,
    name: conn.name,
    kind: conn.kind,
    kindLabel: spec.label,
    config,
    events: conn.events == null ? null : conn.events.split(",").map((s) => s.trim()).filter(Boolean),
    effectiveEvents: effectiveEvents(conn.events),
    tagIds: conn.tagIds,
    enabled: conn.enabled,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

// --- validating a request ----------------------------------------------------------------------------------------

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

function normalizeHeaders(raw: unknown, stored: unknown): HeaderEntry[] {
  if (!Array.isArray(raw)) throw new ConnectionInputError("headers must be a list of { name, value }");
  const kept = new Map(headerList(stored).map((h) => [h.name.toLowerCase(), h.value]));
  const out: HeaderEntry[] = [];
  for (const entry of headerList(raw)) {
    const name = entry.name.trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new ConnectionInputError(`"${name}" is not a valid header name`);
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new ConnectionInputError(`The ${name} header is set by AoNarr and can't be overridden`);
    // The mask sent back unchanged keeps the value stored under that header name.
    const value = entry.value === SECRET_MASK ? kept.get(name.toLowerCase()) ?? "" : entry.value;
    if (/[\r\n]/.test(value)) throw new ConnectionInputError(`The value of the ${name} header can't contain a line break`);
    out.push({ name, value });
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The config of a request, checked against its kind. `existing` is what is stored (decrypted): a field the request
 * leaves out keeps it, and a secret sent back as SECRET_MASK keeps it too, so an edit that does not retype a secret
 * does not lose it. The messages never echo a value.
 */
export function normalizeConfig(spec: ConnectionKindSpec, input: unknown, existing: Record<string, any> = {}): Record<string, any> {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) throw new ConnectionInputError("config must be an object");
  const given = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, any> = {};
  for (const field of spec.fields) {
    const raw = given[field.key];
    const stored = existing[field.key];
    const where = `${spec.label}: ${field.label}`;
    if (raw === undefined) {
      if (stored !== undefined) out[field.key] = stored;
      else if (field.default !== undefined) out[field.key] = field.default;
      continue;
    }
    switch (field.type) {
      case "headers":
        out[field.key] = normalizeHeaders(raw, stored);
        break;
      case "boolean":
        out[field.key] = raw === true || raw === "true" || raw === 1 || raw === "1";
        break;
      case "number": {
        if (raw === null || raw === "") {
          if (field.default !== undefined) out[field.key] = field.default;
          break;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConnectionInputError(`${where} must be a whole number from 1 to 65535`);
        out[field.key] = n;
        break;
      }
      case "select": {
        const value = String(raw);
        if (!field.options?.some((o) => o.value === value)) throw new ConnectionInputError(`${where} must be one of: ${field.options?.map((o) => o.value).join(", ")}`);
        out[field.key] = value;
        break;
      }
      default: {
        const text = String(raw ?? "").trim();
        // A secret that is set shows as the mask; sending the mask back means "unchanged".
        out[field.key] = isSecretField(field) && text === SECRET_MASK ? (stored ?? "") : text;
      }
    }
  }
  for (const field of spec.fields) {
    const value = out[field.key];
    if (field.required && !String(value ?? "").trim()) throw new ConnectionInputError(`${spec.label}: ${field.label} is required`);
    if (field.url && typeof value === "string" && value && !isHttpUrl(value)) throw new ConnectionInputError(`${spec.label}: ${field.label} must start with http:// or https://`);
  }
  return out;
}

/** The events of a request as the stored list: undefined = not sent, null = the defaults. Throws on a name that is no event. */
export function eventsColumn(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!list) throw new ConnectionInputError("events must be a list of event names");
  const names = list.map((v) => String(v).trim()).filter(Boolean);
  for (const name of names) {
    if (!(EVENT_KEYS as readonly string[]).includes(name)) throw new ConnectionInputError(`Unknown event "${name}". Use: ${EVENT_KEYS.join(", ")}`);
  }
  return [...new Set(names)].join(",");
}

async function tagColumn(value: unknown): Promise<string | null | undefined> {
  try {
    return await checkedTagIdsColumn(value);
  } catch (err) {
    throw new ConnectionInputError((err as Error).message);
  }
}

function nameInput(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new ConnectionInputError("name is required");
  if (name.length > 100) throw new ConnectionInputError("name can be at most 100 characters");
  return name;
}

export interface ConnectionInput {
  name?: unknown;
  kind?: unknown;
  config?: unknown;
  events?: unknown;
  tagIds?: unknown;
  enabled?: unknown;
}

export async function createNotificationConnection(input: ConnectionInput): Promise<NotificationConnection> {
  const kind = String(input.kind ?? "");
  const spec = kindSpec(kind);
  if (!spec) throw new ConnectionInputError(kind ? `Unknown connection kind "${kind}". Use one of: ${CONNECTION_KIND_KEYS.join(", ")}` : `kind is required. Use one of: ${CONNECTION_KIND_KEYS.join(", ")}`);
  const name = nameInput(input.name);
  const config = normalizeConfig(spec, input.config);
  const events = eventsColumn(input.events) ?? null;
  const tagIds = (await tagColumn(input.tagIds)) ?? null;
  const result = await db
    .prepare("INSERT INTO notification_connections (name, kind, config, events, tag_ids, enabled) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, spec.kind, sealConfig(spec, config), events, tagIds, input.enabled === false ? 0 : 1);
  return (await getNotificationConnection(Number(result.lastInsertRowid)))!;
}

/** Changes the fields the request names. Null when there is no such connection. The kind can't change. */
export async function updateNotificationConnection(id: number, input: ConnectionInput): Promise<NotificationConnection | null> {
  const existing = await getNotificationConnection(id);
  if (!existing) return null;
  const spec = kindSpec(existing.kind)!;
  if (input.kind !== undefined && String(input.kind) !== existing.kind) throw new ConnectionInputError("A connection's kind can't be changed; add a new connection instead");
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    values.push(nameInput(input.name));
  }
  if (input.config !== undefined) {
    sets.push("config = ?");
    values.push(sealConfig(spec, normalizeConfig(spec, input.config, existing.config)));
  }
  const events = eventsColumn(input.events);
  if (events !== undefined) {
    sets.push("events = ?");
    values.push(events);
  }
  const tagIds = await tagColumn(input.tagIds);
  if (tagIds !== undefined) {
    sets.push("tag_ids = ?");
    values.push(tagIds);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(input.enabled === false || input.enabled === 0 || input.enabled === "0" ? 0 : 1);
  }
  if (sets.length > 0) {
    sets.push(`updated_at = ${nowExpr(db)}`);
    await db.prepare(`UPDATE notification_connections SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }
  const updated = (await getNotificationConnection(id))!;
  // A connection that was switched off, or whose address or credentials were just fixed, is no longer failing.
  if (!updated.enabled || input.config !== undefined) forgetNotificationFailures(id);
  return updated;
}

export async function deleteNotificationConnection(id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM notification_connections WHERE id = ?").run(id);
  forgetNotificationFailures(id);
  return result.changes > 0;
}

/**
 * The mail server Send to Kindle goes through (it reuses the notification email settings, with the Kindle address as the
 * recipient): the first Email connection, one that is switched on before one that is off, or the old email settings on an
 * install that has no Email connection. Null when neither is set up.
 */
export async function kindleSmtpConfig(to: string): Promise<SmtpConfig | null> {
  const emails = (await listNotificationConnections()).filter((c) => c.kind === "email");
  const conn = emails.find((c) => c.enabled) ?? emails[0];
  if (conn) {
    const c = conn.config;
    if (!c.host || !c.from) return null;
    return {
      host: String(c.host),
      port: Number(c.port || 587),
      secure: c.secure === true,
      username: c.username ? String(c.username) : undefined,
      password: c.password ? String(c.password) : undefined,
      from: String(c.from),
      to,
    };
  }
  const host = getSetting("smtpHost");
  const from = getSetting("smtpFrom");
  if (!host || !from) return null;
  return {
    host,
    port: Number(getSetting("smtpPort") || 587),
    secure: getSetting("smtpSecure") === "1",
    username: getSetting("smtpUsername") || undefined,
    password: getSetting("smtpPassword") || undefined,
    from,
    to,
  };
}

/**
 * A browser just turned on push notifications. Before connections, web push went out for every event whenever a
 * browser was subscribed; with them it needs a connection, so the first subscription makes one (with the default
 * events) and the notifications the browser was told to expect still arrive.
 */
export async function ensureWebPushConnection(): Promise<void> {
  const existing = (await listNotificationConnections()).some((c) => c.kind === "webPush");
  if (!existing) await createNotificationConnection({ name: "Web push", kind: "webPush" });
}

// --- the move from the old settings ------------------------------------------------------------------------------

const MIGRATED_MARKER = "notificationConnectionsMigrated";

interface LegacyProvider {
  kind: ConnectionKind;
  name: string;
  /** The old `<provider>Events` setting. */
  eventsKey: string;
  /** The config the old settings hold, or null when the provider was not set up (the old fan-out sent nothing). */
  config: () => Record<string, unknown> | null;
  enabled?: () => boolean;
}

const setting = (key: string): string => getSetting(key) ?? "";

const LEGACY_PROVIDERS: LegacyProvider[] = [
  { kind: "discord", name: "Discord", eventsKey: "discordEvents", config: () => (setting("discordWebhookUrl") ? { webhookUrl: setting("discordWebhookUrl") } : null) },
  { kind: "slack", name: "Slack", eventsKey: "slackEvents", config: () => (setting("slackWebhookUrl") ? { webhookUrl: setting("slackWebhookUrl") } : null) },
  { kind: "webhook", name: "Webhook", eventsKey: "genericEvents", config: () => (setting("genericWebhookUrl") ? { url: setting("genericWebhookUrl"), method: "POST", payloadStyle: "aonarr", headers: [] } : null) },
  {
    kind: "telegram",
    name: "Telegram",
    eventsKey: "telegramEvents",
    config: () => (setting("telegramBotToken") && setting("telegramChatId") ? { botToken: setting("telegramBotToken"), chatId: setting("telegramChatId") } : null),
  },
  {
    kind: "pushover",
    name: "Pushover",
    eventsKey: "pushoverEvents",
    config: () => (setting("pushoverApiToken") && setting("pushoverUserKey") ? { apiToken: setting("pushoverApiToken"), userKey: setting("pushoverUserKey") } : null),
  },
  {
    kind: "ntfy",
    name: "ntfy",
    eventsKey: "ntfyEvents",
    config: () => (setting("ntfyServerUrl") && setting("ntfyTopic") ? { serverUrl: setting("ntfyServerUrl"), topic: setting("ntfyTopic"), token: setting("ntfyToken") } : null),
  },
  {
    kind: "gotify",
    name: "Gotify",
    eventsKey: "gotifyEvents",
    config: () => (setting("gotifyServerUrl") && setting("gotifyToken") ? { serverUrl: setting("gotifyServerUrl"), token: setting("gotifyToken") } : null),
  },
  {
    kind: "matrix",
    name: "Matrix",
    eventsKey: "matrixEvents",
    config: () =>
      setting("matrixHomeserverUrl") && setting("matrixAccessToken") && setting("matrixRoomId")
        ? { homeserverUrl: setting("matrixHomeserverUrl"), accessToken: setting("matrixAccessToken"), roomId: setting("matrixRoomId") }
        : null,
  },
  {
    kind: "twilio",
    name: "SMS (Twilio)",
    eventsKey: "twilioEvents",
    config: () =>
      setting("twilioAccountSid") && setting("twilioAuthToken") && setting("twilioFromNumber") && setting("twilioToNumber")
        ? { accountSid: setting("twilioAccountSid"), authToken: setting("twilioAuthToken"), fromNumber: setting("twilioFromNumber"), toNumber: setting("twilioToNumber") }
        : null,
  },
  {
    kind: "email",
    name: "Email",
    eventsKey: "smtpEvents",
    config: () =>
      setting("smtpHost") && setting("smtpTo") && setting("smtpFrom")
        ? {
            host: setting("smtpHost"),
            port: Number(setting("smtpPort") || 587),
            secure: setting("smtpSecure") === "1",
            username: setting("smtpUsername"),
            password: setting("smtpPassword"),
            from: setting("smtpFrom"),
            to: setting("smtpTo"),
          }
        : null,
  },
  // The old script ran only while it was enabled and had a path. One that has a path but was switched off keeps its
  // path as a connection that is off.
  {
    kind: "customScript",
    name: "Custom Script",
    eventsKey: "customScriptEvents",
    config: () => (setting("customScriptPath") ? { path: setting("customScriptPath") } : null),
    enabled: () => getSetting("customScriptEnabled") === "1",
  },
];

/**
 * Turns the one-fixed-set-of-settings-per-provider layout into connections: one connection for each provider that was
 * set up, with its values and its event list (never saved stays null: the same defaults as before). The old settings
 * are left where they are, so a rollback to an older version still finds them, but nothing sends from them any more.
 * Runs once (the marker), and never adds to connections that already exist.
 */
export async function migrateNotificationConnections(): Promise<number> {
  if (getSetting(MIGRATED_MARKER) === "1") return 0;
  let created = 0;
  const present = (await db.prepare("SELECT COUNT(*) AS n FROM notification_connections").get()) as { n: number | string };
  // A run the marker did not survive (the setting is written in the background) must not do it twice.
  if (Number(present.n) === 0) {
    const pending: { name: string; kind: ConnectionKind; config: Record<string, unknown>; events: string | null; enabled: boolean }[] = [];
    for (const provider of LEGACY_PROVIDERS) {
      const config = provider.config();
      if (config) pending.push({ name: provider.name, kind: provider.kind, config, events: getSetting(provider.eventsKey), enabled: provider.enabled ? provider.enabled() : true });
    }
    // Web push went out for every event whenever a browser was subscribed, with no setting that said it was on.
    const subscribers = (await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()) as { n: number | string };
    if (getSetting("pushEvents") != null || setting("vapidPublicKey") || Number(subscribers.n) > 0) {
      pending.push({ name: "Web push", kind: "webPush", config: {}, events: getSetting("pushEvents"), enabled: true });
    }
    await db.transaction(async () => {
      for (const p of pending) {
        const spec = kindSpec(p.kind)!;
        await db
          .prepare("INSERT INTO notification_connections (name, kind, config, events, tag_ids, enabled) VALUES (?, ?, ?, ?, NULL, ?)")
          .run(p.name, p.kind, sealConfig(spec, p.config), p.events, p.enabled ? 1 : 0);
      }
    });
    created = pending.length;
    if (created > 0) log.info(`[notifications] moved ${created} notification provider(s) from the old settings to connections`);
  }
  setSetting(MIGRATED_MARKER, "1");
  return created;
}
