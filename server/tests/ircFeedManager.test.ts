import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const startMock = vi.fn();
const stopMock = vi.fn();
let capturedConfigs: any[] = [];
let capturedCallbacks: ((text: string) => void)[] = [];

const IrcConnectionCtor = vi.fn().mockImplementation((config: any, callback: (text: string) => void) => {
  capturedConfigs.push(config);
  capturedCallbacks.push(callback);
  return { start: startMock, stop: stopMock };
});
vi.mock("../src/services/ircClient.js", () => ({
  // ircFeedManager.ts does `new IrcConnection(...)` — an arrow-function indirection would throw
  // "is not a constructor", so this must be a plain function. It doesn't need `new` internally:
  // IrcConnectionCtor's mockImplementation explicitly returns a plain object either way, and JS's
  // `new` semantics use that returned object instead of the implicit `this` when one is returned.
  IrcConnection: function (...args: unknown[]) {
    return (IrcConnectionCtor as any)(...args);
  },
}));

const handleAnnounce = vi.fn(async () => {});
vi.mock("../src/services/ircAnnounce.js", () => ({
  handleAnnounce: (...args: unknown[]) => handleAnnounce(...args),
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let restartIrcFeeds: (typeof import("../src/services/ircFeedManager.js"))["restartIrcFeeds"];
let stopIrcFeeds: (typeof import("../src/services/ircFeedManager.js"))["stopIrcFeeds"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ restartIrcFeeds, stopIrcFeeds } = await import("../src/services/ircFeedManager.js"));
});

afterEach(async () => {
  stopIrcFeeds(); // clears the module's own connection list for real
  await db.prepare("DELETE FROM irc_feeds").run();
  IrcConnectionCtor.mockClear();
  startMock.mockClear();
  stopMock.mockClear();
  handleAnnounce.mockClear();
  capturedConfigs = [];
  capturedCallbacks = [];
});

async function insertFeed(overrides: Record<string, unknown> = {}): Promise<number> {
  const {
    name = "Test Feed",
    host = "irc.example.com",
    port = 6697,
    useSsl = 1,
    nickname = "aonarr-bot",
    saslUser = null,
    saslPass = null,
    channel = "#announce",
    announceRegex = "(?<title>.+) (?<url>https?://\\S+)",
    protocol = "torrent",
    enabled = 1,
  } = overrides;
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO irc_feeds (name, host, port, use_ssl, nickname, sasl_user, sasl_pass, channel, announce_regex, protocol, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(name, host, port, useSsl, nickname, saslUser, saslPass, channel, announceRegex, protocol, enabled)
    ).lastInsertRowid
  );
}

describe("restartIrcFeeds", () => {
  it("creates no connections when there are no enabled feeds", async () => {
    await restartIrcFeeds();
    expect(IrcConnectionCtor).not.toHaveBeenCalled();
  });

  it("connects a single enabled feed with the correct mapped config", async () => {
    await insertFeed({ host: "irc.test.org", port: 6667, useSsl: 0, nickname: "mybot", channel: "#releases" });

    await restartIrcFeeds();

    expect(IrcConnectionCtor).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(capturedConfigs[0]).toMatchObject({ host: "irc.test.org", port: 6667, useSsl: false, nickname: "mybot", channel: "#releases" });
  });

  it("skips a disabled feed entirely", async () => {
    await insertFeed({ enabled: 0 });

    await restartIrcFeeds();

    expect(IrcConnectionCtor).not.toHaveBeenCalled();
  });

  it("passes a null sasl_pass through as-is, without attempting to decrypt it", async () => {
    await insertFeed({ saslPass: null });

    await restartIrcFeeds();

    expect(capturedConfigs[0].saslPass).toBeNull();
  });

  it("decrypts an encrypted sasl_pass before passing it to the connection config", async () => {
    const { encryptValue } = await import("../src/services/encryption.js");
    await insertFeed({ saslPass: encryptValue("plaintext-sasl-password") });

    await restartIrcFeeds();

    expect(capturedConfigs[0].saslPass).toBe("plaintext-sasl-password");
  });

  it("stops every previous connection before establishing new ones on a second call", async () => {
    await insertFeed({ name: "First Feed" });
    await restartIrcFeeds();
    expect(stopMock).not.toHaveBeenCalled(); // nothing to stop on the very first call

    await insertFeed({ name: "Second Feed" });
    await restartIrcFeeds();

    expect(stopMock).toHaveBeenCalledTimes(1); // the first feed's connection was stopped
    expect(IrcConnectionCtor).toHaveBeenCalledTimes(3); // 1 (first call) + 2 (second call, both feeds now enabled)
  });

  it("wires the announce callback to call handleAnnounce with the feed and announce text", async () => {
    await insertFeed({ name: "Wired Feed", announceRegex: "custom-regex", protocol: "usenet" });
    await restartIrcFeeds();

    capturedCallbacks[0]("some announce line");

    expect(handleAnnounce).toHaveBeenCalledWith(expect.objectContaining({ name: "Wired Feed", announce_regex: "custom-regex", protocol: "usenet" }), "some announce line");
  });

  it("doesn't let a handleAnnounce rejection escape as an unhandled rejection", async () => {
    // The callback wrapper is synchronous — it fires handleAnnounce() and attaches .catch()
    // without awaiting, so a plain "doesn't throw synchronously" assertion here would pass even if
    // that .catch() were removed entirely, since the rejection only happens on a later microtask.
    // Actually listening for process 'unhandledRejection' is what proves the .catch() is doing its job.
    handleAnnounce.mockRejectedValueOnce(new Error("boom"));
    await insertFeed();
    await restartIrcFeeds();

    let unhandled: unknown = null;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.once("unhandledRejection", onUnhandledRejection);

    capturedCallbacks[0]("triggers a rejection");
    await new Promise((r) => setTimeout(r, 20));

    process.off("unhandledRejection", onUnhandledRejection);
    expect(unhandled).toBeNull();
  });
});

describe("stopIrcFeeds", () => {
  it("stops every active connection", async () => {
    await insertFeed();
    await restartIrcFeeds();

    stopIrcFeeds();

    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
