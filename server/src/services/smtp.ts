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

// An idle timeout, not a total-transaction deadline — bounds how long any single stage (initial
// connect, waiting on a reply, the STARTTLS upgrade) can go completely silent. Without this, a
// host that accepts the TCP connection but never replies (a firewall silently drops the response,
// a broken relay) hangs sendEmail() forever — and since notifications.ts's fan-out awaits every
// target via Promise.allSettled, and scheduler.ts's grab() awaits notifyGrabbed() synchronously,
// one such host wedges the entire grab pipeline, not just email delivery.
const SMTP_IDLE_TIMEOUT_MS = 30_000;

/** Notification bodies come from templates using bare "\n". A bare LF (or CR) in DATA violates RFC
 * 5321, is rejected outright by strict relays (Postfix 3.9+'s smtpd_forbid_bare_newline), and
 * hides a "."-leading line from dot-stuffing — so every line ending is normalized to CRLF first. */
function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

const NON_ASCII = /[^\x00-\x7f]/;

/** RFC 2047 "B" encoded-words for a header value with non-ASCII characters (raw 8-bit bytes aren't
 * allowed in a header); ASCII passes through. Split on character boundaries at 39 bytes, so each
 * word stays within 75 characters and each folded line within 76, "Subject: " included. */
function encodeHeaderWords(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > 39) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`).join("\r\n ");
}

function wrapBase64(data: Buffer): string {
  return data.toString("base64").replace(/(.{76})(?=.)/g, "$1\r\n");
}

/** A text/plain part's headers and body. A UTF-8 body with non-ASCII characters is base64-encoded:
 * undeclared 8-bit data is only allowed to a relay that advertised 8BITMIME. */
function textPart(body: string): string[] {
  const text = toCrlf(body);
  if (!NON_ASCII.test(text)) return [`Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: 7bit`, "", text];
  return [`Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: base64`, "", wrapBase64(Buffer.from(text, "utf8"))];
}

/** RFC 2231 extended-value characters, which is encodeURIComponent's set minus ' ( ) *. */
function rfc2231Encode(ch: string): string {
  return encodeURIComponent(ch).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A file name as MIME parameters: a quoted ASCII fallback (accents folded; other non-ASCII,
 * quotes, backslashes and control characters dropped) plus, when that lost anything, the full
 * UTF-8 name as an RFC 2231 extended parameter — split into continuations so no header line
 * outgrows SMTP's line limit. */
function fileNameParams(param: string, filename: string): string[] {
  const name = filename
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/[\ud800-\udfff]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  let fallback = name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\x20-\x7e]+|["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!fallback || fallback.startsWith(".")) fallback = `attachment${fallback}`;
  const params = [`${param}="${fallback}"`];
  if (fallback === name) return params;

  const segments: string[] = [];
  let segment = "";
  for (const ch of name) {
    const encoded = rfc2231Encode(ch);
    if (segment && segment.length + encoded.length > 60) {
      segments.push(segment);
      segment = "";
    }
    segment += encoded;
  }
  if (segment) segments.push(segment);
  if (segments.length === 1) params.push(`${param}*=UTF-8''${segments[0]}`);
  else segments.forEach((s, i) => params.push(i === 0 ? `${param}*0*=UTF-8''${s}` : `${param}*${i}*=${s}`));
  return params;
}

function armIdleTimeout(socket: net.Socket, cfg: SmtpConfig): void {
  socket.setTimeout(SMTP_IDLE_TIMEOUT_MS);
  socket.once("timeout", () => {
    socket.destroy(new Error(`SMTP connection to ${cfg.host}:${cfg.port} timed out after ${SMTP_IDLE_TIMEOUT_MS / 1000}s of inactivity`));
  });
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
  armIdleTimeout(socket, cfg);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });

  let activeSocket = socket;
  let buffer = "";

  function readResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = activeSocket;
      const onError = (err: Error) => {
        socket.off("data", onData);
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        // An SMTP multi-line reply ends on a line "NNN " (space, not dash) — wait for that.
        const lines = buffer.split("\r\n").filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && /^\d{3} /.test(last)) {
          socket.off("data", onData);
          socket.off("error", onError);
          const code = Number(buffer.slice(0, 3));
          const result = buffer;
          buffer = "";
          if (code >= 400) reject(new Error(`SMTP error: ${result.trim()}`));
          else resolve(result);
        }
      };
      socket.on("data", onData);
      socket.once("error", onError);
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
    armIdleTimeout(upgraded, cfg);
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

    const rawMessage = [
      `From: AoNarr <${cfg.from}>`,
      `To: <${cfg.to}>`,
      `Subject: ${encodeHeaderWords(subject)}`,
      `MIME-Version: 1.0`,
      ...textPart(body),
    ].join("\r\n");
    // Escaped on the fully-assembled message, not on `body` in isolation — a body starting with
    // "." needs the \r\n that precedes it (from the join above) to already be in place for the
    // dot-stuffing regex to see it, the same way sendEmailWithAttachment already does it below.
    const message = `${rawMessage.replace(/\r\n\./g, "\r\n..")}\r\n.`;
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
    const rawMessage = [
      `From: AoNarr <${cfg.from}>`,
      `To: <${cfg.to}>`,
      `Subject: ${encodeHeaderWords(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...textPart(body),
      "",
      `--${boundary}`,
      [`Content-Type: ${attachment.contentType}`, ...fileNameParams("name", attachment.filename)].join(";\r\n "),
      `Content-Transfer-Encoding: base64`,
      ["Content-Disposition: attachment", ...fileNameParams("filename", attachment.filename)].join(";\r\n "),
      "",
      wrapBase64(attachment.content),
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
