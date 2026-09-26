import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

// Every write reconnects the feeds; nothing here should open a real IRC socket.
const restartIrcFeeds = vi.fn(async () => {});
vi.mock("../src/services/ircFeedManager.js", () => ({
  restartIrcFeeds: () => restartIrcFeeds(),
  stopIrcFeeds: () => {},
}));

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
});

beforeEach(() => {
  restartIrcFeeds.mockClear();
});

const BASE = {
  name: "Tracker",
  host: "irc.tracker.example",
  nickname: "aonarr",
  channel: "#announce",
  announceRegex: "(?<title>.+?) - (?<url>https?://\\S+)",
};

async function createFeed(body: Record<string, unknown>) {
  return request(app)
    .post("/api/irc-feeds")
    .set("X-Api-Key", apiKey)
    .send({ ...BASE, ...body });
}

async function storedAnnouncers(id: number): Promise<string | null> {
  return ((await db.prepare("SELECT announcers FROM irc_feeds WHERE id = ?").get(id)) as { announcers: string | null }).announcers;
}

describe("IRC feed announcers", () => {
  it("stores the announcer nicks given on create and returns them on create and list", async () => {
    const res = await createFeed({ name: "With Announcers", announcers: "  AnnounceBot, BackupBot  " });

    expect(res.status).toBe(201);
    expect(res.body.announcers).toBe("AnnounceBot, BackupBot");
    expect(await storedAnnouncers(res.body.id)).toBe("AnnounceBot, BackupBot");
    expect(restartIrcFeeds).toHaveBeenCalledTimes(1);

    const list = await request(app).get("/api/irc-feeds").set("X-Api-Key", apiKey);
    expect(list.status).toBe(200);
    expect(list.body.find((f: { id: number }) => f.id === res.body.id).announcers).toBe("AnnounceBot, BackupBot");
  });

  it("stores NULL when no announcers are given or only whitespace is", async () => {
    const omitted = await createFeed({ name: "No Announcers" });
    const blank = await createFeed({ name: "Blank Announcers", announcers: "   " });

    expect(omitted.status).toBe(201);
    expect(omitted.body.announcers).toBeNull();
    expect(await storedAnnouncers(omitted.body.id)).toBeNull();
    expect(blank.status).toBe(201);
    expect(blank.body.announcers).toBeNull();
    expect(await storedAnnouncers(blank.body.id)).toBeNull();
  });

  it("strips IRC status prefixes copied from a client's nick list and normalizes separators", async () => {
    const res = await createFeed({ name: "Prefixed Announcers", announcers: "@AnnounceBot, +Backup ~Owner,,%Half" });

    expect(res.status).toBe(201);
    expect(res.body.announcers).toBe("AnnounceBot, Backup, Owner, Half");
    expect(await storedAnnouncers(res.body.id)).toBe("AnnounceBot, Backup, Owner, Half");
  });

  it("rejects an announcer that is not a valid IRC nick instead of storing it", async () => {
    const res = await createFeed({ name: "Hostmask Announcer", announcers: "AnnounceBot!bot@tracker.example" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("AnnounceBot!bot@tracker.example");
    const row = (await db.prepare("SELECT COUNT(*) AS c FROM irc_feeds WHERE name = 'Hostmask Announcer'").get()) as { c: number | string };
    expect(Number(row.c)).toBe(0);
  });

  it("stores NULL when announcers holds only separators or bare prefixes", async () => {
    const res = await createFeed({ name: "Only Prefixes", announcers: " , @ + " });

    expect(res.status).toBe(201);
    expect(res.body.announcers).toBeNull();
    expect(await storedAnnouncers(res.body.id)).toBeNull();
  });

  it("rejects announcers that are not a string", async () => {
    const res = await createFeed({ name: "Array Announcers", announcers: ["AnnounceBot"] });

    expect(res.status).toBe(400);
    const row = (await db.prepare("SELECT COUNT(*) AS c FROM irc_feeds WHERE name = 'Array Announcers'").get()) as { c: number | string };
    expect(Number(row.c)).toBe(0);
  });

  it("sets, keeps, and clears announcers through PATCH", async () => {
    const created = await createFeed({ name: "Patched Announcers" });
    const id = created.body.id;

    const set = await request(app).patch(`/api/irc-feeds/${id}`).set("X-Api-Key", apiKey).send({ announcers: " AnnounceBot " });
    expect(set.status).toBe(200);
    expect(set.body.announcers).toBe("AnnounceBot");
    expect(await storedAnnouncers(id)).toBe("AnnounceBot");

    const untouched = await request(app).patch(`/api/irc-feeds/${id}`).set("X-Api-Key", apiKey).send({ channel: "#new-announce" });
    expect(untouched.status).toBe(200);
    expect(untouched.body.channel).toBe("#new-announce");
    expect(untouched.body.announcers).toBe("AnnounceBot");

    const cleared = await request(app).patch(`/api/irc-feeds/${id}`).set("X-Api-Key", apiKey).send({ announcers: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.announcers).toBeNull();
    expect(await storedAnnouncers(id)).toBeNull();

    const bad = await request(app).patch(`/api/irc-feeds/${id}`).set("X-Api-Key", apiKey).send({ announcers: 42 });
    expect(bad.status).toBe(400);
  });
});
