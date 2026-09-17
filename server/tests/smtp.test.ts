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
});
