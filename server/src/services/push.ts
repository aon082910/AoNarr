import { log } from "./logger.js";
import webpush from "web-push";
import { db } from "../db/index.js";
import { getSetting, setSetting } from "./settingsStore.js";

let configured = false;

/** VAPID keys identify this server to push services (Chrome/Firefox/etc); generated once and
 * persisted in settings so existing browser subscriptions stay valid across restarts. */
export function ensureVapidKeys(): { publicKey: string; privateKey: string } {
  let publicKey = getSetting("vapidPublicKey");
  let privateKey = getSetting("vapidPrivateKey");
  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    setSetting("vapidPublicKey", publicKey);
    setSetting("vapidPrivateKey", privateKey);
  }
  if (!configured) {
    webpush.setVapidDetails("mailto:admin@aonarr.local", publicKey, privateKey);
    configured = true;
  }
  return { publicKey, privateKey };
}

export async function saveSubscription(endpoint: string, p256dh: string, auth: string, userId: number | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id`
    )
    .run(endpoint, p256dh, auth, userId);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

interface PushTarget {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends a push notification. Omit userId for admin/global subscriptions only (grab/import/
 * failed events — not every household member's business); pass a specific userId to target just
 * that requester's own subscriptions (request approved/rejected). */
export async function sendPush(title: string, body: string, userId?: number | null): Promise<void> {
  const targets =
    userId === undefined
      ? ((await db.prepare("SELECT * FROM push_subscriptions WHERE user_id IS NULL").all()) as PushTarget[])
      : ((await db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId)) as PushTarget[]);
  if (targets.length === 0) return;
  ensureVapidKeys();

  const payload = JSON.stringify({ title, body });
  await Promise.all(
    targets.map(async (t) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          payload
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await removeSubscription(t.endpoint);
        else log.warn("[push] send failed:", err?.message ?? err);
      }
    })
  );
}
