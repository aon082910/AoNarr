import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Response } from "express";
import { registerQueueStreamClient, unregisterQueueStreamClient, notifyQueueChanged } from "../src/services/realtime.js";

// realtime.ts has zero runtime imports beyond `express`'s type (erased at compile time) — genuinely
// pure, so static top-level imports are safe and no setupTestDb() is needed.

function fakeClient(): Response & { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() } as unknown as Response & { write: ReturnType<typeof vi.fn> };
}

let baseTime = 1_700_000_000_000;
const registered: (Response & { write: ReturnType<typeof vi.fn> })[] = [];

function register(res: Response & { write: ReturnType<typeof vi.fn> }): void {
  registerQueueStreamClient(res);
  registered.push(res);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Module-private lastSentAt/pendingTimer persist across tests in this file — jumping the clock
  // far past MIN_INTERVAL_MS (1500ms) at the start of every test guarantees a fresh test's first
  // call always takes the immediate-broadcast branch, regardless of what the previous test left.
  baseTime += 10_000_000;
  vi.setSystemTime(baseTime);
});

afterEach(() => {
  // Flush any timer a test scheduled so the module's own `pendingTimer` resets to null inside its
  // callback — leaving it dangling would make the NEXT test's coalescing check silently no-op.
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  for (const res of registered.splice(0)) unregisterQueueStreamClient(res);
});

describe("registerQueueStreamClient / unregisterQueueStreamClient", () => {
  it("only broadcasts to currently registered clients", () => {
    const a = fakeClient();
    const b = fakeClient();
    register(a);
    register(b);

    notifyQueueChanged();

    expect(a.write).toHaveBeenCalledTimes(1);
    expect(b.write).toHaveBeenCalledTimes(1);

    unregisterQueueStreamClient(b);
    a.write.mockClear();
    b.write.mockClear();
    vi.setSystemTime(baseTime + 10_000); // clear of the cooldown window again

    notifyQueueChanged();

    expect(a.write).toHaveBeenCalledTimes(1);
    expect(b.write).not.toHaveBeenCalled();
  });
});

describe("notifyQueueChanged", () => {
  it("broadcasts immediately when nothing has been sent recently", () => {
    const client = fakeClient();
    register(client);

    notifyQueueChanged();

    expect(client.write).toHaveBeenCalledWith("event: queue\ndata: {}\n\n");
  });

  it("coalesces rapid successive calls into exactly one broadcast after the cooldown window", () => {
    const client = fakeClient();
    register(client);

    notifyQueueChanged(); // immediate — starts the cooldown window
    client.write.mockClear();

    notifyQueueChanged(); // within the window — schedules a pending broadcast, does not fire yet
    expect(client.write).not.toHaveBeenCalled();

    notifyQueueChanged(); // still within the window — must NOT schedule a second timer
    expect(client.write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500); // enough for the (single) pending timer to fire

    expect(client.write).toHaveBeenCalledTimes(1); // would be 2 if a second timer had been scheduled
  });

  it("swallows a write failure on one client without throwing or skipping the rest", () => {
    const broken = fakeClient();
    broken.write.mockImplementation(() => {
      throw new Error("write after end");
    });
    const healthy = fakeClient();
    register(broken);
    register(healthy);

    expect(() => notifyQueueChanged()).not.toThrow();
    expect(healthy.write).toHaveBeenCalledTimes(1);
  });
});
