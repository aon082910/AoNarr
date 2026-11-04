import { describe, it, expect } from "vitest";
import { mapLimit } from "../src/services/mapLimit.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  it("returns the results in the order of the items, with at most `limit` calls at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await pause(n);
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("rejects with the first failure and starts no new calls after it", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);

    await expect(
      mapLimit(items, 3, async (n) => {
        started.push(n);
        await pause(5);
        if (n === 1) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");

    const countAtRejection = started.length;
    await pause(60);
    // The calls in flight when it failed finished on their own; nothing was started afterwards.
    expect(started.length).toBe(countAtRejection);
    expect(started.length).toBeLessThan(items.length);
  });
});
