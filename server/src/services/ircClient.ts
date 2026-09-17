import net from "node:net";
import tls from "node:tls";
import { log } from "./logger.js";

export interface IrcFeedConfig {
  id: number;
  name: string;
  host: string;
  port: number;
  useSsl: boolean;
  nickname: string;
  saslUser: string | null;
  saslPass: string | null;
  channel: string;
}

/**
 * Minimal IRC client — connect, optional SASL PLAIN auth, join one channel, hand every PRIVMSG in
 * it to a callback. Implemented directly on Node's net/tls sockets (same reasoning as smtp.ts's
 * hand-rolled SMTP client elsewhere in this codebase): IRC is a small, well-specified (RFC 1459/
 * 2812), line-based text protocol, and this only ever needs to sit in one channel and read
 * announces — not a general-purpose IRC library's worth of functionality (DCC, multi-channel,
 * CTCP, etc.).
 */
export class IrcConnection {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private saslDone = false;

  constructor(
    private config: IrcFeedConfig,
    private onMessage: (text: string) => void
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
  }

  private send(line: string): void {
    this.socket?.write(line + "\r\n");
  }

  private connect(): void {
    const { host, port, useSsl } = this.config;
    const socket = useSsl ? tls.connect({ host, port }) : net.connect({ host, port });
    this.socket = socket;

    socket.setEncoding("utf-8");
    // A generous idle timeout — well past any compliant ircd's own keepalive PING interval
    // (typically a few minutes, already handled by the PING/PONG reply in handleLine) — so a
    // connection that accepts the TCP handshake but then goes completely silent, with no error and
    // no close event, gets force-reconnected instead of sitting dead forever unnoticed.
    socket.setTimeout(10 * 60 * 1000);
    socket.once("timeout", () => socket.destroy());
    // A TLSSocket emits both 'connect' and 'secureConnect' — registering on either would run the
    // handshake twice (duplicate CAP REQ/NICK/USER), which strict ircds reject.
    socket.on(useSsl ? "secureConnect" : "connect", () => this.onConnect());
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => log.warn(`[irc:${this.config.name}] socket error:`, err.message));
    socket.on("close", () => this.scheduleReconnect());
  }

  private onConnect(): void {
    log.info(`[irc:${this.config.name}] connected to ${this.config.host}:${this.config.port}`);
    this.saslDone = false;
    if (this.config.saslUser && this.config.saslPass) {
      // NICK/USER go out alongside CAP REQ (registration is suspended until CAP END either way);
      // sending them only after a 90x reply left the connection stuck if the server never ACKed.
      this.send("CAP REQ :sasl");
      this.registerNickAndUser();
    } else {
      this.registerNickAndUser();
    }
  }

  private finishSasl(failed: boolean): void {
    if (this.saslDone) return;
    this.saslDone = true;
    if (failed) log.warn(`[irc:${this.config.name}] SASL auth failed or unsupported — continuing without it`);
    this.send("CAP END");
  }

  private registerNickAndUser(): void {
    this.send(`NICK ${this.config.nickname}`);
    this.send(`USER ${this.config.nickname} 0 * :${this.config.nickname}`);
  }

  private scheduleReconnect(): void {
    this.socket = null;
    if (this.closed) return;
    log.warn(`[irc:${this.config.name}] disconnected, reconnecting in 30s`);
    this.reconnectTimer = setTimeout(() => this.connect(), 30_000);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? ""; // last element is a partial line (or empty) — keep it buffered
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line) return;

    if (line.startsWith("PING")) {
      this.send(`PONG ${line.slice(5)}`);
      return;
    }

    // Servers prefix CAP replies (":irc.host CAP * ACK :sasl"); match with or without the prefix.
    const cap = line.match(/^(?::\S+ )?CAP \S+ (ACK|NAK) :?(.*)$/i);
    if (cap) {
      if (cap[1].toUpperCase() === "ACK" && /\bsasl\b/i.test(cap[2])) {
        this.send("AUTHENTICATE PLAIN");
      } else {
        this.finishSasl(true);
      }
      return;
    }
    if (line.startsWith("AUTHENTICATE +")) {
      const { saslUser, saslPass } = this.config;
      const payload = Buffer.from(`\0${saslUser}\0${saslPass}`, "utf-8").toString("base64");
      this.send(`AUTHENTICATE ${payload}`);
      return;
    }
    // 903 = SASL successful, 904/905/906/907 = failed/aborted — either way, stop trying to
    // authenticate and finish registration so a misconfigured SASL doesn't block the connection.
    if (/^:\S+ 90[3-7]\b/.test(line)) {
      this.finishSasl(!/ 903 /.test(line));
      return;
    }

    // 001 = RPL_WELCOME — registration complete, safe to join now.
    if (/^:\S+ 001\b/.test(line)) {
      this.send(`JOIN ${this.config.channel}`);
      return;
    }

    const privmsg = line.match(/^:\S+ PRIVMSG (\S+) :(.*)$/);
    if (privmsg && privmsg[1].toLowerCase() === this.config.channel.toLowerCase()) {
      this.onMessage(privmsg[2]);
    }
  }
}
