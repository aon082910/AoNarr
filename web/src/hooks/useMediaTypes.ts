import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { MediaTypeInfo } from "../types.js";

let cache: MediaTypeInfo[] | null = null;
let inflight: Promise<MediaTypeInfo[]> | null = null;
const listeners = new Set<(types: MediaTypeInfo[]) => void>();

async function loadMediaTypes(): Promise<MediaTypeInfo[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.get<MediaTypeInfo[]>("/media-types").then((data) => {
      cache = data;
      for (const listener of listeners) listener(data);
      return data;
    }).catch((e) => {
      // Forget the failed attempt so the next caller retries instead of reusing this rejection
      // for the rest of the session.
      inflight = null;
      throw e;
    });
  }
  return inflight;
}

/** The library-type registry (label, shape, child label) — fetched once and cached module-wide. */
export function useMediaTypes(): MediaTypeInfo[] {
  const [types, setTypes] = useState<MediaTypeInfo[]>(cache ?? []);

  useEffect(() => {
    // A long-lived consumer (the app shell's sidebar) mounts once, so a failed first fetch (e.g. a
    // 502 while the server restarts) must keep retrying while it's mounted, and must also pick up
    // a success from any other instance's attempt — otherwise it stays empty until a full reload.
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const listener = (data: MediaTypeInfo[]) => setTypes(data);
    listeners.add(listener);
    const tryLoad = () => {
      loadMediaTypes()
        .then((data) => {
          if (!cancelled) setTypes(data);
        })
        .catch(() => {
          if (!cancelled) retryTimer = setTimeout(tryLoad, Math.min(30_000, 2_000 * 2 ** attempt++));
        });
    };
    tryLoad();
    return () => {
      cancelled = true;
      listeners.delete(listener);
      clearTimeout(retryTimer);
    };
  }, []);

  return types;
}
