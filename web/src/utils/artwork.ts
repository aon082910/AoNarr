/** A ScreenScraper image comes back from search/artwork lookups as a credential-free
 * "screenscraper:https://..." reference, which only turns into a loadable (proxied local-artwork)
 * URL once the server stores it. An <img> or CSS background can't load the reference itself, so
 * callers show their no-image placeholder for it while still sending the raw value on selection. */
export function displayableImageUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith("screenscraper:")) return null;
  return url;
}
