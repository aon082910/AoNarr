import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { ircFeedFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { restartIrcFeeds } from "../services/ircFeedManager.js";

export const ircFeedsRouter = Router();
ircFeedsRouter.use(requireAdmin);

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
    const result = await db
      .prepare(
        `INSERT INTO irc_feeds (name, host, port, use_ssl, nickname, sasl_user, sasl_pass, channel, announce_regex, protocol, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.name,
        b.host,
        b.port ?? 6697,
        b.useSsl === false ? 0 : 1,
        b.nickname,
        b.saslUser ?? null,
        b.saslPass ?? null,
        b.channel,
        b.announceRegex,
        b.protocol === "usenet" ? "usenet" : "torrent",
        b.enabled === false ? 0 : 1
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
      values.push(booleanKeys.has(key) ? (b[key] ? 1 : 0) : b[key]);
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
