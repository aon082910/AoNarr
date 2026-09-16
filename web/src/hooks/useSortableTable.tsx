import { useState } from "react";

/**
 * Click-header-to-sort behavior for a plain `<table>` — the exact shape Activity.tsx's queue/
 * history tables already used (toggleQueueSort/sortIndicator), pulled out into a shared hook so
 * every other list page gets the same click/arrow-indicator behavior instead of each one
 * reimplementing its own sortKey/sortDir state and comparator toggle by hand.
 *
 * Usage:
 *   const { sortKey, toggleSort, sortIndicator, sortRows } = useSortableTable<Row, "title" | "size">("title");
 *   const rows = sortRows(rawRows, (a, b, key) => key === "title" ? a.title.localeCompare(b.title) : a.size - b.size);
 *   <th style={{ cursor: "pointer" }} onClick={() => toggleSort("title")}>Title{sortIndicator("title")}</th>
 */
export function useSortableTable<T, K extends string>(initialKey: K, initialDir: "asc" | "desc" = "asc") {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialDir);

  function toggleSort(key: K) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortIndicator(key: K) {
    if (sortKey !== key) return null;
    return <span style={{ marginLeft: 4, opacity: 0.7 }}>{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  function sortRows(rows: T[], compare: (a: T, b: T, key: K) => number): T[] {
    return [...rows].sort((a, b) => {
      const cmp = compare(a, b, sortKey);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  function sortableHeader(key: K, label: string) {
    return (
      <th style={{ cursor: "pointer" }} onClick={() => toggleSort(key)}>
        {label}
        {sortIndicator(key)}
      </th>
    );
  }

  return { sortKey, sortDir, toggleSort, sortIndicator, sortRows, sortableHeader };
}
