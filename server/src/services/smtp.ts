import crypto from "node:crypto";
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
 * Handshake shared by every send — connect, optional STARTTLS upgrade, optional AUTH LOGIN.
 * Returns a `send` closure (writes one line, awaits the reply) and the final active socket
 * (post-STARTTLS-upgrade, if that happened) for the caller to write MAIL/RCPT/DATA + message on
 * and `.end()` when done.
 */
async function connectAndAuth(cfg: SmtpConfig): Promise<{ send: (line: string) => Promise<string>; socket: net.Socket }> {
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

  return { send, socket: activeSocket };
}

/**
 * Minimal SMTP client (EHLO, optional STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA) implemented directly
 * on Node's net/tls sockets rather than a dependency — the protocol is small and well-specified
 * (RFC 5321), and this only ever needs to send a single plain-text notification, not build/parse
 * arbitrary MIME.
 */
export async function sendEmail(cfg: SmtpConfig, subject: string, body: string): Promise<void> {
  const { send, socket } = await connectAndAuth(cfg);
  try {
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
    socket.end();
  }
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/**
 * Same handshake as sendEmail, a multipart/mixed message instead of plain text — for "Send to
 * Kindle" (routes/media.ts), which needs to deliver an actual ebook/comic file as an attachment,
 * something no existing notification path needed before.
 */
export async function sendEmailWithAttachment(cfg: SmtpConfig, subject: string, body: string, attachment: EmailAttachment): Promise<void> {
  const { send, socket } = await connectAndAuth(cfg);
  try {
    await send(`MAIL FROM:<${cfg.from}>`);
    await send(`RCPT TO:<${cfg.to}>`);
    await send("DATA");

    const boundary = `aonarr-${crypto.randomBytes(12).toString("hex")}`;
    const base64Content = attachment.content.toString("base64").replace(/(.{76})/g, "$1\r\n");
    const rawMessage = [
      `From: AoNarr <${cfg.from}>`,
      `To: <${cfg.to}>`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      "",
      body,
      "",
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      base64Content,
      "",
      `--${boundary}--`,
    ].join("\r\n");
    // Dot-stuffing (RFC 5321 §4.5.2) applies to the whole DATA payload, not just the plain-text
    // part — a base64 line starting with "." is astronomically unlikely but free to guard against.
    const message = `${rawMessage.replace(/\r\n\./g, "\r\n..")}\r\n.`;
    await send(message);

    await send("QUIT");
  } finally {
    socket.end();
  }
}
