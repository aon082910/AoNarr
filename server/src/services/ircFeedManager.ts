import { db } from "../db/index.js";
import { log } from "./logger.js";
import { IrcConnection, type IrcFeedConfig } from "./ircClient.js";
import { handleAnnounce, type IrcFeedRow } from "./ircAnnounce.js";

let connections: IrcConnection[] = [];

function stopAll(): void {
  for (const conn of connections) conn.stop();
  connections = [];
}

/** (Re)connects every enabled irc_feeds row — called once at server startup, and again whenever
 * an admin adds/edits/removes/toggles a feed, so a config change takes effect immediately instead
 * of requiring a restart. */
export async function restartIrcFeeds(): Promise<void> {
  stopAll();
  const rows = (await db.prepare("SELECT * FROM irc_feeds WHERE enabled = 1").all()) as any[];
  for (const row of rows) {
    const config: IrcFeedConfig = {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      useSsl: !!row.use_ssl,
      nickname: row.nickname,
      saslUser: row.sasl_user,
      saslPass: row.sasl_pass,
      channel: row.channel,
    };
    const feed: IrcFeedRow = { id: row.id, name: row.name, announce_regex: row.announce_regex, protocol: row.protocol };
    const conn = new IrcConnection(config, (text) => {
      handleAnnounce(feed, text).catch((err) => log.warn(`[irc:${feed.name}] announce handling failed:`, err.message));
    });
    conn.start();
    connections.push(conn);
  }
  if (rows.length > 0) log.info(`[irc] connecting to ${rows.length} announce feed(s)`);
}

export function stopIrcFeeds(): void {
  stopAll();
}
