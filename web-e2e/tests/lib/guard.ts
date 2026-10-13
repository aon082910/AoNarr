// GET-only guard: after login, every non-GET request to /api/** from a test page is aborted and recorded,
// so the sweep can never mutate the (throwaway) instance. A recorded attempt fails the test.
import type { BrowserContext } from "@playwright/test";
import { APP_ORIGIN } from "../../config/shared";

export interface MutationAttempt {
  method: string;
  path: string;
}

export interface GetOnlyGuard {
  attempts: MutationAttempt[];
  /** Count of GET/HEAD requests that passed through. */
  passed: number;
  dispose(): Promise<void>;
}

const SAFE = new Set(["GET", "HEAD"]);

export async function installGetOnlyGuard(context: BrowserContext, origin: string = APP_ORIGIN): Promise<GetOnlyGuard> {
  const guard: GetOnlyGuard = { attempts: [], passed: 0, dispose: async () => {} };
  const matcher = (url: URL) => url.origin === origin && url.pathname.startsWith("/api/");
  const handler = async (route: import("@playwright/test").Route) => {
    const req = route.request();
    if (SAFE.has(req.method())) {
      guard.passed++;
      await route.fallback();
      return;
    }
    const u = new URL(req.url());
    guard.attempts.push({ method: req.method(), path: u.pathname + u.search });
    await route.abort("blockedbyclient");
  };
  await context.route(matcher, handler);
  guard.dispose = async () => {
    await context.unroute(matcher, handler);
  };
  return guard;
}
