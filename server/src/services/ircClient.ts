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
    socket.on("connect", () => this.onConnect());
    socket.on("secureConnect", () => this.onConnect());
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => log.warn(`[irc:${this.config.name}] socket error:`, err.message));
    socket.on("close", () => this.scheduleReconnect());
  }

  private onConnect(): void {
    log.info(`[irc:${this.config.name}] connected to ${this.config.host}:${this.config.port}`);
    if (this.config.saslUser && this.config.saslPass) {
      this.send("CAP REQ :sasl");
    } else {
      this.registerNickAndUser();
    }
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

    if (line.startsWith("CAP") && line.includes("ACK") && line.includes("sasl")) {
      this.send("AUTHENTICATE PLAIN");
      return;
    }
    if (line.startsWith("AUTHENTICATE +")) {
      const { saslUser, saslPass } = this.config;
      const payload = Buffer.from(`\0${saslUser}\0${saslPass}`, "utf-8").toString("base64");
      this.send(`AUTHENTICATE ${payload}`);
      return;
    }
    // 903 = SASL successful, 904/905 = failed — either way, stop trying to authenticate and
    // proceed with registration so a misconfigured SASL doesn't block the connection forever.
    if (/^:\S+ 90[345]\b/.test(line)) {
      if (!this.saslDone) {
        this.saslDone = true;
        if (/ 904 | 905 /.test(line)) log.warn(`[irc:${this.config.name}] SASL auth failed`);
        this.send("CAP END");
        this.registerNickAndUser();
      }
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
