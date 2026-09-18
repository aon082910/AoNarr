import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { SearchIcon } from "../components/NavIcons.js";
import { ArrowRightIcon } from "../components/ActionIcons.js";
import { notify } from "../utils/notify.js";

interface CutoffUnmetRow {
  mediaItemId: number;
  mediaTitle: string;
  type: string | null;
  episodeId: number | null;
  subItemId: number | null;
  label: string;
  currentQuality: string;
  cutoff: string;
  profileName: string;
}

function rowKey(r: CutoffUnmetRow): string {
  return `${r.mediaItemId}:${r.episodeId ?? ""}:${r.subItemId ?? ""}`;
}

function toTarget(r: CutoffUnmetRow) {
  return { mediaItemId: r.mediaItemId, episodeId: r.episodeId, subItemId: r.subItemId };
}

/** Radarr/Sonarr-style "Cutoff Unmet" page — everything already downloaded whose current quality
 * still ranks below its own quality profile's cutoff, with the same per-row/bulk re-search flow
 * Missing.tsx uses for items with no file at all. */
export default function CutoffUnmet() {
  const [rows, setRows] = useState<CutoffUnmetRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);

  function load() {
    api.get<CutoffUnmetRow[]>("/wanted/cutoff-unmet").then((data) => {
      setRows(data);
      setSelected(new Set());
    });
  }

  useEffect(load, []);

  function toggle(r: CutoffUnmetRow) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(r);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function searchRows(targets: CutoffUnmetRow[]) {
    setSearching(true);
    try {
      const results = await api.post<{ grabbed: boolean; error?: string }[]>("/search/bulk", {
        targets: targets.map(toTarget),
      });
      const grabbedCount = results.filter((r) => r.grabbed).length;
      notify.success(`Grabbed ${grabbedCount} of ${results.length} item(s).`);
      load();
    } finally {
      setSearching(false);
    }
  }

  async function bulkSearch() {
    if (!rows) return;
    const targets = rows.filter((r) => selected.has(rowKey(r)));
    await searchRows(targets);
  }

  const { sortRows, sortableHeader } = useSortableTable<CutoffUnmetRow, "media" | "item" | "current" | "cutoff" | "profile">("media");
  const sorted = rows
    ? sortRows(rows, (a, b, key) => {
        if (key === "media") return a.mediaTitle.localeCompare(b.mediaTitle);
        if (key === "item") return a.label.localeCompare(b.label);
        if (key === "current") return a.currentQuality.localeCompare(b.currentQuality);
        if (key === "cutoff") return a.cutoff.localeCompare(b.cutoff);
        return a.profileName.localeCompare(b.profileName);
      })
    : [];

  if (!rows) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>Cutoff Unmet</h1>
      <p style={{ color: "var(--muted)" }}>
        Downloaded items whose current quality is still below their quality profile's cutoff —
        raising a profile's cutoff after something was already grabbed under the old (lower) one
        doesn't retroactively re-search it, so these sit here until manually (or automatically)
        re-searched for an upgrade.
      </p>
      {selected.size > 0 && (
        <div className="form-panel" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <strong>{selected.size} selected</strong>
          <button type="button" className="icon-button" onClick={bulkSearch} disabled={searching} title={searching ? "Searching..." : "Search selected"} aria-label="Search selected">
            <SearchIcon />
          </button>
          <button type="button" className="secondary" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      {rows.length === 0 && <p className="empty">Nothing here — everything downloaded already meets its profile's cutoff.</p>}
      {rows.length > 0 && (
        <>
          {rows.length > 1 && (
            <p>
              <button type="button" className="icon-button" onClick={() => searchRows(rows)} disabled={searching} title={searching ? "Searching..." : "Search all"} aria-label="Search all">
                <SearchIcon />
              </button>
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th></th>
                {sortableHeader("media", "Media")}
                {sortableHeader("item", "Item")}
                {sortableHeader("current", "Current")}
                {sortableHeader("cutoff", "Cutoff")}
                {sortableHeader("profile", "Profile")}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr key={idx}>
                  <td>
                    <input type="checkbox" checked={selected.has(rowKey(r))} onChange={() => toggle(r)} />
                  </td>
                  <td>{r.mediaTitle}</td>
                  <td>{r.label}</td>
                  <td>
                    <span className="badge">{r.currentQuality}</span>
                  </td>
                  <td>{r.cutoff}</td>
                  <td>{r.profileName}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button type="button" className="icon-button" onClick={() => searchRows([r])} disabled={searching} title="Search" aria-label="Search">
                      <SearchIcon />
                    </button>
                    <Link to={`/media/${r.mediaItemId}`}>
                      <button type="button" className="icon-button" title="Open" aria-label="Open">
                        <ArrowRightIcon />
                      </button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
