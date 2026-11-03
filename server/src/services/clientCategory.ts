import type { DownloadClient } from "../types/index.js";

/** The category a title of `mediaType` is grabbed under: the client's per-type category, else its default. */
export function categoryForType(client: Pick<DownloadClient, "category" | "categoryByType">, mediaType: string | null | undefined): string | null {
  return (mediaType ? client.categoryByType?.[mediaType] : undefined) ?? client.category;
}

/** Every category a client may have a download of AoNarr's under: the default and each per-type one. */
export function clientCategories(client: Pick<DownloadClient, "category" | "categoryByType">): string[] {
  return [...new Set([client.category, ...Object.values(client.categoryByType ?? {})].filter((c): c is string => !!c))];
}
