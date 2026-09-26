import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { ircFeedFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { restartIrcFeeds } from "../services/ircFeedManager.js";
import { encryptValue } from "../services/encryption.js";

export const ircFeedsRouter = Router();
ircFeedsRouter.use(requireAdmin);

const IRC_STATUS_PREFIX = /^[~&@%+]+/;
const IRC_NICK = /^[A-Za-z0-9[\]\\`_^{|}-]+$/;

/** Blank is stored as NULL, which accepts lines from any sender in the channel. */
function normalizeAnnouncers(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "announcers must be a string of nicks separated by commas or spaces");
  // Clients show ops/voiced users as "@Bot" / "+Bot"; a copied prefix would never equal the
  // sender nick on the wire, silently dropping every announce on the feed.
  const nicks = value
    .split(/[\s,]+/)
    .map((token) => token.replace(IRC_STATUS_PREFIX, ""))
    .filter(Boolean);
  const invalid = nicks.find((nick) => !IRC_NICK.test(nick));
  if (invalid) throw new HttpError(400, `"${invalid}" is not a valid IRC nick; enter just the announce bot's nick, without a hostmask`);
  return nicks.length > 0 ? nicks.join(", ") : null;
}

ircFeedsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM irc_feeds ORDER BY name").all();
    res.json(rows.map(ircFeedFromRow));
  })
);

ircFeedsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.host || !b.nickname || !b.channel || !b.announceRegex) {
      throw new HttpError(400, "name, host, nickname, channel, and announceRegex are required");
    }
    if (!/\(\?<title>/.test(b.announceRegex) || !/\(\?<url>/.test(b.announceRegex)) {
      throw new HttpError(400, "announceRegex must have named capture groups (?<title>...) and (?<url>...)");
    }
    const announcers = normalizeAnnouncers(b.announcers);
    const result = await db
      .prepare(
        `INSERT INTO irc_feeds (name, host, port, use_ssl, nickname, sasl_user, sasl_pass, channel, announce_regex, protocol, enabled, announcers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.name,
        b.host,
        b.port ?? 6697,
        b.useSsl === undefined ? 1 : b.useSsl ? 1 : 0,
        b.nickname,
        b.saslUser ?? null,
        b.saslPass ? encryptValue(b.saslPass) : null,
        b.channel,
        b.announceRegex,
        b.protocol === "usenet" ? "usenet" : "torrent",
        b.enabled === undefined ? 1 : b.enabled ? 1 : 0,
        announcers
      );
    const row = await db.prepare("SELECT * FROM irc_feeds WHERE id = ?").get(result.lastInsertRowid);
    restartIrcFeeds().catch(() => {});
    res.status(201).json(ircFeedFromRow(row));
  })
);

ircFeedsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (b.announceRegex !== undefined) {
      if (!b.announceRegex || !/\(\?<title>/.test(b.announceRegex) || !/\(\?<url>/.test(b.announceRegex)) {
        throw new HttpError(400, "announceRegex must have named capture groups (?<title>...) and (?<url>...)");
      }
    }
    const map: Record<string, string> = {
      name: "name",
      host: "host",
      port: "port",
      useSsl: "use_ssl",
      nickname: "nickname",
      saslUser: "sasl_user",
      saslPass: "sasl_pass",
      channel: "channel",
      announceRegex: "announce_regex",
      protocol: "protocol",
      enabled: "enabled",
      announcers: "announcers",
    };
    const booleanKeys = new Set(["useSsl", "enabled"]);
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(map)) {
      if (b[key] === undefined) continue;
      // The mapper masks sasl_pass as "********" on read — treat that echoed-back placeholder as
      // "leave unchanged" rather than actually overwriting the real secret with asterisks.
      if (key === "saslPass" && b[key] === "********") continue;
      sets.push(`${col} = ?`);
      if (booleanKeys.has(key)) values.push(b[key] ? 1 : 0);
      // Encrypted at rest, same as the equivalent settings-table credentials — see services/encryption.ts.
      else if (key === "saslPass" && b[key]) values.push(encryptValue(b[key]));
      else if (key === "announcers") values.push(normalizeAnnouncers(b[key]));
      else values.push(b[key]);
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE irc_feeds SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM irc_feeds WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "IRC feed not found");
    restartIrcFeeds().catch(() => {});
    res.json(ircFeedFromRow(row));
  })
);

ircFeedsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM irc_feeds WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "IRC feed not found");
    restartIrcFeeds().catch(() => {});
    res.status(204).send();
  })
);
