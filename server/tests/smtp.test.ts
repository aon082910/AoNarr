import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { sendEmail, sendEmailWithAttachment, type SmtpConfig } from "../src/services/smtp.js";

interface FakeSmtpServer {
  port: number;
  receivedLines: string[];
  dataPayloads: string[];
  close: () => Promise<void>;
}

/** A minimal real SMTP server good enough to drive smtp.ts's hand-rolled client end to end without
 * mocking net/tls at all: it doesn't validate protocol semantics, just replies "250 OK" to
 * anything outside of a DATA block (this client only checks the numeric code prefix and the <400
 * threshold, never the reply text, so a real server's exact wording never matters here), captures
 * every line it receives, and — when `rejectCommand` is given — replies with a 5xx for the one
 * command that starts with it, to exercise the client's error path. */
function startFakeSmtpServer(opts: { rejectCommand?: string } = {}): Promise<FakeSmtpServer> {
  return new Promise((resolve) => {
    const receivedLines: string[] = [];
    const dataPayloads: string[] = [];

    const server = net.createServer((socket) => {
      socket.write("220 fake.smtp ready\r\n");
      let buffer = "";
      let inDataMode = false;
      let dataBuffer = "";

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (inDataMode) {
            if (line === ".") {
              inDataMode = false;
              dataPayloads.push(dataBuffer);
              dataBuffer = "";
              socket.write("250 Message accepted\r\n");
            } else {
              dataBuffer += line + "\r\n";
            }
            continue;
          }

          receivedLines.push(line);
          if (opts.rejectCommand && line.startsWith(opts.rejectCommand)) {
            socket.write("550 Rejected by fake server\r\n");
          } else if (line === "DATA") {
            inDataMode = true;
            socket.write("354 Start mail input\r\n");
          } else if (line === "QUIT") {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, receivedLines, dataPayloads, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function baseConfig(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return { host: "127.0.0.1", port, secure: false, from: "aonarr@example.com", to: "user@example.com", ...overrides };
}

let activeServer: FakeSmtpServer | null = null;

afterEach(async () => {
  await activeServer?.close();
  activeServer = null;
});

describe("sendEmail", () => {
  it("sends a plain-text email through the full EHLO/MAIL/RCPT/DATA/QUIT handshake", async () => {
    activeServer = await startFakeSmtpServer();

    await sendEmail(baseConfig(activeServer.port), "Test Subject", "Test body content");

    expect(activeServer.receivedLines).toContain("EHLO aonarr");
    expect(activeServer.receivedLines).toContain("MAIL FROM:<aonarr@example.com>");
    expect(activeServer.receivedLines).toContain("RCPT TO:<user@example.com>");
    expect(activeServer.receivedLines).toContain("DATA");
    expect(activeServer.receivedLines).toContain("QUIT");
    expect(activeServer.dataPayloads).toHaveLength(1);
    expect(activeServer.dataPayloads[0]).toContain("Subject: Test Subject");
    expect(activeServer.dataPayloads[0]).toContain("Test body content");
  });

  it("sends AUTH LOGIN with base64-encoded credentials when configured", async () => {
    activeServer = await startFakeSmtpServer();

    await sendEmail(baseConfig(activeServer.port, { username: "myuser", password: "mypass" }), "Subject", "Body");

    expect(activeServer.receivedLines).toContain("AUTH LOGIN");
    expect(activeServer.receivedLines).toContain(Buffer.from("myuser", "utf-8").toString("base64"));
    expect(activeServer.receivedLines).toContain(Buffer.from("mypass", "utf-8").toString("base64"));
  });

  it("skips AUTH LOGIN entirely when no credentials are configured", async () => {
    activeServer = await startFakeSmtpServer();

    await sendEmail(baseConfig(activeServer.port), "Subject", "Body");

    expect(activeServer.receivedLines).not.toContain("AUTH LOGIN");
  });

  it("dot-stuffs a body line that would otherwise terminate the DATA block early", async () => {
    activeServer = await startFakeSmtpServer();

    await sendEmail(baseConfig(activeServer.port), "Subject", "line one\r\n.\r\nline three");

    // The lone "." line must arrive as ".." over the wire, not end DATA prematurely.
    expect(activeServer.dataPayloads[0]).toContain("line one");
    expect(activeServer.dataPayloads[0]).toContain("line three");
  });

  it("normalizes bare LF line endings in the body to CRLF, which strict relays require in DATA", async () => {
    activeServer = await startFakeSmtpServer();

    // The shape the default notification templates produce ("{mediaTitle}\n{releaseTitle}").
    await sendEmail(baseConfig(activeServer.port), "Subject", "Movie Title\nRelease.Name.1080p");

    const payload = activeServer.dataPayloads[0];
    expect(payload).toContain("Movie Title\r\nRelease.Name.1080p\r\n");
    expect(payload).not.toMatch(/(^|[^\r])\n/);
  });

  it("dot-stuffs a '.' line that follows a bare LF, not just one after CRLF", async () => {
    activeServer = await startFakeSmtpServer();

    await sendEmail(baseConfig(activeServer.port), "Subject", "line one\n.\nline three");

    expect(activeServer.dataPayloads[0]).toContain("line one\r\n..\r\nline three");
  });

  it("rejects with the SMTP error when a command is refused", async () => {
    activeServer = await startFakeSmtpServer({ rejectCommand: "MAIL FROM" });

    await expect(sendEmail(baseConfig(activeServer.port), "Subject", "Body")).rejects.toThrow(/SMTP error/);
  });
});

describe("sendEmailWithAttachment", () => {
  it("sends a multipart message with the attachment's base64 content and headers", async () => {
    activeServer = await startFakeSmtpServer();
    const attachment = { filename: "book.epub", content: Buffer.from("fake epub bytes"), contentType: "application/epub+zip" };

    await sendEmailWithAttachment(baseConfig(activeServer.port), "Send to Kindle", "Enjoy your book", attachment);

    const payload = activeServer.dataPayloads[0];
    expect(payload).toContain("Content-Type: multipart/mixed");
    expect(payload).toContain('filename="book.epub"');
    expect(payload).toContain("Content-Transfer-Encoding: base64");
    expect(payload).toContain(Buffer.from("fake epub bytes").toString("base64"));
    expect(payload).toContain("Enjoy your book");
  });

  it("normalizes bare LF line endings in the text part to CRLF", async () => {
    activeServer = await startFakeSmtpServer();
    const attachment = { filename: "book.epub", content: Buffer.from("fake epub bytes"), contentType: "application/epub+zip" };

    await sendEmailWithAttachment(baseConfig(activeServer.port), "Send to Kindle", "Enjoy\nyour book", attachment);

    const payload = activeServer.dataPayloads[0];
    expect(payload).toContain("Enjoy\r\nyour book\r\n");
    expect(payload).not.toMatch(/(^|[^\r])\n/);
  });

  it("names a non-ASCII attachment with an ASCII fallback plus an RFC 2231 UTF-8 parameter, and encodes the subject", async () => {
    activeServer = await startFakeSmtpServer();
    const attachment = { filename: "Les Misérables.epub", content: Buffer.from("fake epub bytes"), contentType: "application/epub+zip" };

    await sendEmailWithAttachment(baseConfig(activeServer.port), "Les Misérables", "Enjoy", attachment);

    const headers = unfold(activeServer.dataPayloads[0]);
    const encodedName = "Les%20Mis%C3%A9rables.epub";
    expect(headerLine(headers, "Content-Disposition")).toBe(
      `Content-Disposition: attachment; filename="Les Miserables.epub"; filename*=UTF-8''${encodedName}`
    );
    expect(headerLine(headers, "Content-Type: application/epub+zip")).toBe(
      `Content-Type: application/epub+zip; name="Les Miserables.epub"; name*=UTF-8''${encodedName}`
    );
    const subject = headerLine(headers, "Subject");
    expect(subject).toMatch(/^Subject: [\x20-\x7e]+$/);
    expect(decodeEncodedWords(subject.slice("Subject: ".length))).toBe("Les Misérables");
  });

  it("strips CR/LF, quotes and backslashes from an attachment name instead of letting them end the parameter or start a header", async () => {
    activeServer = await startFakeSmtpServer();
    const attachment = { filename: 'Bad "Name"\\\r\nBcc: v@x.io.epub', content: Buffer.from("x"), contentType: "application/epub+zip" };

    await sendEmailWithAttachment(baseConfig(activeServer.port), "Send to Kindle", "Enjoy", attachment);

    const payload = activeServer.dataPayloads[0];
    expect(payload).not.toMatch(/\r\nBcc:/i);
    const disposition = headerLine(unfold(payload), "Content-Disposition");
    expect(disposition).toMatch(/^Content-Disposition: attachment; filename="Bad Name Bcc: v@x\.io\.epub"; filename\*=UTF-8''[A-Za-z0-9%!#$&+.^_`|~-]+$/);
    expect(disposition).toContain("Bad%20%22Name%22%5C%20Bcc%3A%20v%40x.io.epub");
  });

  it("keeps every header line short for a long non-ASCII name by splitting its UTF-8 parameter into continuations", async () => {
    activeServer = await startFakeSmtpServer();
    const title = "転生したらスライムだった件".repeat(8);
    const attachment = { filename: `${title}.epub`, content: Buffer.from("x"), contentType: "application/epub+zip" };

    await sendEmailWithAttachment(baseConfig(activeServer.port), title, "Enjoy", attachment);

    const payload = activeServer.dataPayloads[0];
    for (const line of payload.split("\r\n")) expect(line.length).toBeLessThanOrEqual(100);
    const disposition = headerLine(unfold(payload), "Content-Disposition");
    expect(disposition).toContain('filename="attachment.epub"');
    const segments = [...disposition.matchAll(/filename\*(\d+)\*=(?:UTF-8'')?([^;]+)/g)];
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((m) => Number(m[1]))).toEqual(segments.map((_m, i) => i));
    expect(decodeURIComponent(segments.map((m) => m[2]).join(""))).toBe(`${title}.epub`);
    expect(decodeEncodedWords(headerLine(unfold(payload), "Subject").slice("Subject: ".length))).toBe(title);
  });

  it("base64-encodes a non-ASCII text part rather than sending undeclared 8-bit data", async () => {
    activeServer = await startFakeSmtpServer();
    const attachment = { filename: "book.epub", content: Buffer.from("x"), contentType: "application/epub+zip" };

    await sendEmailWithAttachment(baseConfig(activeServer.port), "Send to Kindle", "Sent from AoNarr: Les Misérables", attachment);

    const payload = activeServer.dataPayloads[0];
    expect(payload).not.toMatch(/[^\x00-\x7f]/);
    const textPart = payload.split(/--aonarr-[0-9a-f]+/)[1];
    expect(textPart).toContain("Content-Transfer-Encoding: base64");
    const body = textPart.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Sent from AoNarr: Les Misérables");
  });
});

describe("sendEmail header encoding", () => {
  it("encodes a non-ASCII subject and body, and leaves ASCII ones as they are", async () => {
    activeServer = await startFakeSmtpServer();

    await sendEmail(baseConfig(activeServer.port), "Grabbed: Amélie", "Amélie (2001)");
    await sendEmail(baseConfig(activeServer.port), "Grabbed: Heat", "Heat (1995)");

    const [encoded, plain] = activeServer.dataPayloads;
    expect(encoded).not.toMatch(/[^\x00-\x7f]/);
    expect(decodeEncodedWords(headerLine(unfold(encoded), "Subject").slice("Subject: ".length))).toBe("Grabbed: Amélie");
    expect(encoded).toContain("MIME-Version: 1.0");
    expect(encoded).toContain("Content-Transfer-Encoding: base64");
    expect(plain).toContain("Subject: Grabbed: Heat\r\n");
    expect(plain).toContain("Heat (1995)");
  });

  it("passes an already-encoded subject through unchanged", async () => {
    activeServer = await startFakeSmtpServer();
    const preEncoded = `=?UTF-8?B?${Buffer.from("Les Misérables").toString("base64")}?=`;

    await sendEmail(baseConfig(activeServer.port), preEncoded, "Body");

    expect(activeServer.dataPayloads[0]).toContain(`Subject: ${preEncoded}\r\n`);
  });
});

/** Header folding (CRLF + whitespace) undone, so each header reads as one line. */
function unfold(message: string): string {
  return message.replace(/\r\n[ \t]+/g, " ");
}

function headerLine(unfolded: string, prefix: string): string {
  const line = unfolded.split("\r\n").find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`no "${prefix}" header in:\n${unfolded}`);
  return line;
}

function decodeEncodedWords(value: string): string {
  // Whitespace between adjacent encoded-words is dropped when decoding (RFC 2047 §6.2).
  const words = [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
  expect(words.map((m) => m[0]).join(" ")).toBe(value);
  return Buffer.concat(words.map((m) => Buffer.from(m[1], "base64"))).toString("utf8");
}
