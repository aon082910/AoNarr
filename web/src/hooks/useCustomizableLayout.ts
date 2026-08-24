import { useEffect, useMemo, useState } from "react";

export interface LayoutItem {
  key: string;
  label: string;
}

/**
 * Persists a user-chosen order + hidden set for a list of layout sections (dashboard widgets,
 * sidebar nav groups) to localStorage, keyed by `storageKey`. An item not yet present in the
 * saved order (a widget/nav group added in a later release) is appended at the end automatically
 * rather than being silently missing until the user notices and re-adds it by hand.
 */
export function useCustomizableLayout(storageKey: string, items: LayoutItem[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_order`) ?? "null");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_hidden`) ?? "null");
      return new Set(Array.isArray(saved) ? saved : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem(`${storageKey}_order`, JSON.stringify(order));
  }, [storageKey, order]);
  useEffect(() => {
    localStorage.setItem(`${storageKey}_hidden`, JSON.stringify([...hidden]));
  }, [storageKey, hidden]);

  const itemsByKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const orderedKeys = useMemo(() => {
    const known = order.filter((k) => itemsByKey.has(k));
    const missing = items.map((i) => i.key).filter((k) => !order.includes(k));
    return [...known, ...missing];
  }, [order, items, itemsByKey]);

  function moveUp(key: string) {
    const idx = orderedKeys.indexOf(key);
    if (idx <= 0) return;
    const next = [...orderedKeys];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setOrder(next);
  }

  function moveDown(key: string) {
    const idx = orderedKeys.indexOf(key);
    if (idx === -1 || idx >= orderedKeys.length - 1) return;
    const next = [...orderedKeys];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    setOrder(next);
  }

  function toggleHidden(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const orderedItems = orderedKeys.map((k) => itemsByKey.get(k)!).filter(Boolean);
  const visibleItems = orderedItems.filter((i) => !hidden.has(i.key));

  return { orderedItems, visibleItems, hidden, moveUp, moveDown, toggleHidden };
}
