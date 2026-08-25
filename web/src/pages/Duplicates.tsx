import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { DuplicateGroup } from "../types.js";

/** One duplicate group's row-level state: which item is currently selected to keep. Kept outside
 * the fetched data so re-rendering (or a merge elsewhere on the page) doesn't reset a choice the
 * admin already made in a still-open group. */
export default function Duplicates() {
  const mediaTypes = useMediaTypes();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [keeperByGroup, setKeeperByGroup] = useState<Record<string, number>>({});
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [merging, setMerging] = useState<string | null>(null);

  function groupKey(g: DuplicateGroup): string {
    return `${g.type}::${g.title}::${g.year ?? ""}`;
  }

  function load() {
    api.get<DuplicateGroup[]>(`/duplicates${typeFilter ? `?type=${typeFilter}` : ""}`).then((data) => {
      setGroups(data);
      // Default each group's radio selection to the suggested keeper, without clobbering a choice
      // already made for a group that's still in the list after a previous merge elsewhere.
      setKeeperByGroup((prev) => {
        const next = { ...prev };
        for (const g of data) {
          const key = groupKey(g);
          if (next[key] === undefined) {
            next[key] = g.items.find((i) => i.suggestedKeeper)?.id ?? g.items[0].id;
          }
        }
        return next;
      });
    });
  }
  useEffect(load, [typeFilter]);

  async function dismiss(g: DuplicateGroup) {
    if (!confirm(`Mark "${g.title}"${g.year ? ` (${g.year})` : ""} as not a duplicate? Both items stay in your library untouched, and this group won't be flagged again.`)) {
      return;
    }
    await api.post("/duplicates/dismiss", { key: g.key });
    setGroups((prev) => prev?.filter((group) => group.key !== g.key) ?? null);
  }

  async function merge(g: DuplicateGroup) {
    const key = groupKey(g);
    const keeperId = keeperByGroup[key];
    const loserIds = g.items.filter((i) => i.id !== keeperId).map((i) => i.id);
    if (
      !confirm(
        `Merge ${loserIds.length} duplicate(s) of "${g.title}" into the selected item?${
          deleteFiles ? " Any file(s) not kept will be moved to the Recycle Bin." : " Any file(s) not kept are left on disk, untracked."
        }`
      )
    ) {
      return;
    }
    setMerging(key);
    try {
      await api.post("/duplicates/merge", { keeperId, loserIds, deleteFiles });
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setMerging(null);
    }
  }

  return (
    <div>
      <h1>Duplicates</h1>
      <p style={{ color: "var(--muted)" }}>
        Groups of library items that share the same title and year — most commonly leftover from
        before Round 106's import-matching fix (see the Changelog), where a re-scan or media-server
        re-sync of an already-imported movie could create a second entry instead of recognizing it.
        Pick which one to keep per group; the others are merged into it (adopting a missing
        file/metadata/tags/history first) and removed. This can't be undone for the database rows
        themselves, though a kept-vs-deleted file choice below still goes through the Recycle Bin.
      </p>

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All library types</option>
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
          Recycle files that aren't kept
        </label>
      </div>

      {groups === null && <p className="empty">Loading...</p>}
      {groups !== null && groups.length === 0 && <p className="empty">No duplicates found.</p>}

      {groups?.map((g) => {
        const key = groupKey(g);
        const typeLabel = mediaTypes.find((t) => t.key === g.type)?.label ?? g.type;
        return (
          <div
            key={key}
            style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, marginBottom: 16 }}
          >
            <h2 style={{ marginTop: 0 }}>
              {g.title} {g.year ? `(${g.year})` : ""} <span style={{ color: "var(--muted)", fontWeight: "normal" }}>— {typeLabel}</span>
            </h2>
            <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Keep</th>
                  <th></th>
                  <th>Title</th>
                  <th>File</th>
                  <th>Quality</th>
                  <th>Matched to</th>
                  <th>{g.items.some((i) => i.childCount > 0) ? "Children" : ""}</th>
                  <th>Monitored</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input
                        type="radio"
                        name={key}
                        checked={keeperByGroup[key] === item.id}
                        onChange={() => setKeeperByGroup((prev) => ({ ...prev, [key]: item.id }))}
                      />
                    </td>
                    <td>
                      {item.posterUrl ? (
                        <img src={item.posterUrl} alt="" style={{ width: 32, height: 48, objectFit: "cover", borderRadius: 3 }} />
                      ) : null}
                    </td>
                    <td style={{ maxWidth: 280, overflowWrap: "anywhere" }}>
                      <Link to={`/media/${item.id}`} target="_blank">
                        {item.title} {item.suggestedKeeper && <span className="badge">suggested</span>}
                      </Link>
                    </td>
                    <td>
                      <span className={`badge ${item.hasFile ? "ok" : ""}`}>{item.hasFile ? "Downloaded" : "Missing"}</span>
                      {item.path && (
                        <div style={{ color: "var(--muted)", fontSize: "0.75rem", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.path}
                        </div>
                      )}
                    </td>
                    <td>{item.quality ?? "-"}</td>
                    <td>
                      {item.matchedProviders.length > 0 ? (
                        item.matchedProviders.join(", ")
                      ) : (
                        <span className="badge danger">Unmatched</span>
                      )}
                    </td>
                    <td>{item.childCount > 0 ? item.childCount : ""}</td>
                    <td>{item.monitored ? "Yes" : "No"}</td>
                    <td>{item.addedAt ? new Date(item.addedAt).toLocaleDateString() : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button onClick={() => merge(g)} disabled={merging === key}>
                {merging === key ? "Merging..." : `Merge ${g.items.length - 1} into the kept item`}
              </button>
              <button className="secondary" onClick={() => dismiss(g)} title="Both items stay in your library, untouched">
                Not a duplicate — keep both
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
