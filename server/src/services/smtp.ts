import net from "node:net";
import tls from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS (port 465); false = plaintext or STARTTLS (587/25)
  username?: string;
  password?: string;
  from: string;
  to: string;
}

/**
 * Minimal SMTP client (EHLO, optional STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA) implemented directly
 * on Node's net/tls sockets rather than a dependency — the protocol is small and well-specified
 * (RFC 5321), and this only ever needs to send a single plain-text notification, not build/parse
 * arbitrary MIME.
 */
export async function sendEmail(cfg: SmtpConfig, subject: string, body: string): Promise<void> {
  const socket: net.Socket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });

  let activeSocket = socket;
  let buffer = "";

  function readResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        // An SMTP multi-line reply ends on a line "NNN " (space, not dash) — wait for that.
        const lines = buffer.split("\r\n").filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && /^\d{3} /.test(last)) {
          activeSocket.off("data", onData);
          const code = Number(buffer.slice(0, 3));
          const result = buffer;
          buffer = "";
          if (code >= 400) reject(new Error(`SMTP error: ${result.trim()}`));
          else resolve(result);
        }
      };
      activeSocket.on("data", onData);
      activeSocket.once("error", reject);
    });
  }

  function send(line: string): Promise<string> {
    activeSocket.write(line + "\r\n");
    return readResponse();
  }

  try {
    await readResponse(); // server greeting
    let ehloReply = await send(`EHLO aonarr`);

    if (!cfg.secure && /STARTTLS/i.test(ehloReply)) {
      await send("STARTTLS");
      const plainSocket = activeSocket;
      const upgraded: tls.TLSSocket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: plainSocket, servername: cfg.host }, () => resolve(t));
        t.once("error", reject);
      });
      activeSocket = upgraded;
      ehloReply = await send(`EHLO aonarr`);
    }

    if (cfg.username && cfg.password) {
      await send("AUTH LOGIN");
      await send(Buffer.from(cfg.username, "utf-8").toString("base64"));
      await send(Buffer.from(cfg.password, "utf-8").toString("base64"));
    }

    await send(`MAIL FROM:<${cfg.from}>`);
    await send(`RCPT TO:<${cfg.to}>`);
    await send("DATA");

    const escapedBody = body.replace(/\r\n\./g, "\r\n..");
    const message = [
      `From: AoNarr <${cfg.from}>`,
      `To: <${cfg.to}>`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      "",
      escapedBody,
      ".",
    ].join("\r\n");
    await send(message);

    await send("QUIT");
  } finally {
    activeSocket.end();
  }
}
