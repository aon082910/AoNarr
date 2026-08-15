const STORAGE_KEY = "aonarr_recent_searches";
const MAX_ENTRIES = 8;

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Most-recent-first, deduplicated (a repeated search moves back to the front instead of adding
 * a second entry), capped at MAX_ENTRIES. Per-browser via localStorage, not synced across devices
 * or accounts — a household's shared browser just accumulates one combined list, which is fine
 * for a "quick re-run" convenience feature. */
export function addRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  const existing = getRecentSearches().filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...existing].slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function clearRecentSearches(): void {
  localStorage.removeItem(STORAGE_KEY);
}
