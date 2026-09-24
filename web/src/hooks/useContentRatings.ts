import { useEffect, useState } from "react";
import { api } from "../api/client.js";

let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

async function loadContentRatings(): Promise<string[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.get<string[]>("/content-ratings").then((data) => {
      cache = data;
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

/** The combined MPAA/TV content rating order (loosest to strictest) — fetched once and cached module-wide. */
export function useContentRatings(): string[] {
  const [ratings, setRatings] = useState<string[]>(cache ?? []);

  useEffect(() => {
    let cancelled = false;
    loadContentRatings()
      .then((data) => {
        if (!cancelled) setRatings(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return ratings;
}
