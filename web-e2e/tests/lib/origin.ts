import { APP_ORIGIN } from "../../config/shared";

/**
 * Host-level loopback stalls: every few minutes of a sweep, ALL new TCP connections to 127.0.0.1 (the app origin and the container's
 * published port alike, curl included) hang for 1-5 minutes and then recover (see the README, "Environment stalls"). A test that
 * starts inside a stall would burn its budget on a navigation that cannot succeed, so each test first waits (bounded: 20 min) until
 * the app origin answers a tiny request, and its timeout is extended by the time it waited. The wait is attached to the test.
 */
export async function waitForAppOrigin(origin: string = APP_ORIGIN, maxMs = 20 * 60_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return Date.now() - started;
    } catch {
      // not answering yet
    }
    if (Date.now() - started > maxMs) throw new Error(`app origin ${origin} did not answer for ${Math.round(maxMs / 1000)} s`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
