import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
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

async function insertShow(title: string, qualityProfileId: number | null, year: number | null = null): Promise<number> {
  return Number(
    (
      await db
        .prepare(
          `INSERT INTO media_items (type, title, sort_title, year, monitored, has_file, status, quality_profile_id) VALUES ('series', ?, ?, ?, 1, 0, 'unknown', ?)`
        )
        .run(title, title.toLowerCase(), year, qualityProfileId)
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

  it("does not grab a same-title reboot's episode for the original show", async () => {
    const profileId = await insertProfile();
    const originalId = await insertShow("Rebooted Show", profileId, 1998);
    await insertEpisode(originalId, 1, 1);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Rebooted.Show.2018.S01E01.1080p.WEBDL-GRP"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("grabs for the show whose year matches when both the original and the reboot are tracked", async () => {
    const profileId = await insertProfile();
    const originalId = await insertShow("Twice Aired Show", profileId, 1998);
    await insertEpisode(originalId, 1, 1);
    const rebootId = await insertShow("Twice Aired Show", profileId, 2018);
    const rebootEpisodeId = await insertEpisode(rebootId, 1, 1);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Twice.Aired.Show.2018.S01E01.1080p.WEBDL-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(rebootId);
    expect(grab.mock.calls[0][2]).toBe(rebootEpisodeId);
  });
});

describe("handleAnnounce — delay profiles", () => {
  afterEach(async () => {
    await db.prepare("DELETE FROM delay_profiles").run();
  });

  async function insertDelayProfile(p: {
    tagId?: number | null;
    enableTorrent?: boolean;
    torrentDelayMinutes?: number;
    bypassIfHighestQuality?: boolean;
  }): Promise<void> {
    await db
      .prepare(
        `INSERT INTO delay_profiles (tag_id, enable_usenet, enable_torrent, usenet_delay_minutes, torrent_delay_minutes, bypass_if_highest_quality, order_index)
         VALUES (?, 1, ?, 0, ?, ?, 0)`
      )
      .run(p.tagId ?? null, p.enableTorrent === false ? 0 : 1, p.torrentDelayMinutes ?? 0, p.bypassIfHighestQuality ? 1 : 0);
  }

  it("does not grab from a torrent feed when the item's delay profile disables torrents", async () => {
    await insertDelayProfile({ enableTorrent: false });
    const profileId = await insertProfile();
    await insertMovie("Usenet Only Movie", profileId);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Usenet Only Movie 2021 1080p WEBDL"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("holds back a fresh announce while the delay profile has a positive delay for its protocol", async () => {
    await insertDelayProfile({ torrentDelayMinutes: 120 });
    const profileId = await insertProfile();
    await insertMovie("Delayed Torrent Movie", profileId);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Delayed Torrent Movie 2021 1080p WEBDL"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("lets a cutoff-quality release through the delay when the profile allows bypassing it", async () => {
    await insertDelayProfile({ torrentDelayMinutes: 120, bypassIfHighestQuality: true });
    const profileId = await insertProfile(); // cutoff WEBDL-1080p
    const id = await insertMovie("Bypass Delay Movie", profileId);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Bypass Delay Movie 2021 1080p WEBDL"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });

  it("applies a tagged item's own profile ahead of the untagged default", async () => {
    const tagId = Number((await db.prepare("INSERT INTO tags (name) VALUES ('irc-torrent-ok')").run()).lastInsertRowid);
    await insertDelayProfile({ enableTorrent: false });
    await insertDelayProfile({ tagId });
    const profileId = await insertProfile();
    const taggedId = await insertMovie("Tagged Torrent Movie", profileId);
    await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?)").run(taggedId, tagId);
    await insertMovie("Untagged Torrent Movie", profileId);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Untagged Torrent Movie 2021 1080p WEBDL"));
    expect(grab).not.toHaveBeenCalled();

    await handleAnnounce(FEED, announceText("Tagged Torrent Movie 2021 1080p WEBDL"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(taggedId);
  });
});

describe("handleAnnounce — announces for one target arriving together", () => {
  it("grabs only once when two qualities of the same missing movie are announced at once", async () => {
    const profileId = await insertProfile({ allowedQualities: ["WEBDL-1080p", "WEBDL-720p"] });
    const id = await insertMovie("Racing Announce Movie", profileId, 2024);
    grab.mockClear();
    // Like the real grab(): the download client call yields before the queue row is written.
    grab.mockImplementation((async (_client: unknown, item: any) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await db.prepare("INSERT INTO queue (media_item_id, title, status) VALUES (?, 'racing release', 'queued')").run(item.id);
    }) as any);
    try {
      await Promise.all([
        handleAnnounce(FEED, announceText("Racing.Announce.Movie.2024.1080p.WEBDL-GRP")),
        handleAnnounce(FEED, announceText("Racing.Announce.Movie.2024.720p.WEBDL-GRP")),
      ]);
    } finally {
      grab.mockImplementation(async () => {});
    }

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });

  it("still grabs the second announce when the first one for that target is rejected", async () => {
    const profileId = await insertProfile({ allowedQualities: ["WEBDL-1080p"] });
    await insertMovie("Waiting Announce Movie", profileId, 2024);
    grab.mockClear();

    await Promise.all([
      handleAnnounce(FEED, announceText("Waiting.Announce.Movie.2024.720p.WEBDL-GRP")), // quality not allowed
      handleAnnounce(FEED, announceText("Waiting.Announce.Movie.2024.1080p.WEBDL-GRP")),
    ]);

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][4] as any).result.title).toContain("1080p");
  });
});

describe("handleAnnounce — media types without quality tiers", () => {
  it("grabs a ROM even though its profile only allows video qualities", async () => {
    const profileId = await insertProfile({ allowedQualities: ["WEBDL-1080p"] });
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id) VALUES ('rom', 'Announce Rom Game', 'announce rom game', 1, 0, 'unknown', ?)`
          )
          .run(profileId)
      ).lastInsertRowid
    );
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Announce.Rom.Game.2021.NSW-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });
});

describe("handleAnnounce — root folder quota", () => {
  // quota_percent 0 is reached by any real disk; 100 by none that still has room to write to.
  async function insertRootFolder(mediaType: string, quotaPercent: number): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aonarr-irc-root-"));
    return Number(
      (
        await db
          .prepare("INSERT INTO root_folders (path, media_type, quota_percent, pause_grabs_at_quota) VALUES (?, ?, ?, 1)")
          .run(dir, mediaType, quotaPercent)
      ).lastInsertRowid
    );
  }

  it("does not grab a movie whose root folder is over its quota", async () => {
    const rootId = await insertRootFolder("movie", 0);
    const profileId = await insertProfile();
    const id = await insertMovie("Full Disk Movie", profileId);
    await db.prepare("UPDATE media_items SET root_folder_id = ? WHERE id = ?").run(rootId, id);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Full.Disk.Movie.2021.1080p.WEBDL-GRP"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("does not grab an episode whose show's root folder is over its quota", async () => {
    const rootId = await insertRootFolder("series", 0);
    const profileId = await insertProfile();
    const showId = await insertShow("Full Disk Show", profileId);
    await db.prepare("UPDATE media_items SET root_folder_id = ? WHERE id = ?").run(rootId, showId);
    await insertEpisode(showId, 1, 2);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Full.Disk.Show.S01E02.1080p.WEBDL-GRP"));

    expect(grab).not.toHaveBeenCalled();
  });

  it("still grabs when the root folder is under its quota", async () => {
    const rootId = await insertRootFolder("movie", 100);
    const profileId = await insertProfile();
    const id = await insertMovie("Roomy Disk Movie", profileId);
    await db.prepare("UPDATE media_items SET root_folder_id = ? WHERE id = ?").run(rootId, id);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Roomy.Disk.Movie.2021.1080p.WEBDL-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).rootFolderId).toBe(rootId);
  });
});
