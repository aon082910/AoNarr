import { Router } from "express";
import { Readable, pipeline } from "node:stream";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { decryptValue, encryptValue, isEncryptedValue } from "../services/encryption.js";

export const remoteInstancesRouter = Router();

/** Anyone can call the artwork relay, and each call can hold an outbound connection for up to 15s. */
export const MAX_CONCURRENT_ARTWORK_RELAYS = 16;
/** A library page asks for every poster at once, as CSS backgrounds a browser never retries, so a
 * relay over the cap waits its turn rather than being refused: up to `maxQueued` of them, within the
 * same `timeoutMs` deadline that also bounds the upstream fetch. Mutable only so tests can shrink it. */
export const artworkRelayLimits = { maxQueued: 256, timeoutMs: 15_000 };
let artworkRelaysInFlight = 0;
const artworkRelayWaiters: (() => void)[] = [];

export function queuedArtworkRelays(): number {
  return artworkRelayWaiters.length;
}

/** Resolves true once a relay slot is the caller's, or false when the wait queue is full or `signal`
 * aborts (deadline passed, client gone) first — a waiter that gives up leaves the queue. */
function acquireArtworkRelaySlot(signal: AbortSignal): Promise<boolean> {
  if (artworkRelaysInFlight < MAX_CONCURRENT_ARTWORK_RELAYS && artworkRelayWaiters.length === 0) {
    artworkRelaysInFlight++;
    return Promise.resolve(true);
  }
  if (signal.aborted || artworkRelayWaiters.length >= artworkRelayLimits.maxQueued) return Promise.resolve(false);
  return new Promise((resolve) => {
    const giveUp = () => {
      const i = artworkRelayWaiters.indexOf(grant);
      if (i !== -1) artworkRelayWaiters.splice(i, 1);
      resolve(false);
    };
    const grant = () => {
      signal.removeEventListener("abort", giveUp);
      resolve(true);
    };
    artworkRelayWaiters.push(grant);
    signal.addEventListener("abort", giveUp, { once: true });
  });
}

/** Hands the slot straight to the longest waiter, so the in-flight count never dips below the cap
 * while anyone is queued. */
function releaseArtworkRelaySlot(): void {
  const next = artworkRelayWaiters.shift();
  if (next) next();
  else artworkRelaysInFlight--;
}

/**
 * Relays a remote item's local artwork through this instance: the remote's stored URL is only known
 * to be reachable from this server (an HTTPS front end blocks an http:// remote as mixed content; a
 * Docker-internal or LAN-only hostname doesn't resolve for the browser). Public (see requireAuth)
 * and ahead of requireAdmin like the token-gated route it fronts, since an <img> can't send
 * credentials; relays raster images only, because the response is served from this instance's
 * origin. Redirects aren't followed: the remote's route never redirects, and following one would
 * let whatever answers at the stored URL point this public fetch at any other host.
 */
remoteInstancesRouter.get(
  "/:id/local-artwork/:token",
  asyncHandler(async (req, res) => {
    const { id, token } = req.params;
    if (!/^\d{1,9}$/.test(id) || !/^[\w-]+$/.test(token)) throw new HttpError(404, "No artwork found for this token");
    // A plain timer, not AbortSignal.timeout() inside AbortSignal.any(): on Node 20 the composite only
    // holds its timeout source weakly, so a garbage collection silently drops the deadline.
    const relay = new AbortController();
    let clientGone = false;
    const deadline = setTimeout(
      () => relay.abort(new DOMException("Artwork relay timed out", "TimeoutError")),
      artworkRelayLimits.timeoutMs
    );
    // The response's "close", not the request's: that one fires once the (empty) request body is
    // read, while this one fires when the client disconnects before the response is sent.
    res.once("close", () => {
      clientGone = true;
      clearTimeout(deadline);
      relay.abort();
    });
    const signal = relay.signal;
    // Looked up only once the listener above is attached: a client that leaves during the lookup has
    // already fired "close", and the relay would otherwise hold a slot until its deadline.
    const row = (await db.prepare("SELECT url FROM remote_instances WHERE id = ?").get(Number(id))) as { url: string } | undefined;
    if (clientGone) return;
    if (!row) {
      clearTimeout(deadline);
      throw new HttpError(404, "No artwork found for this token");
    }
    if (!(await acquireArtworkRelaySlot(signal))) {
      if (clientGone) return;
      res.setHeader("Retry-After", "1");
      throw new HttpError(503, "Too many artwork requests in progress — try again shortly");
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseArtworkRelaySlot();
    };
    try {
      const upstream = await fetch(`${row.url}/api/media/local-artwork/${token}`, { redirect: "manual", signal }).catch(() => null);
      const contentType = upstream?.headers.get("content-type") ?? "";
      if (!upstream?.ok || !upstream.body || !/^image\/(jpeg|png|webp|gif|avif)\b/i.test(contentType)) {
        await upstream?.body?.cancel().catch(() => {});
        throw new HttpError(404, "No artwork found for this token");
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=86400");
      pipeline(Readable.fromWeb(upstream.body as any), res, release);
    } catch (err) {
      release();
      throw err;
    }
  })
);

remoteInstancesRouter.use(requireAdmin);

function fromRow(row: any) {
  return { id: row.id, name: row.name, url: row.url, createdAt: row.created_at };
}

/** The stored API key, decrypted. A row saved before keys were encrypted at rest is re-saved
 * encrypted the first time it's used. */
async function remoteApiKey(row: { id: number; name: string; api_key: string }): Promise<string> {
  if (!isEncryptedValue(row.api_key)) {
    // Only while the row still holds the key read above: a key rotated through PATCH in the
    // meantime must not be overwritten with the old one.
    await db
      .prepare("UPDATE remote_instances SET api_key = ? WHERE id = ? AND api_key = ?")
      .run(encryptValue(row.api_key), row.id, row.api_key);
    return row.api_key;
  }
  try {
    return decryptValue(row.api_key);
  } catch {
    throw new HttpError(500, `The stored API key for "${row.name}" can't be decrypted (encryption.key changed) — re-enter it`);
  }
}

/** Local artwork is served as a root-relative /api/media/local-artwork/<token> URL, which the
 * browser would otherwise request from this instance, whose database has no such token — so it's
 * pointed at the relay route above instead. */
function withRemoteArtworkUrls(item: unknown, remote: { id: number; url: string }): unknown {
  if (!item || typeof item !== "object") return item;
  const out = { ...(item as Record<string, unknown>) };
  for (const key of ["posterUrl", "backdropUrl"]) {
    const value = out[key];
    if (typeof value !== "string") continue;
    const token = /^\/api\/media\/local-artwork\/([\w-]+)$/.exec(value)?.[1];
    if (token) out[key] = `/api/remote-instances/${remote.id}/local-artwork/${token}`;
    else if (value.startsWith("/") && !value.startsWith("//")) out[key] = `${remote.url}${value}`;
  }
  return out;
}

remoteInstancesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await db.prepare("SELECT * FROM remote_instances ORDER BY name").all();
    res.json(rows.map(fromRow));
  })
);

remoteInstancesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.url || !b.apiKey) throw new HttpError(400, "name, url and apiKey are required");
    const result = await db
      .prepare("INSERT INTO remote_instances (name, url, api_key) VALUES (?, ?, ?)")
      .run(b.name, b.url.replace(/\/+$/, ""), encryptValue(String(b.apiKey)));
    const row = await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(fromRow(row));
  })
);

remoteInstancesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const sets: string[] = [];
    const values: any[] = [];
    if (b.name !== undefined) {
      sets.push("name = ?");
      values.push(b.name);
    }
    if (b.url !== undefined) {
      sets.push("url = ?");
      values.push(String(b.url).replace(/\/+$/, ""));
    }
    if (b.apiKey) {
      sets.push("api_key = ?");
      values.push(encryptValue(String(b.apiKey)));
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      await db.prepare(`UPDATE remote_instances SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const row = await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(req.params.id);
    if (!row) throw new HttpError(404, "Remote instance not found");
    res.json(fromRow(row));
  })
);

remoteInstancesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await db.prepare("DELETE FROM remote_instances WHERE id = ?").run(req.params.id);
    if (result.changes === 0) throw new HttpError(404, "Remote instance not found");
    res.status(204).send();
  })
);

/**
 * Read-only proxy into a remote AoNarr instance's own `/media` and `/media-types` endpoints,
 * using the API key stored for it — never exposed to the browser directly, so the admin only ever
 * needs the local instance's own credentials. No write actions are proxied; this is browse-only.
 */
remoteInstancesRouter.get(
  "/:id/media",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Remote instance not found");

    const type = req.query.type as string | undefined;
    const apiKey = await remoteApiKey(row);
    try {
      // The remote's GET /api/media is paginated ({ items, total }, 60 per page by default) while
      // this proxy's caller (RemoteLibrary.tsx) expects the whole library as a bare array — walk
      // every page instead of returning only the newest 60.
      const items: unknown[] = [];
      for (;;) {
        const qs = new URLSearchParams({ limit: "500", offset: String(items.length) });
        if (type) qs.set("type", type);
        const remoteRes = await fetch(`${row.url}/api/media?${qs.toString()}`, {
          headers: { "X-Api-Key": apiKey },
          signal: AbortSignal.timeout(15_000),
        });
        if (!remoteRes.ok) throw new Error(`Remote instance returned HTTP ${remoteRes.status}`);
        const body = (await remoteRes.json()) as { items?: unknown; total?: unknown };
        if (!Array.isArray(body?.items)) {
          res.json(Array.isArray(body) ? body.map((item) => withRemoteArtworkUrls(item, row)) : body);
          return;
        }
        items.push(...body.items);
        if (body.items.length === 0 || items.length >= Number(body.total ?? 0)) break;
      }
      res.json(items.map((item) => withRemoteArtworkUrls(item, row)));
    } catch (err) {
      throw new HttpError(502, `Could not reach remote instance "${row.name}": ${(err as Error).message}`);
    }
  })
);

remoteInstancesRouter.get(
  "/:id/media-types",
  asyncHandler(async (req, res) => {
    const row = (await db.prepare("SELECT * FROM remote_instances WHERE id = ?").get(req.params.id)) as any;
    if (!row) throw new HttpError(404, "Remote instance not found");
    const apiKey = await remoteApiKey(row);

    try {
      const remoteRes = await fetch(`${row.url}/api/media-types`, {
        headers: { "X-Api-Key": apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!remoteRes.ok) throw new Error(`Remote instance returned HTTP ${remoteRes.status}`);
      const body = await remoteRes.json();
      res.json(body);
    } catch (err) {
      throw new HttpError(502, `Could not reach remote instance "${row.name}": ${(err as Error).message}`);
    }
  })
);
