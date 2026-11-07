import { describe, it, expect } from "vitest";
import { admit, afterSend, classifyGrab, inAnyWindow, inWindow, isNight, priorityFor, selectReleases, type Candidate, type ClientState } from "../src/services/throttlearr/rules.js";
import { DEFAULT_CLIENT_LIMITS, DEFAULT_SETTINGS, normalizeSettings, type ClientLimits } from "../src/services/throttlearr/settings.js";

// 2026-11-09 is a Monday (getDay() 1). Dates are built in local time, as the rules read local time.
const at = (day: number, hh: number, mm = 0) => new Date(2026, 10, 8 + day, hh, mm); // day 0 = Sunday 2026-11-08
const ALL = [0, 1, 2, 3, 4, 5, 6];
const limits = (over: Partial<ClientLimits> = {}): ClientLimits => ({ ...DEFAULT_CLIENT_LIMITS, ...over });
const state = (over: Partial<ClientState> = {}): ClientState => ({ active: 0, bytesLeft: 0, addsLastHour: 0, freeBytes: null, titleActive: new Map(), ...over });
const cand = (id: number, over: Partial<Candidate> = {}): Candidate => ({ id, mediaItemId: id, size: 1_000, priorityClass: "movie", ...over });
const P = DEFAULT_SETTINGS.priority;
const run = (cands: Candidate[], l: ClientLimits, s: ClientState, over: Record<string, unknown> = {}) =>
  selectReleases(cands, { clientName: "Seedbox", limits: l, state: s, priority: P, perTitleLimit: null, now: at(1, 12), ...over });

describe("windows", () => {
  it("a same-day window includes its start and excludes its end", () => {
    const w = { days: [1], from: "09:00", to: "17:00" };
    expect(inWindow(w, at(1, 9, 0))).toBe(true);
    expect(inWindow(w, at(1, 16, 59))).toBe(true);
    expect(inWindow(w, at(1, 17, 0))).toBe(false);
    expect(inWindow(w, at(1, 8, 59))).toBe(false);
    expect(inWindow(w, at(2, 12))).toBe(false); // Tuesday is not listed
  });

  it("a window past midnight belongs to the day it starts on", () => {
    const w = { days: [5], from: "21:00", to: "07:00" }; // Friday night
    expect(inWindow(w, at(5, 21, 0))).toBe(true); // Friday 21:00
    expect(inWindow(w, at(5, 23, 59))).toBe(true);
    expect(inWindow(w, at(6, 0, 0))).toBe(true); // Saturday 00:00
    expect(inWindow(w, at(6, 6, 59))).toBe(true);
    expect(inWindow(w, at(6, 7, 0))).toBe(false);
    expect(inWindow(w, at(6, 21, 0))).toBe(false); // Saturday evening needs Saturday listed
    expect(inWindow(w, at(5, 12, 0))).toBe(false);
    expect(inWindow(w, at(5, 6, 0))).toBe(false); // Friday morning is Thursday night's tail, not listed
  });

  it("the tail of Saturday night runs into Sunday, wrapping the week", () => {
    const w = { days: [6], from: "22:00", to: "06:00" };
    expect(inWindow(w, at(0, 3, 0))).toBe(true); // Sunday 03:00
    expect(inWindow(w, at(1, 3, 0))).toBe(false);
  });

  it("equal start and end is the whole listed day", () => {
    const w = { days: [2], from: "00:00", to: "00:00" };
    expect(inWindow(w, at(2, 0, 0))).toBe(true);
    expect(inWindow(w, at(2, 23, 59))).toBe(true);
    expect(inWindow(w, at(3, 0, 0))).toBe(false);
  });

  it("no windows means always; any matching window is enough", () => {
    expect(inAnyWindow([], at(3, 3))).toBe(true);
    const ws = [
      { days: ALL, from: "01:00", to: "02:00" },
      { days: ALL, from: "13:00", to: "14:00" },
    ];
    expect(inAnyWindow(ws, at(1, 13, 30))).toBe(true);
    expect(inAnyWindow(ws, at(1, 12, 0))).toBe(false);
  });

  it("knows the night", () => {
    expect(isNight(P, at(1, 23, 30))).toBe(true);
    expect(isNight(P, at(2, 6, 59))).toBe(true);
    expect(isNight(P, at(2, 7, 0))).toBe(false);
    expect(isNight(P, at(2, 12, 0))).toBe(false);
  });
});

describe("classifying a grab", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  it("movies first, recent episodes next, the old backlog last", () => {
    expect(classifyGrab({ type: "movie", episodeId: null, seasonNumber: null, airDate: null, now })).toBe("movie");
    expect(classifyGrab({ type: "series", episodeId: 5, seasonNumber: null, airDate: "2026-10-01", now })).toBe("recentTv");
    expect(classifyGrab({ type: "series", episodeId: 5, seasonNumber: null, airDate: "2024-01-01", now })).toBe("backlog");
    expect(classifyGrab({ type: "anime", episodeId: null, seasonNumber: 2, airDate: "2020-05-05", now })).toBe("backlog");
  });
  it("an episode with no air date is not backlog; music and books are", () => {
    expect(classifyGrab({ type: "series", episodeId: 5, seasonNumber: null, airDate: null, now })).toBe("recentTv");
    expect(classifyGrab({ type: "series", episodeId: 5, seasonNumber: null, airDate: "garbage", now })).toBe("recentTv");
    expect(classifyGrab({ type: "artist", episodeId: null, seasonNumber: null, airDate: null, now })).toBe("backlog");
  });
  it("turns a class into the stored priority", () => {
    expect(priorityFor("movie", P)).toBe(20);
    expect(priorityFor("recentTv", P)).toBe(10);
    expect(priorityFor("backlog", P)).toBe(0);
  });
});

describe("admit", () => {
  const ok = (l: ClientLimits, s: ClientState, c = cand(1), extra: Record<string, unknown> = {}) =>
    admit({ clientName: "Seedbox", limits: l, state: s, candidate: c, priority: P, perTitleLimit: null, now: at(1, 12), ...extra });

  it("passes a client with no limits", () => {
    expect(ok(limits(), state({ active: 999, bytesLeft: 9e15, addsLastHour: 9999 })).ok).toBe(true);
  });

  it("counts jobs", () => {
    expect(ok(limits({ maxActive: 3 }), state({ active: 2 })).ok).toBe(true);
    expect(ok(limits({ maxActive: 3 }), state({ active: 3 }))).toMatchObject({ ok: false, kind: "count", reason: "Seedbox has 3 of 3 jobs" });
  });

  it("limits bytes, but lets an idle client take a job over the limit", () => {
    const l = limits({ maxActive: 10, maxActiveBytes: 100e9 });
    expect(ok(l, state({ active: 2, bytesLeft: 60e9 }), cand(1, { size: 30e9 })).ok).toBe(true);
    expect(ok(l, state({ active: 2, bytesLeft: 60e9 }), cand(1, { size: 50e9 }))).toMatchObject({ ok: false, kind: "bytes" });
    expect(ok(l, state({ active: 0, bytesLeft: 0 }), cand(1, { size: 400e9 })).ok).toBe(true);
  });

  it("limits adds per hour", () => {
    const l = limits({ addsPerHour: 60 });
    expect(ok(l, state({ addsLastHour: 59 })).ok).toBe(true);
    expect(ok(l, state({ addsLastHour: 60 }))).toMatchObject({ ok: false, kind: "adds" });
  });

  it("keeps free disk above the minimum, counting what the client still has to write", () => {
    const l = limits({ minFreeBytes: 100e9 });
    expect(ok(l, state({ freeBytes: 500e9, bytesLeft: 200e9 }), cand(1, { size: 100e9 })).ok).toBe(true); // 500 - 200 - 100 = 200
    expect(ok(l, state({ freeBytes: 500e9, bytesLeft: 350e9 }), cand(1, { size: 100e9 }))).toMatchObject({ ok: false, kind: "disk" });
    expect(ok(l, state({ freeBytes: null, bytesLeft: 350e9 }), cand(1, { size: 100e9 })).ok).toBe(true); // unknown never blocks
  });

  it("waits outside the hours, and says so", () => {
    const l = limits({ windows: [{ days: ALL, from: "21:00", to: "07:00" }] });
    expect(ok(l, state(), cand(1), { now: at(1, 12) })).toMatchObject({ ok: false, kind: "window", reason: "Outside Seedbox's hours" });
    expect(ok(l, state(), cand(1), { now: at(1, 22) }).ok).toBe(true);
  });

  it("holds old episodes until the night when asked, and lets movies and recent episodes through", () => {
    const p = { ...P, backlogOnlyAtNight: true };
    const back = cand(1, { priorityClass: "backlog" });
    expect(ok(limits(), state(), back, { priority: p, now: at(1, 12) })).toMatchObject({ ok: false, kind: "night" });
    expect(ok(limits(), state(), back, { priority: p, now: at(1, 23, 30) }).ok).toBe(true);
    expect(ok(limits(), state(), cand(1, { priorityClass: "recentTv" }), { priority: p, now: at(1, 12) }).ok).toBe(true);
    expect(ok(limits(), state(), back, { priority: P, now: at(1, 12) }).ok).toBe(true); // off by default
  });

  it("gives one title only its share of the slots", () => {
    const s = state({ titleActive: new Map([[1, 2]]) });
    expect(ok(limits(), s, cand(1), { perTitleLimit: 3 }).ok).toBe(true);
    expect(ok(limits(), state({ titleActive: new Map([[1, 3]]) }), cand(1), { perTitleLimit: 3 })).toMatchObject({ ok: false, kind: "title" });
    expect(ok(limits(), state({ titleActive: new Map([[1, 3]]) }), cand(2), { perTitleLimit: 3 }).ok).toBe(true);
    expect(ok(limits(), state({ titleActive: new Map([[1, 30]]) }), cand(1), { perTitleLimit: null }).ok).toBe(true);
  });

  it("an hours rule is named before a count rule", () => {
    const l = limits({ maxActive: 1, windows: [{ days: ALL, from: "01:00", to: "02:00" }] });
    expect(ok(l, state({ active: 5 }))).toMatchObject({ kind: "window" });
  });
});

describe("selectReleases", () => {
  it("fills the free slots in the order given", () => {
    const r = run([cand(1), cand(2), cand(3), cand(4)], limits({ maxActive: 3 }), state({ active: 1 }));
    expect(r.selected.map((c) => c.id)).toEqual([1, 2]);
    expect(r.blockedBy).toMatchObject({ kind: "count" });
  });

  it("stops at the byte limit and does not skip a big job for a small one behind it", () => {
    const l = limits({ maxActive: 10, maxActiveBytes: 100e9 });
    const r = run([cand(1, { size: 40e9 }), cand(2, { size: 70e9 }), cand(3, { size: 1e9 })], l, state({ active: 1, bytesLeft: 10e9 }));
    expect(r.selected.map((c) => c.id)).toEqual([1]); // 10 + 40 = 50; the 70 GB job would make 120
    expect(r.blockedBy).toMatchObject({ kind: "bytes" });
  });

  it("counts what the pass has already added against the adds per hour", () => {
    const r = run([cand(1), cand(2), cand(3)], limits({ addsPerHour: 60 }), state({ addsLastHour: 58 }));
    expect(r.selected.map((c) => c.id)).toEqual([1, 2]);
  });

  it("skips a title that has its share and goes on to the next", () => {
    const cands = [cand(1, { mediaItemId: 7 }), cand(2, { mediaItemId: 7 }), cand(3, { mediaItemId: 7 }), cand(4, { mediaItemId: 8 })];
    const r = run(cands, limits({ maxActive: 10 }), state(), { perTitleLimit: 2 });
    expect(r.selected.map((c) => c.id)).toEqual([1, 2, 4]);
    expect(r.blockedBy).toMatchObject({ kind: "title" });
  });

  it("skips old episodes before night and goes on to the movies behind them", () => {
    const cands = [cand(1, { priorityClass: "backlog" }), cand(2, { priorityClass: "movie" })];
    const r = run(cands, limits(), state(), { priority: { ...P, backlogOnlyAtNight: true }, now: at(1, 12) });
    expect(r.selected.map((c) => c.id)).toEqual([2]);
  });

  it("selects nothing outside the hours", () => {
    const r = run([cand(1), cand(2)], limits({ windows: [{ days: ALL, from: "01:00", to: "02:00" }] }), state());
    expect(r.selected).toEqual([]);
    expect(r.blockedBy?.kind).toBe("window");
  });

  it("selects everything when nothing blocks", () => {
    const r = run([cand(1), cand(2)], limits({ maxActive: 5 }), state());
    expect(r.selected).toHaveLength(2);
    expect(r.blockedBy).toBeNull();
  });

  it("afterSend adds the job to every counter", () => {
    const s = afterSend(state({ active: 1, bytesLeft: 10, addsLastHour: 4 }), { mediaItemId: 9, size: 5 });
    expect(s).toMatchObject({ active: 2, bytesLeft: 15, addsLastHour: 5 });
    expect(s.titleActive.get(9)).toBe(1);
  });
});

describe("settings for the new rules", () => {
  it("defaults to three jobs per title and a night of 23:00-07:00", () => {
    const s = normalizeSettings({});
    expect(s.perTitleLimit).toBe(3);
    expect(s.priority).toMatchObject({ nightFrom: "23:00", nightTo: "07:00" });
  });
  it("reads 0, a negative or a non-number per-title limit as no limit, and keeps a valid one", () => {
    expect(normalizeSettings({ perTitleLimit: 0 }).perTitleLimit).toBeNull();
    expect(normalizeSettings({ perTitleLimit: "2" }).perTitleLimit).toBeNull();
    expect(normalizeSettings({ perTitleLimit: 5 }).perTitleLimit).toBe(5);
  });
  it("rejects a bad night time", () => {
    const s = normalizeSettings({ priority: { nightFrom: "25:00", nightTo: "6:00" } });
    expect(s.priority).toMatchObject({ nightFrom: "23:00", nightTo: "07:00" });
  });
});
