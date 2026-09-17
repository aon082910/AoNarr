import { describe, it, expect } from "vitest";
import { runWithRequestId, currentRequestId, generateRequestId } from "../src/services/requestContext.js";

describe("requestContext", () => {
  it("generateRequestId produces an 8-character hex string", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("currentRequestId is undefined outside of runWithRequestId", () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it("currentRequestId returns the id set for the current async context", () => {
    runWithRequestId("abc123", () => {
      expect(currentRequestId()).toBe("abc123");
    });
  });

  it("propagates the id across an await inside the same logical request", async () => {
    await runWithRequestId("async-id", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(currentRequestId()).toBe("async-id");
    });
  });

  it("keeps two concurrent requests' ids from leaking into each other", async () => {
    const seenInA: (string | undefined)[] = [];
    const seenInB: (string | undefined)[] = [];

    await Promise.all([
      runWithRequestId("request-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seenInA.push(currentRequestId());
      }),
      runWithRequestId("request-b", async () => {
        seenInB.push(currentRequestId());
        await new Promise((resolve) => setTimeout(resolve, 10));
        seenInB.push(currentRequestId());
      }),
    ]);

    expect(seenInA).toEqual(["request-a"]);
    expect(seenInB).toEqual(["request-b", "request-b"]);
  });

  it("does not leak the id to code that runs after runWithRequestId returns", () => {
    runWithRequestId("scoped-id", () => {});
    expect(currentRequestId()).toBeUndefined();
  });
});
