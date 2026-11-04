import { normalizeForMatch } from "./titleMatch.js";

/**
 * The titles a scoped Scan & Import is for, normalized once so each scanned file is matched against all of them in a
 * single pass. It answers exactly what `looseTitlesMatch(fileTitle, target.title)` answers for each target (equal, or
 * one contained in the other as whole words), without normalizing every target again for every file: a list sync that
 * adds 200 titles scanning a root of 80,000 files would otherwise normalize the targets about 16 million times.
 */
export interface ScopeTitleIndex<T> {
  /** The first target whose title loosely matches `title`, in the order the targets were given. */
  find(title: string): T | undefined;
  has(title: string): boolean;
}

export function buildScopeTitleIndex<T extends { title: string }>(targets: readonly T[]): ScopeTitleIndex<T> {
  const entries = targets
    .map((target) => {
      const normalized = normalizeForMatch(target.title);
      return { target, normalized, padded: ` ${normalized} ` };
    })
    // A title that normalizes to nothing matches nothing, as looseTitlesMatch has it.
    .filter((e) => e.normalized !== "");
  const find = (title: string): T | undefined => {
    const normalized = normalizeForMatch(title);
    if (!normalized) return undefined;
    const padded = ` ${normalized} `;
    for (const e of entries) {
      if (e.normalized === normalized || padded.includes(e.padded) || e.padded.includes(padded)) return e.target;
    }
    return undefined;
  };
  return { find, has: (title) => find(title) !== undefined };
}
