import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { MediaTypeInfo } from "../types.js";

let cache: MediaTypeInfo[] | null = null;
let inflight: Promise<MediaTypeInfo[]> | null = null;

async function loadMediaTypes(): Promise<MediaTypeInfo[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.get<MediaTypeInfo[]>("/media-types").then((data) => {
      cache = data;
      return data;
    });
  }
  return inflight;
}

/** The library-type registry (label, shape, child label) — fetched once and cached module-wide. */
export function useMediaTypes(): MediaTypeInfo[] {
  const [types, setTypes] = useState<MediaTypeInfo[]>(cache ?? []);

  useEffect(() => {
    let cancelled = false;
    loadMediaTypes().then((data) => {
      if (!cancelled) setTypes(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return types;
}
