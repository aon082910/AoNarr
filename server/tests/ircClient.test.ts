import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import net from "node:net";
import { setupTestDb } from "./helpers/testDb.js";

let IrcConnection: (typeof import("../src/services/ircClient.js"))["IrcConnection"];
type IrcFeedConfig = import("../src/services/ircClient.js").IrcFeedConfig;
let log: (typeof import("../src/services/logger.js"))["log"];

beforeAll(async () => {
  // ircClient.ts imports logger.js, which touches config.js/db/index.js transitively.
  await setupTestDb();
  ({ IrcConnection } = await import("../src/services/ircClient.js"));
  ({ log } = await import("../src/services/logger.js"));
});

/** Polls via setImmediate (never faked, unlike setTimeout) so this works correctly regardless of
 * whether fake timers are installed — used to wait for a real, async socket-teardown chain (close
 * event -> scheduleReconnect() -> its setTimeout call) to actually land before advancing a fake
 * clock, since advancing before that timer is registered would advance nothing. */
async function realWaitUntil(predicate: () => boolean, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("realWaitUntil: condition never became true");
}

// A real local TCP server standing in for an ircd — the client is a hand-rolled implementation
// directly on net/tls sockets (same reasoning as smtp.ts's own tests), so exercising it against a
// real socket proves the actual wire-level line parsing/framing rather than a guess at what a
// mocked socket should emit.
class FakeIrcServer {
  private server: net.Server;
  sockets: net.Socket[] = [];
  receivedLines: string[] = [];
  private lineWaiters: { predicate: (line: string) => boolean; resolve: (line: string) => void }[] = [];

  constructor(private handler: (socket: net.Socket, line: string) => void) {
    this.server = net.createServer((socket) => {
      this.sockets.push(socket);
      socket.setEncoding("utf-8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\r\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          this.receivedLines.push(line);
          this.handler(socket, line);
          this.lineWaiters = this.lineWaiters.filter((w) => {
            if (w.predicate(line)) {
              w.resolve(line);
              return false;
            }
            return true;
          });
        }
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  send(socket: net.Socket, line: string): void {
    socket.write(line + "\r\n");
  }

  /** Event-driven (no polling/timers of its own), so it's unaffected by fake timers in the caller. */
  waitForLine(predicate: (line: string) => boolean): Promise<string> {
    const already = this.receivedLines.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => this.lineWaiters.push({ predicate, resolve }));
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function configFor(port: number, overrides: Partial<IrcFeedConfig> = {}): IrcFeedConfig {
  return {
    id: 1,
    name: "test-feed",
    host: "127.0.0.1",
    port,
    useSsl: false,
    nickname: "testbot",
    saslUser: null,
    saslPass: null,
    channel: "#testchannel",
    ...overrides,
  };
}

const activeConnections: InstanceType<typeof IrcConnection>[] = [];
const activeServers: FakeIrcServer[] = [];

afterEach(async () => {
  for (const conn of activeConnections.splice(0)) conn.stop();
  vi.useRealTimers();
  for (const server of activeServers.splice(0)) await server.close();
});

describe("IrcConnection — registration (no SASL)", () => {
  it("registers with NICK/USER and joins the configured channel once the server welcomes it", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line.startsWith("USER")) server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port), vi.fn());
    activeConnections.push(conn);

    conn.start();
    await server.waitForLine((l) => l.startsWith("JOIN"));

    expect(server.receivedLines).toEqual(
      expect.arrayContaining(["NICK testbot", "USER testbot 0 * :testbot", "JOIN #testchannel"])
    );
    expect(server.receivedLines.indexOf("USER testbot 0 * :testbot")).toBeLessThan(server.receivedLines.indexOf("JOIN #testchannel"));
  });

  it("replies to a server PING with a matching PONG", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line.startsWith("USER")) server.send(socket, ":ircserver 001 testbot :Welcome");
      if (line.startsWith("JOIN")) server.send(socket, "PING :abc123");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port), vi.fn());
    activeConnections.push(conn);

    conn.start();
    const pong = await server.waitForLine((l) => l.startsWith("PONG"));

    expect(pong).toBe("PONG :abc123");
  });
});

describe("IrcConnection — SASL PLAIN", () => {
  it("authenticates via SASL PLAIN before completing registration", async () => {
    let decodedPayload: string | null = null;
    const server = new FakeIrcServer((socket, line) => {
      if (line === "CAP REQ :sasl") server.send(socket, ":ircserver CAP * ACK :sasl");
      else if (line === "AUTHENTICATE PLAIN") server.send(socket, "AUTHENTICATE +");
      else if (line.startsWith("AUTHENTICATE ") && line !== "AUTHENTICATE PLAIN") {
        decodedPayload = Buffer.from(line.slice("AUTHENTICATE ".length), "base64").toString("utf-8");
        server.send(socket, ":ircserver 903 testbot :SASL authentication successful");
      } else if (line === "CAP END") server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port, { saslUser: "alice", saslPass: "hunter2" }), vi.fn());
    activeConnections.push(conn);

    conn.start();
    await server.waitForLine((l) => l.startsWith("JOIN"));

    expect(decodedPayload).toBe("\0alice\0hunter2");
    const lines = server.receivedLines;
    expect(lines.indexOf("CAP REQ :sasl")).toBeLessThan(lines.indexOf("NICK testbot"));
    expect(lines.indexOf("AUTHENTICATE PLAIN")).toBeGreaterThan(lines.indexOf("NICK testbot"));
    expect(lines.indexOf("CAP END")).toBeGreaterThan(lines.findIndex((l) => l.startsWith("AUTHENTICATE ") && l !== "AUTHENTICATE PLAIN"));
  });

  it("skips authentication and still registers when the server NAKs the sasl capability", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line === "CAP REQ :sasl") server.send(socket, "CAP * NAK :sasl"); // no server-name prefix this time
      else if (line === "CAP END") server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port, { saslUser: "alice", saslPass: "hunter2" }), vi.fn());
    activeConnections.push(conn);

    conn.start();
    await server.waitForLine((l) => l.startsWith("JOIN"));

    expect(server.receivedLines.some((l) => l.startsWith("AUTHENTICATE"))).toBe(false);
  });

  it("finishes registration even when SASL authentication itself is rejected (904)", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line === "CAP REQ :sasl") server.send(socket, ":ircserver CAP * ACK :sasl");
      else if (line === "AUTHENTICATE PLAIN") server.send(socket, "AUTHENTICATE +");
      else if (line.startsWith("AUTHENTICATE ") && line !== "AUTHENTICATE PLAIN") {
        server.send(socket, ":ircserver 904 testbot :SASL authentication failed");
      } else if (line === "CAP END") server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port, { saslUser: "alice", saslPass: "wrong" }), vi.fn());
    activeConnections.push(conn);

    conn.start();
    await server.waitForLine((l) => l.startsWith("JOIN"));

    expect(server.receivedLines.some((l) => l === "AUTHENTICATE PLAIN")).toBe(true);
    expect(server.receivedLines).toContain("CAP END");
  });
});

describe("IrcConnection — PRIVMSG routing", () => {
  it("only calls onMessage for a PRIVMSG addressed to the configured channel, case-insensitively", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line.startsWith("USER")) server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const onMessage = vi.fn();
    const conn = new IrcConnection(configFor(port), onMessage);
    activeConnections.push(conn);

    conn.start();
    const [joinedSocket] = await server.waitForLine((l) => l.startsWith("JOIN")).then(() => server.sockets);

    server.send(joinedSocket, ":other!u@h PRIVMSG #otherchannel :not for us");
    server.send(joinedSocket, ":other!u@h PRIVMSG testbot :a private message, not the channel");
    server.send(joinedSocket, ":other!u@h PRIVMSG #TESTCHANNEL :sentinel message");

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalled());

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("sentinel message");
  });
});

describe("IrcConnection — reconnection", () => {
  it("automatically reconnects and re-registers after the server drops the connection", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line.startsWith("USER")) server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port), vi.fn());
    activeConnections.push(conn);

    conn.start();
    await server.waitForLine((l) => l.startsWith("JOIN"));
    expect(server.sockets).toHaveLength(1);

    // Only fake setTimeout/clearTimeout — real socket I/O (the close event, the next connect
    // attempt) must keep running on the real event loop for this to work at all. Installed BEFORE
    // destroying the socket so scheduleReconnect()'s own setTimeout call is guaranteed to be
    // captured by the fake clock whenever it actually runs.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warnSpy = vi.spyOn(log, "warn");
    server.sockets[0].destroy();

    // The real close event takes an unpredictable number of real event-loop turns to propagate —
    // wait for the concrete proof that scheduleReconnect() actually ran (and thus its setTimeout is
    // now registered) rather than guessing a fixed number of ticks.
    await realWaitUntil(() => warnSpy.mock.calls.some((c) => String(c[0]).includes("reconnecting in 30s")));

    vi.advanceTimersByTime(30_000);

    // Purely event-driven (re-scans on each line, no closure side effects) — waits for a SECOND
    // "JOIN" line to have arrived, proving the reconnect actually re-ran the whole registration
    // flow rather than just re-establishing the TCP connection.
    await server.waitForLine((l) => l.startsWith("JOIN") && server.receivedLines.filter((x) => x.startsWith("JOIN")).length >= 2);
    expect(server.sockets.length).toBeGreaterThan(1);
  });

  it("does not reconnect after stop() is called", async () => {
    const server = new FakeIrcServer((socket, line) => {
      if (line.startsWith("USER")) server.send(socket, ":ircserver 001 testbot :Welcome");
    });
    activeServers.push(server);
    const port = await server.listen();
    const conn = new IrcConnection(configFor(port), vi.fn());

    conn.start();
    await server.waitForLine((l) => l.startsWith("JOIN"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    conn.stop();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    vi.advanceTimersByTime(60_000);
    await new Promise((r) => setImmediate(r));

    expect(server.sockets).toHaveLength(1); // never a second connection attempt
  });
});
