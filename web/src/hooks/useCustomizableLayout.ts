import { useEffect, useMemo, useState } from "react";

export interface LayoutItem {
  key: string;
  label: string;
  /** Only meaningful to callers that render a size-aware grid (the Dashboard) — ignored by
   * callers that don't (the sidebar's section list). Defaults to "full" for an item with no
   * saved size, same "missing means append/default" reasoning as order/hidden below. */
  defaultSize?: WidgetSize;
}

export type WidgetSize = "full" | "half";

/**
 * Persists a user-chosen order + hidden set + size for a list of layout sections (dashboard
 * widgets, sidebar nav groups) to localStorage, keyed by `storageKey`. An item not yet present in
 * the saved order (a widget/nav group added in a later release) is appended at the end
 * automatically rather than being silently missing until the user notices and re-adds it by hand.
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
  const [sizes, setSizes] = useState<Record<string, WidgetSize>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_sizes`) ?? "null");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem(`${storageKey}_order`, JSON.stringify(order));
  }, [storageKey, order]);
  useEffect(() => {
    localStorage.setItem(`${storageKey}_hidden`, JSON.stringify([...hidden]));
  }, [storageKey, hidden]);
  useEffect(() => {
    localStorage.setItem(`${storageKey}_sizes`, JSON.stringify(sizes));
  }, [storageKey, sizes]);

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

  function setSize(key: string, size: WidgetSize) {
    setSizes((prev) => ({ ...prev, [key]: size }));
  }

  function sizeOf(key: string): WidgetSize {
    return sizes[key] ?? itemsByKey.get(key)?.defaultSize ?? "full";
  }

  const orderedItems = orderedKeys.map((k) => itemsByKey.get(k)!).filter(Boolean);
  const visibleItems = orderedItems.filter((i) => !hidden.has(i.key));

  return { orderedItems, visibleItems, hidden, moveUp, moveDown, toggleHidden, setSize, sizeOf };
}
