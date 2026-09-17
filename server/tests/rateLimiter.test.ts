import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit, recordFailure, recordSuccess } from "../src/services/rateLimiter.js";

describe("rateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a key that's never failed", () => {
    expect(checkRateLimit("never-seen-key").allowed).toBe(true);
  });

  it("keeps allowing under the failure threshold", () => {
    const key = "under-threshold";
    for (let i = 0; i < 9; i++) recordFailure(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it("locks out after hitting the failure threshold, with a retry-after in seconds", () => {
    const key = "hits-threshold";
    for (let i = 0; i < 10; i++) recordFailure(key);
    const result = checkRateLimit(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("recordSuccess immediately clears a bucket, even one that was building toward lockout", () => {
    const key = "success-clears";
    for (let i = 0; i < 9; i++) recordFailure(key);
    recordSuccess(key);
    expect(checkRateLimit(key).allowed).toBe(true);
    // The failure count actually reset, not just still-under-lockout — a fresh set of failures
    // from here needs the full threshold again, not just one more.
    recordFailure(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it("un-locks automatically once the lockout window has fully elapsed", () => {
    const key = "lockout-expires";
    for (let i = 0; i < 10; i++) recordFailure(key);
    expect(checkRateLimit(key).allowed).toBe(false);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it("doesn't carry failures across into a new window once the window has elapsed without a lockout", () => {
    const key = "window-resets";
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(checkRateLimit(key).allowed).toBe(true); // under threshold, not locked

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    // The old failures are stale now — checkRateLimit itself should treat this as a fresh key.
    expect(checkRateLimit(key).allowed).toBe(true);

    // And a fresh recordFailure after the window starts counting from 1 again, not from 6.
    for (let i = 0; i < 9; i++) recordFailure(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it("tracks separate keys independently", () => {
    for (let i = 0; i < 10; i++) recordFailure("scope-a:1.2.3.4");
    expect(checkRateLimit("scope-a:1.2.3.4").allowed).toBe(false);
    expect(checkRateLimit("scope-b:1.2.3.4").allowed).toBe(true);
    expect(checkRateLimit("scope-a:5.6.7.8").allowed).toBe(true);
  });
});
