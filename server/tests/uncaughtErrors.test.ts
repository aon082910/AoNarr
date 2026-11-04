import { describe, it, expect, beforeEach } from "vitest";
import { UNCAUGHT_WARN_PER_HOUR, __resetUncaughtErrorsForTests, recordUncaughtError, uncaughtErrorStats } from "../src/services/uncaughtErrors.js";

const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  __resetUncaughtErrorsForTests();
});

describe("uncaughtErrorStats", () => {
  it("starts empty", () => {
    expect(uncaughtErrorStats(NOW)).toEqual({ total: 0, lastHour: 0, lastAt: null, lastMessage: null });
  });

  it("warns above three errors an hour", () => {
    expect(UNCAUGHT_WARN_PER_HOUR).toBe(3);
  });

  it("counts an exception and a rejection, and reports the last one's time and message", () => {
    recordUncaughtError("exception", new Error("first failure"), NOW - 5000);
    recordUncaughtError("rejection", new Error("second failure"), NOW - 1000);

    expect(uncaughtErrorStats(NOW)).toEqual({
      total: 2,
      lastHour: 2,
      lastAt: new Date(NOW - 1000).toISOString(),
      lastMessage: "second failure",
    });
  });

  it("takes the message of whatever was thrown, not only of an Error", () => {
    recordUncaughtError("rejection", "a plain string was thrown", NOW);
    expect(uncaughtErrorStats(NOW).lastMessage).toBe("a plain string was thrown");

    recordUncaughtError("rejection", 42, NOW);
    expect(uncaughtErrorStats(NOW).lastMessage).toBe("42");

    recordUncaughtError("rejection", undefined, NOW);
    expect(uncaughtErrorStats(NOW).lastMessage).toBe("undefined");

    recordUncaughtError("rejection", { code: "E_ODD" }, NOW);
    expect(uncaughtErrorStats(NOW).lastMessage).toBe("[object Object]");
  });

  it("cuts a long message to 300 characters", () => {
    recordUncaughtError("exception", new Error("x".repeat(1000)), NOW);

    expect(uncaughtErrorStats(NOW).lastMessage).toBe("x".repeat(300));
  });

  it("counts in lastHour only the errors from the last hour, and keeps them in total", () => {
    recordUncaughtError("exception", new Error("two hours ago"), NOW - 2 * HOUR_MS);
    recordUncaughtError("exception", new Error("half an hour ago"), NOW - 30 * 60 * 1000);
    recordUncaughtError("exception", new Error("just now"), NOW);

    const stats = uncaughtErrorStats(NOW);

    expect(stats.total).toBe(3);
    expect(stats.lastHour).toBe(2);
  });

  it("drops an error from lastHour once it is a full hour old, and not a moment sooner", () => {
    recordUncaughtError("exception", new Error("edge"), NOW);

    expect(uncaughtErrorStats(NOW + HOUR_MS - 1).lastHour).toBe(1);
    expect(uncaughtErrorStats(NOW + HOUR_MS).lastHour).toBe(0);
    expect(uncaughtErrorStats(NOW + HOUR_MS).total).toBe(1);
  });

  it("still reports the last error when it is older than an hour", () => {
    recordUncaughtError("exception", new Error("long ago"), NOW - 3 * HOUR_MS);

    expect(uncaughtErrorStats(NOW)).toEqual({ total: 1, lastHour: 0, lastAt: new Date(NOW - 3 * HOUR_MS).toISOString(), lastMessage: "long ago" });
  });

  it("keeps counting past the 200 errors it remembers, and does not grow without limit", () => {
    for (let i = 0; i < 250; i++) recordUncaughtError("rejection", new Error(`failure ${i}`), NOW);

    const stats = uncaughtErrorStats(NOW);

    expect(stats.total).toBe(250);
    expect(stats.lastHour).toBe(200);
    expect(stats.lastMessage).toBe("failure 249");
  });

  it("uses the current time when none is given", () => {
    const before = Date.now();
    recordUncaughtError("exception", new Error("now"));
    const stats = uncaughtErrorStats();

    expect(stats.lastHour).toBe(1);
    expect(Date.parse(stats.lastAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stats.lastAt!)).toBeLessThanOrEqual(Date.now());
  });

  it("is emptied by the test reset", () => {
    recordUncaughtError("exception", new Error("gone soon"), NOW);

    __resetUncaughtErrorsForTests();

    expect(uncaughtErrorStats(NOW)).toEqual({ total: 0, lastHour: 0, lastAt: null, lastMessage: null });
  });
});
