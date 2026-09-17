import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestDb } from "./helpers/testDb.js";

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: "generated-public-key", privateKey: "generated-private-key" })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => {}),
  },
}));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let webpush: any;

beforeAll(async () => {
  ({ db } = await setupTestDb());
  webpush = (await import("web-push")).default;
});

afterEach(() => {
  vi.clearAllMocks();
  // A couple of tests below install a custom mockImplementation on sendNotification;
  // clearAllMocks() resets call history but not implementations, so restore the default
  // (always-succeeds) behavior explicitly rather than letting it leak into later tests.
  webpush.sendNotification.mockImplementation(async () => {});
});

async function insertSubscription(endpoint: string, userId: number | null): Promise<void> {
  const { saveSubscription } = await import("../src/services/push.js");
  await saveSubscription(endpoint, "p256dh-value", "auth-value", userId);
}

async function insertUser(username: string): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'scrypt$x$y', 'user')").run(username)).lastInsertRowid
  );
}

describe("ensureVapidKeys", () => {
  it("generates and persists VAPID keys the first time none exist", async () => {
    const { getSetting, deleteSetting } = await import("../src/services/settingsStore.js");
    deleteSetting("vapidPublicKey");
    deleteSetting("vapidPrivateKey");
    const { ensureVapidKeys } = await import("../src/services/push.js");

    const keys = ensureVapidKeys();

    expect(keys.publicKey).toBe("generated-public-key");
    expect(getSetting("vapidPublicKey")).toBe("generated-public-key");
    expect(getSetting("vapidPrivateKey")).toBe("generated-private-key");
  });

  it("reuses already-persisted keys instead of generating new ones", async () => {
    const { setSetting } = await import("../src/services/settingsStore.js");
    setSetting("vapidPublicKey", "existing-public-key");
    setSetting("vapidPrivateKey", "existing-private-key");
    const { ensureVapidKeys } = await import("../src/services/push.js");

    const keys = ensureVapidKeys();

    expect(keys).toEqual({ publicKey: "existing-public-key", privateKey: "existing-private-key" });
    expect(webpush.generateVAPIDKeys).not.toHaveBeenCalled();
  });
});

describe("saveSubscription / removeSubscription", () => {
  it("saves a new subscription and updates it in place on a repeated save (upsert by endpoint)", async () => {
    const { saveSubscription } = await import("../src/services/push.js");
    await saveSubscription("https://push.example.com/unique-endpoint-1", "p1", "a1", null);
    await saveSubscription("https://push.example.com/unique-endpoint-1", "p2", "a2", null);

    const rows = (await db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").all("https://push.example.com/unique-endpoint-1")) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe("p2");
    expect(rows[0].auth).toBe("a2");
  });

  it("removes a subscription by endpoint", async () => {
    const { saveSubscription, removeSubscription } = await import("../src/services/push.js");
    await saveSubscription("https://push.example.com/to-be-removed", "p", "a", null);

    await removeSubscription("https://push.example.com/to-be-removed");

    expect(await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get("https://push.example.com/to-be-removed")).toBeUndefined();
  });
});

describe("sendPush", () => {
  it("does nothing when there are no matching subscriptions", async () => {
    const { sendPush } = await import("../src/services/push.js");
    await sendPush("Title", "Body", 999999);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("sends to every global (user_id IS NULL) subscription when no userId is given", async () => {
    const { sendPush } = await import("../src/services/push.js");
    // The suite's shared-DB-per-file convention means an earlier test's global subscription
    // (e.g. saveSubscription's own upsert test) can still be present here — assert that these two
    // specific endpoints were reached, not an exact total call count.
    await insertSubscription("https://push.example.com/global-1", null);
    await insertSubscription("https://push.example.com/global-2", null);

    await sendPush("Global Title", "Global Body");

    const calledEndpoints = webpush.sendNotification.mock.calls.map((c: any[]) => c[0].endpoint);
    expect(calledEndpoints).toContain("https://push.example.com/global-1");
    expect(calledEndpoints).toContain("https://push.example.com/global-2");
    const callForGlobal1 = webpush.sendNotification.mock.calls.find((c: any[]) => c[0].endpoint === "https://push.example.com/global-1")!;
    expect(JSON.parse(callForGlobal1[1])).toEqual({ title: "Global Title", body: "Global Body" });
  });

  it("sends only to the specified user's own subscriptions, not global ones", async () => {
    const { sendPush } = await import("../src/services/push.js");
    const userId = await insertUser("push-target-user");
    await insertSubscription("https://push.example.com/user-specific", userId);
    await insertSubscription("https://push.example.com/unrelated-global", null);

    await sendPush("User Title", "User Body", userId);

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [target] = webpush.sendNotification.mock.calls[0] as any[];
    expect(target.endpoint).toBe("https://push.example.com/user-specific");
  });

  it("removes a subscription that reports 410 Gone", async () => {
    const { sendPush } = await import("../src/services/push.js");
    await insertSubscription("https://push.example.com/gone-endpoint", null);
    // sendPush fires Promise.all across every global target, an accumulating and unordered set in
    // this shared-DB file — mockRejectedValueOnce would reject whichever call happens to land
    // first, not necessarily this endpoint's. Keying the rejection off the endpoint itself makes
    // this deterministic regardless of how many other global subscriptions exist by this point.
    webpush.sendNotification.mockImplementation(async (sub: any) => {
      if (sub.endpoint === "https://push.example.com/gone-endpoint") throw Object.assign(new Error("gone"), { statusCode: 410 });
    });

    await sendPush("Title", "Body");

    expect(await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get("https://push.example.com/gone-endpoint")).toBeUndefined();
  });

  it("keeps a subscription whose send failed for a reason other than 404/410", async () => {
    const { sendPush } = await import("../src/services/push.js");
    await insertSubscription("https://push.example.com/transient-failure", null);
    webpush.sendNotification.mockImplementation(async (sub: any) => {
      if (sub.endpoint === "https://push.example.com/transient-failure") throw Object.assign(new Error("server error"), { statusCode: 500 });
    });

    await expect(sendPush("Title", "Body")).resolves.not.toThrow();

    expect(await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get("https://push.example.com/transient-failure")).toBeDefined();
  });
});
