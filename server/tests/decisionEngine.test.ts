import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;
let sched: typeof import("../src/services/scheduler.js");
let ranking: typeof import("../src/services/releaseRanking.js");
let setSetting: (typeof import("../src/services/settingsStore.js"))["setSetting"];

beforeAll(async () => {
  ({ app, db, apiKey } = await setupTestDb());
  sched = await import("../src/services/scheduler.js");
  ranking = await import("../src/services/releaseRanking.js");
  ({ setSetting } = await import("../src/services/settingsStore.js"));
  const { loadQualityCaches } = await import("../src/services/quality.js");
  await loadQualityCaches();
});

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

let counter = 0;
function release(over: Record<string, unknown> = {}): any {
  counter++;
  return {
    indexerId: null,
    indexerName: "Test Indexer",
    title: `Some.Movie.2020.1080p.WEB-DL.x264-GRP${counter}`,
    size: 5_000_000_000,
    seeders: 100,
    leechers: 10,
    publishDate: ago(10_000),
    downloadUrl: `magnet:?xt=urn:btih:${counter}`,
    protocol: "torrent",
    category: null,
    ...over,
  };
}
const nzb = (over: Record<string, unknown> = {}) => release({ protocol: "usenet", seeders: null, leechers: null, downloadUrl: "https://indexer/nzb", ...over });

const ANY = ["WEBDL-720p", "WEBDL-1080p", "Bluray-1080p", "WEBDL-2160p"];
function delayProfile(over: Record<string, unknown> = {}): any {
  return {
    enableUsenet: true,
    enableTorrent: true,
    usenetDelayMinutes: 0,
    torrentDelayMinutes: 0,
    bypassIfHighestQuality: false,
    preferredProtocol: "none",
    ...over,
  };
}

function choose(results: any[], over: { allowed?: string[]; cutoff?: string; delay?: any; options?: any } = {}) {
  return sched.chooseBestResult(
    results,
    over.allowed ?? ANY,
    over.cutoff ?? "WEBDL-1080p",
    null,
    0,
    null,
    new Set(),
    "movie",
    over.delay ?? null,
    null,
    null,
    over.options ?? {}
  );
}

describe("release ranking keys", () => {
  it("buckets peers by log10, so 45 and 60 seeders tie", () => {
    expect(ranking.peerBucket(45)).toBe(ranking.peerBucket(60));
    expect(ranking.peerBucket(5)).toBeLessThan(ranking.peerBucket(500));
    expect(ranking.peerBucket(0)).toBe(0);
    expect(ranking.peerBucket(null)).toBe(0);
  });

  it("compares peers only between two torrents", () => {
    expect(ranking.comparePeers(release({ seeders: 2 }), nzb())).toBe(0);
    expect(ranking.comparePeers(nzb(), nzb())).toBe(0);
    expect(ranking.comparePeers(release({ seeders: 5 }), release({ seeders: 500 }))).toBeGreaterThan(0);
  });

  it("buckets usenet age like Sonarr: an hour, a day, a week, then by log10 of the days", () => {
    const now = Date.now();
    const bucket = (minutes: number) => ranking.usenetAgeBucket(new Date(now - minutes * MINUTE).toISOString(), now);
    expect(bucket(30)).toBe(1000);
    expect(bucket(600)).toBe(100);
    expect(bucket(3 * 1440)).toBe(10);
    expect(bucket(30 * 1440)).toBe(-1);
    expect(bucket(3000 * 1440)).toBe(-3);
    expect(ranking.usenetAgeBucket(null)).toBe(0);
  });
});

describe("chooseBestResult — which of equal releases wins (D6, D7, D17)", () => {
  it("D6: a torrent with 2 seeders no longer beats an equal NZB when usenet is preferred", async () => {
    const torrent = release({ seeders: 2 });
    const usenet = nzb();
    expect((await choose([torrent, usenet], { delay: delayProfile({ preferredProtocol: "usenet" }) }))?.result).toBe(usenet);
    expect((await choose([usenet, torrent], { delay: delayProfile({ preferredProtocol: "torrent" }) }))?.result).toBe(torrent);
  });

  it("D6: with no preferred protocol, a torrent is ranked ahead of an NZB as on main, in whatever order they arrive", async () => {
    const torrent = release({ seeders: 900 });
    const usenet = nzb();
    expect((await choose([usenet, torrent]))?.result).toBe(torrent);
    expect((await choose([torrent, usenet]))?.result).toBe(torrent);
  });

  it("the winner does not depend on the order the indexers answered in (the order is a consistent one)", async () => {
    // A beats C on peers, B beats A on size, C beats B on size: only a protocol key keeps that from looping.
    const a = release({ seeders: 1000, size: 4_000_000_000 });
    const b = nzb({ size: 6_000_000_000 });
    const c = release({ seeders: 10, size: 8_000_000_000 });
    const perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const winners = await Promise.all(perms.map(async (p) => (await choose(p))?.result));
    expect(new Set(winners).size).toBe(1);
    expect(winners[0]).toBe(a);
  });

  it("D7: indexer priority decides between the same quality on a video type, ahead of seeders", async () => {
    const privateTracker = release({ indexerId: 1, seeders: 10 });
    const publicTracker = release({ indexerId: 2, seeders: 100 });
    const options = { indexers: [{ id: 1, priority: 1 }, { id: 2, priority: 50 }] };
    expect((await choose([publicTracker, privateTracker], { options }))?.result).toBe(privateTracker);
  });

  it("D7: a preferred protocol comes before indexer priority", async () => {
    const torrentOnBestIndexer = release({ indexerId: 1 });
    const nzbOnWorseIndexer = nzb({ indexerId: 2 });
    const options = { indexers: [{ id: 1, priority: 1 }, { id: 2, priority: 50 }] };
    const best = await choose([torrentOnBestIndexer, nzbOnWorseIndexer], { delay: delayProfile({ preferredProtocol: "usenet" }), options });
    expect(best?.result).toBe(nzbOnWorseIndexer);
  });

  it("D17: 45 and 60 seeders tie, so the larger release wins", async () => {
    const small = release({ seeders: 60, size: 2_000_000_000 });
    const large = release({ seeders: 45, size: 8_000_000_000 });
    expect((await choose([small, large]))?.result).toBe(large);
  });

  it("D17: a hundredfold seeder gap still decides", async () => {
    const dead = release({ seeders: 3, size: 8_000_000_000 });
    const alive = release({ seeders: 400, size: 2_000_000_000 });
    expect((await choose([dead, alive]))?.result).toBe(alive);
  });

  it("D17: between two NZBs the fresher beats the older, and size decides at the same age", async () => {
    const old = nzb({ publishDate: ago(40 * 1440), size: 9_000_000_000 });
    const fresh = nzb({ publishDate: ago(30), size: 2_000_000_000 });
    expect((await choose([old, fresh]))?.result).toBe(fresh);
    const smallNzb = nzb({ publishDate: ago(30), size: 1_200_000_000 });
    const bigNzb = nzb({ publishDate: ago(30), size: 6_000_000_000 });
    expect((await choose([smallNzb, bigNzb]))?.result).toBe(bigNzb);
  });
});

describe("chooseBestResult — the cutoff cap (D1)", () => {
  const w1080 = () => release({ title: "Some.Movie.2020.1080p.WEB-DL.x264-AAA" });
  const w2160 = () => release({ title: "Some.Movie.2020.2160p.WEB-DL.x265-BBB" });

  it("keeps choosing at or below the cutoff by default", async () => {
    const a = w1080();
    const b = w2160();
    expect((await choose([b, a]))?.result).toBe(a);
  });

  it("picks the best allowed quality when the call turns the cap off", async () => {
    const a = w1080();
    const b = w2160();
    expect((await choose([a, b], { options: { preferCutoffQuality: false } }))?.result).toBe(b);
  });

  it("reads the flag from the quality profile row", async () => {
    const insert = async (name: string, flag: number) =>
      Number(
        (
          await db
            .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff, prefer_cutoff_quality) VALUES (?, ?, 'WEBDL-1080p', ?)")
            .run(name, JSON.stringify(ANY), flag)
        ).lastInsertRowid
      );
    const capped = await insert("Capped", 1);
    const open = await insert("Open", 0);
    const a = w1080();
    const b = w2160();
    const pick = async (profileId: number) =>
      (await sched.chooseBestResult([a, b], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie"))?.result;
    expect(await pick(capped)).toBe(a);
    expect(await pick(open)).toBe(b);
  });
});

describe("chooseBestResult — the delay profile (D8)", () => {
  const profile = (over: Record<string, unknown> = {}) => delayProfile({ torrentDelayMinutes: 120, usenetDelayMinutes: 120, ...over });
  const w720 = (minutes: number) => release({ title: "Some.Movie.2020.720p.WEB-DL.x264-AAA", publishDate: ago(minutes) });
  const w1080 = (minutes: number, over: Record<string, unknown> = {}) =>
    release({ title: "Some.Movie.2020.1080p.WEB-DL.x264-BBB", publishDate: ago(minutes), ...over });

  it("holds a release younger than the delay", async () => {
    expect(await choose([w1080(30)], { delay: profile() })).toBeNull();
  });

  it("takes every release once the oldest one on offer is past the delay (the wait is over)", async () => {
    const oldest = w720(130);
    const young = w1080(30);
    expect((await choose([oldest, young], { delay: profile() }))?.result).toBe(young);
  });

  it("does not delay the admin's own search, but still honours a switched-off protocol", async () => {
    const young = w1080(30);
    expect((await choose([young], { delay: profile(), options: { userInvoked: true } }))?.result).toBe(young);
    expect(await choose([young], { delay: profile({ enableTorrent: false }), options: { userInvoked: true } })).toBeNull();
  });

  it("bypasses the delay for a quality at or above the best the profile would grab, on the preferred protocol", async () => {
    const atCutoff = w1080(5);
    expect((await choose([atCutoff], { delay: profile({ bypassIfHighestQuality: true }) }))?.result).toBe(atCutoff);
  });

  it("compares the bypass with the best allowed quality when the profile does not cap at the cutoff", async () => {
    const options = { preferCutoffQuality: false };
    const at1080 = w1080(5);
    expect(await choose([at1080], { delay: profile({ bypassIfHighestQuality: true }), options })).toBeNull();
    const at2160 = release({ title: "Some.Movie.2020.2160p.WEB-DL.x265-CCC", publishDate: ago(5) });
    expect((await choose([at2160], { delay: profile({ bypassIfHighestQuality: true }), options }))?.result).toBe(at2160);
  });

  it("does not bypass for a release on the other protocol than the preferred one", async () => {
    const torrent = w1080(5);
    expect(await choose([torrent], { delay: profile({ bypassIfHighestQuality: true, preferredProtocol: "usenet" }) })).toBeNull();
    const usenet = nzb({ title: "Some.Movie.2020.1080p.WEB-DL.x264-DDD", publishDate: ago(5) });
    expect((await choose([usenet], { delay: profile({ bypassIfHighestQuality: true, preferredProtocol: "usenet" }) }))?.result).toBe(usenet);
  });

  it("lets a release through whose age the indexer did not report", async () => {
    const undated = w1080(0, { publishDate: null });
    expect((await choose([undated], { delay: profile() }))?.result).toBe(undated);
  });

  it("isHeldByDelay says the delay alone kept a search from grabbing", async () => {
    const young = w1080(30);
    const choosing = (remaining: any[], delay: any) => choose(remaining, { delay });
    expect(await sched.isHeldByDelay([young], "WEBDL-1080p", profile(), choosing)).toBe(true);
    expect(await sched.isHeldByDelay([], "WEBDL-1080p", profile(), choosing)).toBe(false);
  });
});

describe("chooseBestResult — can the release be fetched at all (D14)", () => {
  afterEach(() => {
    setSetting("usenetRetentionDays", "0");
    setSetting("usenetMinimumAgeMinutes", "0");
  });

  it("rejects an NZB older than the usenet retention", async () => {
    setSetting("usenetRetentionDays", "1000");
    const gone = nzb({ publishDate: ago(1500 * 1440) });
    const there = nzb({ publishDate: ago(200 * 1440) });
    expect((await choose([gone, there]))?.result).toBe(there);
    expect(await choose([gone])).toBeNull();
  });

  it("rejects an NZB younger than the usenet minimum age", async () => {
    setSetting("usenetMinimumAgeMinutes", "60");
    expect(await choose([nzb({ publishDate: ago(10) })])).toBeNull();
    const aged = nzb({ publishDate: ago(90) });
    expect((await choose([aged]))?.result).toBe(aged);
  });

  it("leaves both settings off by default", async () => {
    const ancientFresh = nzb({ publishDate: ago(5000 * 1440) });
    expect((await choose([ancientFresh]))?.result).toBe(ancientFresh);
  });

  it("rejects a torrent with fewer seeders than its indexer's minimum, but not one with none reported", async () => {
    const options = { indexers: [{ id: 7, priority: 25, minimumSeeders: 5 }] };
    const thin = release({ indexerId: 7, seeders: 2 });
    expect(await choose([thin], { options })).toBeNull();
    const unknown = release({ indexerId: 7, seeders: null });
    expect((await choose([unknown], { options }))?.result).toBe(unknown);
    const healthy = release({ indexerId: 7, seeders: 5 });
    expect((await choose([healthy], { options }))?.result).toBe(healthy);
  });
});

describe("quality profile validation (D22) and the new fields", () => {
  const post = (body: object) => request(app).post("/api/quality-profiles").set("X-Api-Key", apiKey).send(body);

  it("refuses a cutoff that is not one of the allowed qualities", async () => {
    const res = await post({ name: "Bad Cutoff", allowedQualities: ["WEBDL-720p", "WEBDL-2160p"], cutoff: "WEBDL-1080p" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cutoff/i);
  });

  it("accepts minFormatScore and preferCutoffQuality on create", async () => {
    const res = await post({ name: "Scored", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p", minFormatScore: 50, preferCutoffQuality: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ minFormatScore: 50, preferCutoffQuality: false });
    const plain = await post({ name: "Plain", allowedQualities: ["WEBDL-1080p"], cutoff: "WEBDL-1080p" });
    expect(plain.body).toMatchObject({ minFormatScore: 0, preferCutoffQuality: true });
  });

  it("judges a PATCH against the profile as it will read afterwards", async () => {
    const made = await post({ name: "Patched", allowedQualities: ["WEBDL-720p", "WEBDL-1080p"], cutoff: "WEBDL-1080p" });
    const patch = (body: object) => request(app).patch(`/api/quality-profiles/${made.body.id}`).set("X-Api-Key", apiKey).send(body);
    expect((await patch({ cutoff: "Remux-2160p" })).status).toBe(400);
    expect((await patch({ allowedQualities: ["WEBDL-720p"] })).status).toBe(400);
    expect((await patch({ allowedQualities: ["WEBDL-720p", "WEBDL-2160p"], cutoff: "WEBDL-2160p" })).status).toBe(200);
    const flag = await patch({ preferCutoffQuality: false });
    expect(flag.body.preferCutoffQuality).toBe(false);
  });
});

describe("delay profile and indexer routes carry the new fields", () => {
  it("stores a preferred protocol and refuses an unknown one", async () => {
    const bad = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ preferredProtocol: "carrier-pigeon" });
    expect(bad.status).toBe(400);
    const made = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ preferredProtocol: "usenet", torrentDelayMinutes: 30 });
    expect(made.status).toBe(201);
    expect(made.body.preferredProtocol).toBe("usenet");
    const patched = await request(app).patch(`/api/delay-profiles/${made.body.id}`).set("X-Api-Key", apiKey).send({ preferredProtocol: "torrent" });
    expect(patched.body.preferredProtocol).toBe("torrent");
    const loaded = (await sched.loadDelayProfiles()).find((p) => p.tagId === null);
    expect(loaded?.profile.preferredProtocol).toBe("torrent");
  });

  it("stores an indexer's minimum seeders", async () => {
    const bad = await request(app)
      .post("/api/indexers")
      .set("X-Api-Key", apiKey)
      .send({ name: "Seedy", protocol: "torznab", url: "https://example.test/api", minimumSeeders: -2 });
    expect(bad.status).toBe(400);
    const made = await request(app)
      .post("/api/indexers")
      .set("X-Api-Key", apiKey)
      .send({ name: "Seedy", protocol: "torznab", url: "https://example.test/api", minimumSeeders: 3 });
    expect(made.status).toBe(201);
    expect(made.body.minimumSeeders).toBe(3);
    const patched = await request(app).patch(`/api/indexers/${made.body.id}`).set("X-Api-Key", apiKey).send({ minimumSeeders: 0 });
    expect(patched.body.minimumSeeders).toBe(0);
  });
});


describe("chooseBestResult — the delay bypass by custom-format score (D8e)", () => {
  async function scoredProfile(): Promise<number> {
    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, 'WEBDL-1080p')").run(`Scored ${Math.random()}`, JSON.stringify(ANY)))
        .lastInsertRowid
    );
    const formatId = Number(
      (
        await db
          .prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)")
          .run(`Tier One ${Math.random()}`, JSON.stringify([{ type: "releaseGroup", patterns: ["^TIERONE$"], negate: false }]))
      ).lastInsertRowid
    );
    await db.prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, 500)").run(profileId, formatId);
    return profileId;
  }
  const profile = (over: Record<string, unknown> = {}) =>
    delayProfile({ torrentDelayMinutes: 120, usenetDelayMinutes: 120, bypassIfAboveFormatScore: true, minimumBypassFormatScore: 300, ...over });
  const young = (group: string) =>
    release({ title: `Some.Movie.2020.1080p.WEB-DL.x264-${group}`, publishDate: ago(10) });

  it("lets a young release through when its score reaches the bypass score", async () => {
    const profileId = await scoredProfile();
    const top = young("TIERONE");
    const best = await sched.chooseBestResult([top], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", profile());
    expect(best?.result).toBe(top);
  });

  it("holds a young release scoring under it, or any release when the bypass is off", async () => {
    const profileId = await scoredProfile();
    const plain = young("OTHER");
    expect(await sched.chooseBestResult([plain], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", profile())).toBeNull();
    const top = young("TIERONE");
    expect(await sched.chooseBestResult([top], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", profile({ bypassIfAboveFormatScore: false }))).toBeNull();
    expect(await sched.chooseBestResult([top], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", profile({ minimumBypassFormatScore: 600 }))).toBeNull();
  });

  it("stores the bypass fields through the delay profile route", async () => {
    await db.prepare("DELETE FROM delay_profiles").run();
    const made = await request(app).post("/api/delay-profiles").set("X-Api-Key", apiKey).send({ bypassIfAboveFormatScore: true, minimumBypassFormatScore: 250 });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ bypassIfAboveFormatScore: true, minimumBypassFormatScore: 250 });
    const patched = await request(app).patch(`/api/delay-profiles/${made.body.id}`).set("X-Api-Key", apiKey).send({ minimumBypassFormatScore: -50 });
    expect(patched.body.minimumBypassFormatScore).toBe(-50);
    expect((await request(app).patch(`/api/delay-profiles/${made.body.id}`).set("X-Api-Key", apiKey).send({ minimumBypassFormatScore: "abc" })).status).toBe(400);
  });
});


describe("review fixes (Round 11)", () => {
  it("an old blocklist row without a protocol still blocks the same title from another indexer", async () => {
    const { entryBlocksResult } = await import("../src/services/blocklistMatch.js");
    const legacy = { releaseTitle: "Movie.2020.1080p.WEB-DL-GRP", protocol: null, indexerId: 1, size: null, publishDate: null, infoHash: null };
    expect(entryBlocksResult(legacy, release({ title: "Movie.2020.1080p.WEB-DL-GRP", indexerId: 2 }))).toBe(true);
    const recent = { ...legacy, protocol: "torrent" };
    expect(entryBlocksResult(recent, release({ title: "Movie.2020.1080p.WEB-DL-GRP", indexerId: 2 }))).toBe(false);
  });

  it("matches the same NZB to within a couple of minutes and megabytes", async () => {
    const { entryBlocksResult } = await import("../src/services/blocklistMatch.js");
    const date = "2026-10-01T10:00:00.000Z";
    const row = { releaseTitle: "Movie.NZB", protocol: "usenet", indexerId: null, size: 4_000_000_000, publishDate: date, infoHash: null };
    expect(entryBlocksResult(row, nzb({ title: "Movie.NZB", publishDate: "2026-10-01T10:01:30.000Z" }))).toBe(true);
    expect(entryBlocksResult(row, nzb({ title: "Movie.NZB", publishDate: "2026-10-01T10:10:00.000Z" }))).toBe(false);
    const noDate = { ...row, publishDate: null };
    expect(entryBlocksResult(noDate, nzb({ title: "Movie.NZB", publishDate: null, size: 4_001_000_000 }))).toBe(true);
    expect(entryBlocksResult(noDate, nzb({ title: "Movie.NZB", publishDate: null, size: 4_100_000_000 }))).toBe(false);
  });

  const delay = (over: Record<string, unknown> = {}) => delayProfile({ torrentDelayMinutes: 120, usenetDelayMinutes: 60, ...over });

  it("an old release on a switched-off protocol does not end the wait for a fresh one", async () => {
    const oldTorrent = release({ publishDate: ago(180) });
    const freshNzb = nzb({ publishDate: ago(10) });
    expect(await choose([oldTorrent, freshNzb], { delay: delay({ enableTorrent: false }) })).toBeNull();
    expect((await choose([freshNzb], { delay: delay({ enableTorrent: false, usenetDelayMinutes: 0 }) }))?.result).toBe(freshNzb);
  });

  it("an old release that scores under the minimum does not end the wait either", async () => {
    const profileId = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, 'WEBDL-1080p')").run(`Min ${Math.random()}`, JSON.stringify(ANY)))
        .lastInsertRowid
    );
    const formatId = Number(
      (await db.prepare("INSERT INTO custom_formats (name, patterns) VALUES (?, ?)").run(`Bad ${Math.random()}`, JSON.stringify([{ type: "releaseGroup", patterns: ["^BADGRP$"], negate: false }])))
        .lastInsertRowid
    );
    await db.prepare("INSERT INTO quality_profile_format_scores (quality_profile_id, custom_format_id, score) VALUES (?, ?, -10000)").run(profileId, formatId);
    const oldBad = release({ title: "Some.Movie.2020.1080p.WEB-DL.x264-BADGRP", publishDate: ago(300) });
    const freshGood = release({ title: "Some.Movie.2020.1080p.WEB-DL.x264-GOODGRP", publishDate: ago(20) });
    expect(await sched.chooseBestResult([oldBad, freshGood], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", delay())).toBeNull();
    const oldGood = release({ title: "Some.Movie.2020.1080p.WEB-DL.x264-OLDGOOD", publishDate: ago(300) });
    // A release that can be grabbed and is past the delay ends the wait: both go through.
    const both = await sched.chooseBestResult([oldGood, freshGood], ANY, "WEBDL-1080p", profileId, 0, null, new Set(), "movie", delay());
    expect([oldGood, freshGood]).toContain(both?.result);
  });

  it("a torrent nobody seeds does not end the wait", async () => {
    const dead = release({ seeders: 0, publishDate: ago(300) });
    const fresh = release({ publishDate: ago(20) });
    // The dead one is past the delay itself (so it can still be the last resort), but it frees nothing else.
    expect((await choose([dead, fresh], { delay: delay() }))?.result).toBe(dead);
    expect(await choose([fresh], { delay: delay() })).toBeNull();
  });

  it("the quality bypass needs a cutoff on the quality ladder", async () => {
    const sd = release({ title: "Some.Movie.2020.480p.WEB-DL.x264-GRP", publishDate: ago(5) });
    const best = await choose([sd], { allowed: [], cutoff: "Renamed-1080p", delay: delay({ bypassIfHighestQuality: true }) });
    expect(best).toBeNull();
  });

  it("a profile saved with a cutoff outside its list can still have its allowed list edited", async () => {
    const id = Number(
      (await db.prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, 'WEBDL-2160p')").run(`Legacy ${Math.random()}`, JSON.stringify(["WEBDL-720p", "WEBDL-1080p"])))
        .lastInsertRowid
    );
    const patch = (body: object) => request(app).patch(`/api/quality-profiles/${id}`).set("X-Api-Key", apiKey).send(body);
    expect((await patch({ allowedQualities: ["WEBDL-1080p"] })).status).toBe(200);
    expect((await patch({ cutoff: "Remux-2160p" })).status).toBe(400);
    expect((await patch({ allowedQualities: "nope" })).status).toBe(400);
  });

  it("isHeldByDelay does not run a second decision when no release is gated by the profile", async () => {
    let calls = 0;
    const choosing = async (remaining: any[]) => {
      calls++;
      return { result: remaining[0], quality: "WEBDL-1080p" } as any;
    };
    const zero = delay({ torrentDelayMinutes: 0, usenetDelayMinutes: 0 });
    expect(await sched.isHeldByDelay([release()], "WEBDL-1080p", zero, choosing)).toBe(false);
    expect(calls).toBe(0);
  });

  it("a release on a switched-off protocol is not kept as pending", async () => {
    const kept: any[] = [];
    const choosing = async (remaining: any[], d: unknown) => (d ? null : ({ result: remaining[0], quality: "WEBDL-1080p" } as any));
    await sched.isHeldByDelay([release()], "WEBDL-1080p", delay({ enableTorrent: false }), choosing, async (r) => {
      kept.push(r);
    });
    expect(kept).toHaveLength(0);
    await sched.isHeldByDelay([release()], "WEBDL-1080p", delay(), choosing, async (r) => {
      kept.push(r);
    });
    expect(kept).toHaveLength(1);
  });
});
