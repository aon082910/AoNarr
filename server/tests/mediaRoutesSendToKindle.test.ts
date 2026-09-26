import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

const sendEmailWithAttachment = vi.fn();
vi.mock("../src/services/smtp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/smtp.js")>()),
  sendEmailWithAttachment: (...args: unknown[]) => sendEmailWithAttachment(...args),
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function insertBook(title: string): Promise<{ authorId: number; subId: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-kindle-"));
  const filePath = path.join(dir, "book.EPUB");
  fs.writeFileSync(filePath, "epub bytes");
  const authorId = Number(
    (
      await db
        .prepare(`INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('author', 'Kindle Author', 'kindle author', 1, 1, 'continuing')`)
        .run()
    ).lastInsertRowid
  );
  const subId = Number(
    (await db.prepare(`INSERT INTO sub_items (media_item_id, title, monitored, has_file, file_path) VALUES (?, ?, 1, 1, ?)`).run(authorId, title, filePath))
      .lastInsertRowid
  );
  return { authorId, subId };
}

describe("POST /api/media/:id/subitems/:subItemId/send-to-kindle", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("kindleEmailAddress", "reader@kindle.example");
    setSetting("smtpHost", "smtp.example");
    setSetting("smtpFrom", "aonarr@example");
  });

  it("keeps quotes, backslashes and line breaks in the title out of the mail headers", async () => {
    sendEmailWithAttachment.mockReset().mockResolvedValue(undefined);
    const { authorId, subId } = await insertBook('The "Real" Story\r\nBcc: someone@example\\Part 2');

    const res = await request(app).post(`/api/media/${authorId}/subitems/${subId}/send-to-kindle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const [cfg, subject, body, attachment] = sendEmailWithAttachment.mock.calls[0];
    expect(cfg.to).toBe("reader@kindle.example");
    expect(subject).toBe("The 'Real' Story Bcc: someone@example\\Part 2");
    expect(subject).not.toMatch(/[\r\n]/);
    expect(attachment.filename).toBe("The 'Real' Story Bcc: someone@example_Part 2.epub");
    expect(attachment.filename).not.toMatch(/["\\\r\n]/);
    expect(attachment.contentType).toBe("application/epub+zip");
    expect(body).toContain('The "Real" Story');
  });

  it("leaves an ordinary ASCII title as it is", async () => {
    sendEmailWithAttachment.mockReset().mockResolvedValue(undefined);
    const { authorId, subId } = await insertBook("The Hobbit");

    await request(app).post(`/api/media/${authorId}/subitems/${subId}/send-to-kindle`).set("X-Api-Key", apiKey);

    const [, subject, , attachment] = sendEmailWithAttachment.mock.calls[0];
    expect(subject).toBe("The Hobbit");
    expect(attachment.filename).toBe("The Hobbit.epub");
  });

  // The mail layer RFC 2047-encodes the subject and adds the RFC 2231 filename* itself, so the
  // route hands both over with their non-ASCII characters intact.
  it("keeps accented characters in the subject and attachment name", async () => {
    sendEmailWithAttachment.mockReset().mockResolvedValue(undefined);
    const { authorId, subId } = await insertBook("Les Misérables");

    const res = await request(app).post(`/api/media/${authorId}/subitems/${subId}/send-to-kindle`).set("X-Api-Key", apiKey);

    expect(res.status).toBe(200);
    const [, subject, body, attachment] = sendEmailWithAttachment.mock.calls[0];
    expect(subject).toBe("Les Misérables");
    expect(attachment.filename).toBe("Les Misérables.epub");
    expect(body).toContain("Les Misérables");
  });

  it("keeps a non-Latin title as the attachment name instead of folding it to Untitled", async () => {
    sendEmailWithAttachment.mockReset().mockResolvedValue(undefined);
    const { authorId, subId } = await insertBook("進撃の巨人");

    await request(app).post(`/api/media/${authorId}/subitems/${subId}/send-to-kindle`).set("X-Api-Key", apiKey);

    const [, subject, , attachment] = sendEmailWithAttachment.mock.calls[0];
    expect(subject).toBe("進撃の巨人");
    expect(attachment.filename).toBe("進撃の巨人.epub");
  });

  it("keeps a long mixed-script title whole, with only path separators replaced in the name", async () => {
    sendEmailWithAttachment.mockReset().mockResolvedValue(undefined);
    const title = "進撃の巨人 第34巻 — Édition collector/illustrée";
    const { authorId, subId } = await insertBook(title);

    await request(app).post(`/api/media/${authorId}/subitems/${subId}/send-to-kindle`).set("X-Api-Key", apiKey);

    const [, subject, , attachment] = sendEmailWithAttachment.mock.calls[0];
    expect(subject).toBe(title);
    expect(attachment.filename).toBe("進撃の巨人 第34巻 — Édition collector_illustrée.epub");
  });

  it("names the attachment Untitled only when the title is empty", async () => {
    sendEmailWithAttachment.mockReset().mockResolvedValue(undefined);
    const { authorId, subId } = await insertBook("  \r\n ");

    await request(app).post(`/api/media/${authorId}/subitems/${subId}/send-to-kindle`).set("X-Api-Key", apiKey);

    const [, subject, , attachment] = sendEmailWithAttachment.mock.calls[0];
    expect(subject).toBe("Untitled");
    expect(attachment.filename).toBe("Untitled.epub");
  });
});
