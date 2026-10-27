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

describe("handleAnnounce — alternate titles and library-wide resolution (Round 3)", () => {
  // handleAnnounce returns before any matching when no client is enabled, so every negative
  // assertion below would pass vacuously without one; don't lean on an earlier describe's insert.
  beforeAll(async () => {
    const clients = (await db.prepare("SELECT COUNT(*) AS n FROM download_clients WHERE enabled = 1").get()) as { n: number | string };
    if (Number(clients.n) === 0) await insertTorrentClient();
  });

  async function addAlias(itemId: number, title: string, source = "user"): Promise<void> {
    const { storeAliases } = await import("../src/services/releaseAliases.js");
    await storeAliases(itemId, [title], source as any);
  }

  it("grabs an episode announced under one of the show's alternate titles", async () => {
    const profileId = await insertProfile();
    const showId = await insertShow("Attack on Titan", profileId, 2013);
    const episodeId = await insertEpisode(showId, 4, 1);
    await addAlias(showId, "Shingeki no Kyojin", "anilist_synonym");
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Shingeki.no.Kyojin.S04E01.1080p.WEBDL-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(showId);
    expect(grab.mock.calls[0][2]).toBe(episodeId);
  });

  it("grabs a movie announced under its alternate title, and not without the alias", async () => {
    const profileId = await insertProfile();
    const id = await insertMovie("The Fall Guy", profileId, 2024);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Kaskader.2024.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();

    await addAlias(id, "Kaskader", "tmdb_alt");
    await handleAnnounce(FEED, announceText("Kaskader.2024.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });

  it("grabs nothing when two monitored items both claim the announce", async () => {
    const profileId = await insertProfile();
    await insertMovie("Ambiguous Twin", profileId, 2019);
    await insertMovie("Ambiguous Twin", profileId, 2021);
    grab.mockClear();

    // 2020 is within a year of both: neither is singled out.
    await handleAnnounce(FEED, announceText("Ambiguous.Twin.2020.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();

    // Two shows with the same alias are just as ambiguous.
    const showA = await insertShow("Alias Clash A", profileId, 2010);
    const showB = await insertShow("Alias Clash B", profileId, 2012);
    await insertEpisode(showA, 1, 1);
    await insertEpisode(showB, 1, 1);
    await addAlias(showA, "Clashing Name");
    await addAlias(showB, "Clashing Name");
    await handleAnnounce(FEED, announceText("Clashing.Name.S01E01.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();
  });

  it("keeps the year guard for a year written after the quality words", async () => {
    const profileId = await insertProfile();
    const id = await insertMovie("Dune", profileId, 1984);
    grab.mockClear();

    // No title year before the quality words, so the gate's own year check sees nothing; the
    // first year anywhere in the name (2021) is still more than a year off the item's 1984.
    await handleAnnounce(FEED, announceText("Dune.1080p.WEBDL.x264.2021-GRP"));
    expect(grab).not.toHaveBeenCalled();

    // The same shape carrying the right year is the control: the guard, not something else, declined.
    await handleAnnounce(FEED, announceText("Dune.1080p.WEBDL.x264.1984-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });

  it("ignores an announce whose name is only a hash", async () => {
    const profileId = await insertProfile();
    await insertMovie("a1b2c3d4e5f67890abcdef1234567890", profileId, 2020);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("a1b2c3d4e5f67890abcdef1234567890"));
    expect(grab).not.toHaveBeenCalled();
  });

  it("does not take an episode-shaped announce for a movie of the same title", async () => {
    const profileId = await insertProfile();
    const movieId = await insertMovie("Twin Title Story", profileId, 2010);
    grab.mockClear();

    // Only the film is wanted: an S01E01 release is no film, so nothing is grabbed.
    await handleAnnounce(FEED, announceText("Twin.Title.Story.S01E01.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();

    // With the series wanted too, the announce goes to the series' episode, not the film.
    const showId = await insertShow("Twin Title Story", profileId, 2010);
    const episodeId = await insertEpisode(showId, 1, 1);
    await handleAnnounce(FEED, announceText("Twin.Title.Story.S01E01.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(showId);
    expect(grab.mock.calls[0][2]).toBe(episodeId);
    expect(movieId).not.toBe(showId);
  });

  it("does not let a containment type's item title match a longer release title", async () => {
    const profileId = await insertProfile();
    const id = Number(
      (
        await db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id) VALUES ('ppv', 'UFC 300', 'ufc 300', 1, 0, 'unknown', ?)`
          )
          .run(profileId)
      ).lastInsertRowid
    );
    grab.mockClear();

    // The type's gate is at its default (log), so the old equality match applies, not containment.
    await handleAnnounce(FEED, announceText("UFC.300.Prelims.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();

    await handleAnnounce(FEED, announceText("UFC.300.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(id);
  });
});

describe("handleAnnounce — releases that can never import (matching Round 7)", () => {
  it("does not grab a cam copy as a WEB-DL, nor a raw disc image as a Blu-ray encode", async () => {
    const profileId = await insertProfile({ allowedQualities: ["WEBDL-1080p", "Bluray-1080p"] });
    await insertMovie("Round Seven Movie", profileId, 2024);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Round.Seven.Movie.2024.1080p.HQCAM.x264-GRP"));
    await handleAnnounce(FEED, announceText("Round.Seven.Movie.2024.1080p.Blu-ray.AVC.DTS-HD.MA.5.1-GRP"));
    await handleAnnounce(FEED, announceText("Round.Seven.Movie.2024.1080p.BD-50"));
    expect(grab).not.toHaveBeenCalled();

    await handleAnnounce(FEED, announceText("Round.Seven.Movie.2024.1080p.BluRay.x264-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
  });

  it("does not grab a film with burned-in subtitles, unless the rule is switched off", async () => {
    const profileId = await insertProfile();
    await insertMovie("Subbed Movie", profileId, 2021);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Subbed.Movie.2021.1080p.WEB-DL.HC.x264-GRP"));
    expect(grab).not.toHaveBeenCalled();

    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("rejectHardcodedSubs", "0");
    try {
      await handleAnnounce(FEED, announceText("Subbed.Movie.2021.1080p.WEB-DL.HC.x264-GRP", "https://example.com/dl/2"));
      expect(grab).toHaveBeenCalledTimes(1);
    } finally {
      setSetting("rejectHardcodedSubs", "");
    }
  });

  it("takes an episode written S01.Ep06 for that episode only", async () => {
    const profileId = await insertProfile();
    const showId = await insertShow("Ep Form Show", profileId);
    const six = await insertEpisode(showId, 1, 6);
    await insertEpisode(showId, 1, 7);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Ep.Form.Show.S01.Ep06.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][2]).toBe(six);
  });
});

describe("handleAnnounce — which show an announce names (matching Round 8)", () => {
  async function setOrigin(itemId: number, country: string[]): Promise<void> {
    await db.prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ?").run(JSON.stringify({ originCountry: country }), itemId);
  }

  it("does not take a spin-off for the show the announce names: FBI.S06E05 is not FBI: Most Wanted", async () => {
    const profileId = await insertProfile();
    const showId = await insertShow("FBI: Most Wanted", profileId, 2020);
    await insertEpisode(showId, 6, 5);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("FBI.S06E05.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();

    // The show's full name, or an alias for the short one, does.
    await handleAnnounce(FEED, announceText("FBI.Most.Wanted.S06E05.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
  });

  it("grabs for NCIS when its spin-offs are wanted too, instead of calling the announce ambiguous", async () => {
    const profileId = await insertProfile();
    const ncis = await insertShow("NCIS", profileId, 2003);
    const la = await insertShow("NCIS: Los Angeles", profileId, 2009);
    const ep = await insertEpisode(ncis, 20, 5);
    await insertEpisode(la, 20, 5);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("NCIS.S20E05.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect((grab.mock.calls[0][1] as any).id).toBe(ncis);
    expect(grab.mock.calls[0][2]).toBe(ep);
  });

  it("gives a bare title to the older of two shows that share it, and a year to the one that has it", async () => {
    const profileId = await insertProfile();
    const original = await insertShow("Round Eight Charmed", profileId, 1998);
    const reboot = await insertShow("Round Eight Charmed", profileId, 2018);
    const originalEpisode = await insertEpisode(original, 1, 1);
    const rebootEpisode = await insertEpisode(reboot, 1, 1);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Round.Eight.Charmed.S01E01.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][2]).toBe(originalEpisode);

    grab.mockClear();
    await db.prepare("UPDATE episodes SET has_file = 1 WHERE id = ?").run(originalEpisode);
    await handleAnnounce(FEED, announceText("Round.Eight.Charmed.2018.S01E01.1080p.WEBDL-GRP", "https://example.com/dl/2"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][2]).toBe(rebootEpisode);
  });

  it("takes a region tag for the show made there, not for the other country's show of the same title", async () => {
    const profileId = await insertProfile();
    const uk = await insertShow("Round Eight Offices", profileId, 2001);
    const us = await insertShow("Round Eight Offices", profileId, 2005);
    await insertEpisode(uk, 1, 1);
    const usEpisode = await insertEpisode(us, 1, 1);
    await setOrigin(uk, ["GB"]);
    await setOrigin(us, ["US"]);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Round.Eight.Offices.US.S01E01.1080p.WEBDL-GRP"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][2]).toBe(usEpisode);
  });

  it("does not take the other country's tag when only that country's show of the title is wanted", async () => {
    const profileId = await insertProfile();
    const uk = await insertShow("Round Eight Ghosts", profileId, 2019);
    await insertEpisode(uk, 1, 1);
    await setOrigin(uk, ["GB"]);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Round.Eight.Ghosts.US.S01E01.1080p.WEBDL-GRP"));
    expect(grab).not.toHaveBeenCalled();
    await handleAnnounce(FEED, announceText("Round.Eight.Ghosts.UK.S01E01.1080p.WEBDL-GRP", "https://example.com/dl/3"));
    expect(grab).toHaveBeenCalledTimes(1);
  });
});


describe("handleAnnounce — Round 11 decisions", () => {
  it("does not grab a film that is not out yet by its minimum availability (D19)", async () => {
    await insertTorrentClient();
    const profileId = await insertProfile();
    const id = await insertMovie("Leaked Future Movie", profileId, 2031);
    await db.prepare("UPDATE media_items SET minimum_availability = 'inCinemas', release_date = '2031-06-01' WHERE id = ?").run(id);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Leaked Future Movie 2031 1080p WEBDL"));
    expect(grab).not.toHaveBeenCalled();

    await db.prepare("UPDATE media_items SET release_date = '2001-06-01' WHERE id = ?").run(id);
    await handleAnnounce(FEED, announceText("Leaked Future Movie 2031 1080p WEBDL"));
    expect(grab).toHaveBeenCalledTimes(1);
  });

  it("a usenet blocklist entry does not block the same name announced as a torrent (D13)", async () => {
    await insertTorrentClient();
    const profileId = await insertProfile();
    const id = await insertMovie("Protocol Scoped Movie", profileId, 2021);
    const title = "Protocol Scoped Movie 2021 1080p WEBDL";
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title, protocol) VALUES (?, ?, 'usenet')").run(id, title);
    grab.mockClear();

    await handleAnnounce(FEED, announceText(title));
    expect(grab).toHaveBeenCalledTimes(1);

    await db.prepare("DELETE FROM blocklist WHERE media_item_id = ?").run(id);
    await db.prepare("INSERT INTO blocklist (media_item_id, release_title, protocol) VALUES (?, ?, 'torrent')").run(id, title);
    grab.mockClear();
    await handleAnnounce(FEED, announceText(title));
    expect(grab).not.toHaveBeenCalled();
  });
});


describe("handleAnnounce — episodes named by absolute number, air date or the whole season (Round 12, I13)", () => {
  async function insertTyped(type: string, title: string, seriesType: string | null = null): Promise<number> {
    const profileId = await insertProfile();
    return Number(
      (
        await db
          .prepare(
            "INSERT INTO media_items (type, title, sort_title, monitored, has_file, status, quality_profile_id, series_type) VALUES (?, ?, ?, 1, 0, 'unknown', ?, ?)"
          )
          .run(type, title, title.toLowerCase(), profileId, seriesType)
      ).lastInsertRowid
    );
  }
  async function episode(showId: number, season: number, n: number, airDate: string | null = null): Promise<number> {
    return Number(
      (
        await db
          .prepare("INSERT INTO episodes (media_item_id, season_number, episode_number, air_date, monitored, has_file) VALUES (?, ?, ?, ?, 1, 0)")
          .run(showId, season, n, airDate)
      ).lastInsertRowid
    );
  }

  it("grabs the episode a fansub announce names by its absolute number", async () => {
    await insertTorrentClient();
    const showId = await insertTyped("anime", "Announce Anime Show");
    const ids = [await episode(showId, 1, 1), await episode(showId, 1, 2), await episode(showId, 1, 3)];
    grab.mockClear();

    await handleAnnounce(FEED, announceText("[SubsPlease] Announce Anime Show - 03 (1080p)"));

    expect(grab).toHaveBeenCalledTimes(1);
    const [, , episodeId] = grab.mock.calls[0];
    expect(episodeId).toBe(ids[2]);
  });

  it("grabs a daily show's episode by the date in the release name", async () => {
    await insertTorrentClient();
    const showId = await insertTyped("series", "Announce Late Show", "daily");
    await episode(showId, 2024, 120, "2024-08-24");
    const target = await episode(showId, 2024, 121, "2024-08-25");
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Announce Late Show 2024 08 25 1080p WEB-DL-GRP"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][2]).toBe(target);
  });

  it("grabs a pack of a finished season, and refuses one whose season has not finished airing", async () => {
    await insertTorrentClient();
    const done = await insertTyped("series", "Announce Pack Show");
    for (let n = 1; n <= 4; n++) await episode(done, 1, n, "2020-01-0" + n);
    grab.mockClear();
    await handleAnnounce(FEED, announceText("Announce Pack Show S01 1080p WEB-DL-GRP"));
    // (The mocked grab queues nothing, so every episode of the season is offered it.)
    expect(grab).toHaveBeenCalled();

    const airing = await insertTyped("series", "Announce Airing Show");
    for (let n = 1; n <= 4; n++) await episode(airing, 1, n, n <= 2 ? "2020-01-0" + n : "2999-01-0" + n);
    grab.mockClear();
    await handleAnnounce(FEED, announceText("Announce Airing Show S01 1080p WEB-DL-GRP"));
    expect(grab).not.toHaveBeenCalled();
  });
});

describe("handleAnnounce — albums, books and comics (N29)", () => {
  async function insertCollection(type: string, title: string): Promise<number> {
    return Number(
      (
        await db
          .prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES (?, ?, ?, 1, 0, 'unknown')")
          .run(type, title, title.toLowerCase())
      ).lastInsertRowid
    );
  }
  async function insertSub(itemId: number, title: string, releaseDate: string | null = null): Promise<number> {
    return Number(
      (await db.prepare("INSERT INTO sub_items (media_item_id, title, release_date, monitored, has_file) VALUES (?, ?, ?, 1, 0)").run(itemId, title, releaseDate)).lastInsertRowid
    );
  }

  it("grabs a wanted album that the announce names, and no other album of the artist", async () => {
    await insertTorrentClient();
    const artist = await insertCollection("artist", "Announce Band");
    await insertSub(artist, "First Record");
    const wanted = await insertSub(artist, "Second Record");
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Announce Band - Second Record (2019) [FLAC]"));

    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][3]).toBe(wanted);
  });

  it("refuses another artist's album of the same name, a live album, and an album not out yet", async () => {
    await insertTorrentClient();
    const artist = await insertCollection("artist", "Announce Duo");
    await insertSub(artist, "Hits");
    await insertSub(artist, "Future Record", "2999-01-01");
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Some Other Band - Hits (2001) [FLAC]"));
    await handleAnnounce(FEED, announceText("Announce Duo - Hits Live (2005) [FLAC]"));
    await handleAnnounce(FEED, announceText("Announce Duo - Future Record [FLAC]"));
    expect(grab).not.toHaveBeenCalled();
  });

  it("grabs a comic issue by its number, and a book by its title", async () => {
    await insertTorrentClient();
    const series = await insertCollection("comic", "Announce Saga");
    await insertSub(series, "#11 - Chapter Eleven");
    const issue = await insertSub(series, "#12 - Chapter Twelve");
    grab.mockClear();
    await handleAnnounce(FEED, announceText("Announce Saga 012 (2013) (Digital)"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][3]).toBe(issue);

    const author = await insertCollection("author", "Announce Writer");
    const book = await insertSub(author, "The Wanted Book");
    await insertSub(author, "The Wanted Book Two");
    grab.mockClear();
    await handleAnnounce(FEED, announceText("Announce Writer - The Wanted Book (2020) [EPUB]"));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab.mock.calls[0][3]).toBe(book);
  });
});

describe("handleAnnounce — upgrades of a file already on disk", () => {
  async function movieWithFile(title: string, quality: string, releaseTitle: string): Promise<number> {
    const profile = Number(
      (
        await db
          .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, 'Bluray-1080p')")
          .run(`Upg-${Math.random()}`, JSON.stringify(["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p"]))
      ).lastInsertRowid
    );
    const id = await insertMovie(title, profile, 2020);
    await db.prepare("UPDATE media_items SET has_file = 1, quality = ?, file_release_title = ? WHERE id = ?").run(quality, releaseTitle, id);
    return id;
  }

  it("grabs a better quality for a file below the cutoff when auto-upgrade is on, and nothing when it is off", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    await insertTorrentClient();
    await movieWithFile("Announce Upgrade Movie", "WEBDL-1080p", "Announce.Upgrade.Movie.2020.1080p.WEB-DL-GRPA");
    grab.mockClear();
    setSetting("autoUpgradeEnabled", "0");
    await handleAnnounce(FEED, announceText("Announce Upgrade Movie 2020 1080p BluRay x264-GRPB"));
    expect(grab).not.toHaveBeenCalled();

    setSetting("autoUpgradeEnabled", "1");
    try {
      await handleAnnounce(FEED, announceText("Announce Upgrade Movie 2020 720p WEB-DL x264-GRPB"));
      expect(grab).not.toHaveBeenCalled(); // not better than the file
      await handleAnnounce(FEED, announceText("Announce Upgrade Movie 2020 1080p BluRay x264-GRPB"));
      expect(grab).toHaveBeenCalledTimes(1);
    } finally {
      setSetting("autoUpgradeEnabled", "0");
    }
  });

  it("does not replace a file that already meets the cutoff", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    await insertTorrentClient();
    await movieWithFile("Announce Done Movie", "Bluray-1080p", "Announce.Done.Movie.2020.1080p.BluRay-GRPA");
    grab.mockClear();
    setSetting("autoUpgradeEnabled", "1");
    try {
      await handleAnnounce(FEED, announceText("Announce Done Movie 2020 1080p BluRay x264-GRPB"));
      expect(grab).not.toHaveBeenCalled();
    } finally {
      setSetting("autoUpgradeEnabled", "0");
    }
  });
});

describe("handleAnnounce — a plain album before its edition (N26)", () => {
  it("grabs the plain album when both it and a deluxe edition of it are wanted", async () => {
    await insertTorrentClient();
    const artist = Number(
      (await db.prepare("INSERT INTO media_items (type, title, sort_title, monitored, has_file, status) VALUES ('artist','Edition Band','edition band',1,0,'unknown')").run())
        .lastInsertRowid
    );
    // The edition has the lower id; the plain album is the one to take.
    await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Rumours - Deluxe Edition', 1, 0)").run(artist);
    const plain = Number((await db.prepare("INSERT INTO sub_items (media_item_id, title, monitored, has_file) VALUES (?, 'Rumours', 1, 0)").run(artist)).lastInsertRowid);
    grab.mockClear();

    await handleAnnounce(FEED, announceText("Edition Band - Rumours (1977) [FLAC]"));

    expect(grab.mock.calls[0][3]).toBe(plain);
  });
});
