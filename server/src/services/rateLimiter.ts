interface Bucket {
  failures: number;
  windowStart: number;
  lockedUntil: number | null;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

/** Simple in-memory fixed-window rate limiter for credential-checking endpoints (admin API key,
 * household login, TOTP codes) — keyed by whatever the caller wants (typically `${scope}:${ip}`).
 * Not distributed (fine for a single-process self-hosted app); resets on restart. */
export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true };

  if (bucket.lockedUntil !== null) {
    if (now < bucket.lockedUntil) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    buckets.delete(key);
    return { allowed: true };
  }

  if (now - bucket.windowStart > WINDOW_MS) {
    buckets.delete(key);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { failures: 1, windowStart: now, lockedUntil: null });
    return;
  }

  bucket.failures++;
  if (bucket.failures >= MAX_FAILURES) {
    bucket.lockedUntil = now + LOCKOUT_MS;
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** Periodic cleanup so the map doesn't grow unbounded from one-off failures that never come back. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    const expired = bucket.lockedUntil ? now > bucket.lockedUntil : now - bucket.windowStart > WINDOW_MS;
    if (expired) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();
