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

  it("D6: with no preferred protocol, seeders do not rank a torrent above an NZB", async () => {
    const torrent = release({ seeders: 900 });
    const usenet = nzb();
    // Equal on every key: the first in the list stays first.
    expect((await choose([usenet, torrent]))?.result).toBe(usenet);
    expect((await choose([torrent, usenet]))?.result).toBe(torrent);
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
