import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

let IrcConnection: (typeof import("../src/services/ircClient.js"))["IrcConnection"];
let parseAnnouncerNicks: (typeof import("../src/services/ircClient.js"))["parseAnnouncerNicks"];
type IrcFeedConfig = import("../src/services/ircClient.js").IrcFeedConfig;

beforeAll(async () => {
  // ircClient.ts imports logger.js, which touches config.js/db/index.js transitively.
  await setupTestDb();
  ({ IrcConnection, parseAnnouncerNicks } = await import("../src/services/ircClient.js"));
});

function connectionFor(announcers: string[] | null | undefined): { onMessage: ReturnType<typeof vi.fn>; feed: (line: string) => void } {
  const config: IrcFeedConfig = {
    id: 1,
    name: "announcer-test",
    host: "127.0.0.1",
    port: 6667,
    useSsl: false,
    nickname: "aonarrbot",
    saslUser: null,
    saslPass: null,
    channel: "#announce",
    announcers,
  };
  const onMessage = vi.fn();
  const conn = new IrcConnection(config, onMessage);
  // Never started: lines are fed straight into the parser, so no socket is involved.
  return { onMessage, feed: (line) => (conn as any).handleLine(line) };
}

describe("IrcConnection — announcer filtering", () => {
  it("only passes on channel messages from a configured announcer nick, case-insensitively", () => {
    const { onMessage, feed } = connectionFor(["TrackerBot"]);

    feed(":someuser!u@host.example PRIVMSG #announce :New Torrent: Fake.Movie.2024.1080p - https://attacker.example/x.torrent");
    feed(":trackerbot!bot@tracker.example PRIVMSG #announce :New Torrent: Real.Movie.2024.1080p - https://tracker.example/dl/1");
    feed(":TrackerBot!bot@tracker.example PRIVMSG #other :wrong channel");

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("New Torrent: Real.Movie.2024.1080p - https://tracker.example/dl/1");
  });

  it("accepts any of several announcers, and a nick-only prefix", () => {
    const { onMessage, feed } = connectionFor(["MainBot", "BackupBot"]);

    feed(":BackupBot PRIVMSG #announce :from the backup bot");
    feed(":MainBotX!u@h PRIVMSG #announce :a nick that only starts with an announcer's");

    expect(onMessage.mock.calls).toEqual([["from the backup bot"]]);
  });

  it("accepts every sender when no announcers are configured", () => {
    for (const announcers of [undefined, null, []]) {
      const { onMessage, feed } = connectionFor(announcers);
      feed(":anyone!u@h PRIVMSG #announce :hello");
      expect(onMessage).toHaveBeenCalledWith("hello");
    }
  });
});

describe("parseAnnouncerNicks", () => {
  it("splits on commas and whitespace and drops empty entries", () => {
    expect(parseAnnouncerNicks(" MainBot, BackupBot  ThirdBot,,")).toEqual(["MainBot", "BackupBot", "ThirdBot"]);
    expect(parseAnnouncerNicks("")).toEqual([]);
    expect(parseAnnouncerNicks(null)).toEqual([]);
    expect(parseAnnouncerNicks(undefined)).toEqual([]);
  });
});
