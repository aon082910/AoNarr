import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

const grab = vi.fn(async () => {});
vi.mock("../src/services/scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/scheduler.js")>();
  return { ...actual, grab: (...args: unknown[]) => grab(...args) };
});

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let handleAnnounce: (typeof import("../src/services/ircAnnounce.js"))["handleAnnounce"];

beforeAll(async () => {
  ({ db } = await setupTestDb());
  ({ handleAnnounce } = await import("../src/services/ircAnnounce.js"));
});

const FEED = { id: 1, name: "TestFeed", announce_regex: "(?<title>.+?) - (?<url>https?://\\S+)", protocol: "torrent" as const };

async function insertTorrentClient(): Promise<void> {
  await db.prepare("INSERT INTO download_clients (name, type, enabled) VALUES ('Test qBit', 'qbittorrent', 1)").run();
}

async function insertProfile(overrides: { allowedQualities?: string[]; minFormatScore?: number } = {}): Promise<number> {
  const { allowedQualities = ["WEBDL-1080p"], minFormatScore = 0 } = overrides;
  return Number(
    (
      await db
        .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, min_format_score) VALUES (?, ?, 'WEBDL-1080p', ?)")
        .run(`Profile-${Math.random()}`, JSON.stringify(allowedQualities), minFormatScore)
    ).lastInsertRowid
  );
}

async function insertMovie(title: string, qualityProfileId: number | null, year: number | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, quality_profile_id) VALUES ('movie', ?, ?, ?, 1, 0, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), year, qualityProfileId)
    ).lastInsertRowid
  );
}

async function insertShow(title: string, qualityProfileId: number | null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id) VALUES ('series', ?, ?, 1, 0, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), qualityProfileId)
    ).lastInsertRowid
  );
}

async function insertEpisode(showId: number, season: number, episode: number): Promise<number> {
  return Number(
    (
      await db
        .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, monitored, has_file) VALUES (?, ?, ?, 1, 0)")
        .run(showId, season, episode)
    ).lastInsertRowid
  );
}

function announceText(releaseTitle: string, url = "https://example.com/dl/1"): string {
  return `${releaseTitle} - ${url}`;
}

describe("handleAnnounce — parsing/gating", () => {
  it("warns and returns for an invalid announce_regex, without throwing", async () => {
    await expect(
      handleAnnounce({ ...FEED, announce_regex: "(unterminated[" }, announceText("Anything 2021 1080p WEBDL"))
    ).resolves.not.toThrow();
    expect(grab).not.toHaveBeenCalled();
  });

  it("does nothing when the regex doesn't produce named title/url groups", async () => {
    await handleAnnounce({ ...FEED, announce_regex: "no named groups here" }, announceText("Anything 2021 1080p WEBDL"));
    expect(grab).not.toHaveBeenCalled();
  });

  it("does nothing when no download clients are configured", async () => {
    await handleAnnounce(FEED, announceText("Some Movie 2021 1080p WEBDL"));
    expect(grab).not.toHaveBeenCalled();
  });
});

describe("handleAnnounce — movies", () => {
  it("grabs a monitored, missing movie matched by title", async () => {
    await insertTorrentClient();
    const profileId = await insertProfile();
    const id = await insertMovie("Announce Movie", profileId);

    await handleAnnounce(FEED, announceText("Announce Movie 2021 1080p WEBDL"));

    expect(grab).toHaveBeenCalledTimes(1);
    const [, mediaItem, episodeId] = grab.mock.calls[0];
    expect((mediaItem as any).id).toBe(id);
    expect(episodeId).toBeNull();
  });

  it("does not grab a movie that's already queued", async () => {
    const profileId = await insertProfile();
    const id = await insertMovie("Already Queued Movie", profileId);
    await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'existing queued release', 'queued')").run(id);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Already Queued Movie 2021 1080p WEBDL"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("does not grab a quality that isn't in the item's allowed qualities", async () => {
    const profileId = await insertProfile({ allowedQualities: ["Remux-2160p"] }); // 1080p WEBDL not allowed
    await insertMovie("Disallowed Quality Movie", profileId);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Disallowed Quality Movie 2021 1080p WEBDL"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("does not grab a release title that's on the item's blocklist", async () => {
    const profileId = await insertProfile();
    const id = await insertMovie("Blocklisted Movie", profileId);
    const releaseTitle = "Blocklisted Movie 2021 1080p WEBDL";
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title) VALUES (?, ?)").run(id, releaseTitle);
    grab.mockClear();

    await handleAnnounce(FEED, announceText(releaseTitle));

    expect(grab).not.toHaveBeenCalled();
  });

  it("does not grab a same-title release from a different year", async () => {
    const profileId = await insertProfile();
    await insertMovie("Remade Movie", profileId, 2021);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Remade.Movie.1984.1080p.WEBDL-GRP"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("grabs for the item whose year matches when an original and its remake are both missing", async () => {
    const profileId = await insertProfile();
    await insertMovie("Twice Made Movie", profileId, 1984);
    const remakeId = await insertMovie("Twice Made Movie", profileId, 2021);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Twice.Made.Movie.2021.1080p.WEBDL-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(remakeId);
  });

  it("allows one year of slack between the release and the item", async () => {
    const profileId = await insertProfile();
    const id = await insertMovie("Festival Year Movie", profileId, 2020);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Festival.Year.Movie.2021.1080p.WEBDL-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });

  it("does not grab when the release scores below the profile's minimum format score", async () => {
    const profileId = await insertProfile({ minFormatScore: 5 }); // no custom formats exist, so every release scores 0
    await insertMovie("Below Min Score Movie", profileId);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Below Min Score Movie 2021 1080p WEBDL"));

    expect(grab).not.toHaveBeenCalled();
  });
});

describe("handleAnnounce — episodes", () => {
  it("grabs a monitored, missing episode matched by title/season/episode", async () => {
    const profileId = await insertProfile();
    const showId = await insertShow("Announce Show", profileId);
    const episodeId = await insertEpisode(showId, 2, 5);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Announce Show S02E05 1080p WEBDL"));

    expect(grab).toHaveBeenCalledTimes(1);
    const [, mediaItem, grabbedEpisodeId] = grab.mock.calls[0];
    expect((mediaItem as any).id).toBe(showId);
    expect(grabbedEpisodeId).toBe(episodeId);
  });

  it("does not grab an episode release for the wrong season/episode number", async () => {
    const profileId = await insertProfile();
    const showId = await insertShow("Wrong Episode Show", profileId);
    await insertEpisode(showId, 1, 1);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Wrong Episode Show S03E09 1080p WEBDL"));

    expect(grab).not.toHaveBeenCalled();
  });
});
