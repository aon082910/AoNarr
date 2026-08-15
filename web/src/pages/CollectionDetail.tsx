import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, downloadFile } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { Collection, MediaItem } from "../types.js";

type CollectionDetailResponse = Collection & { items: MediaItem[] };

export default function CollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const [collection, setCollection] = useState<CollectionDetailResponse | null>(null);
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  function load() {
    api.get<CollectionDetailResponse>(`/collections/${id}`).then(setCollection);
  }
  useEffect(load, [id]);

  async function updateRetention(value: string) {
    const retentionDays = value === "" ? null : Number(value);
    await api.patch(`/collections/${id}`, { retentionDays });
    load();
  }

  async function removeItem(mediaItemId: number) {
    await api.del(`/collections/${id}/items/${mediaItemId}`);
    load();
  }

  async function move(index: number, direction: -1 | 1) {
    if (!collection) return;
    const target = index + direction;
    if (target < 0 || target >= collection.items.length) return;
    const reordered = [...collection.items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setCollection({ ...collection, items: reordered });
    await api.put(`/collections/${id}/items/order`, { orderedIds: reordered.map((i) => i.id) });
  }

  async function exportList(format: "m3u" | "json") {
    if (!collection) return;
    if (format === "m3u") {
      await downloadFile(`/collections/${id}/export?format=m3u`, `${collection.name}.m3u`);
    } else {
      await downloadFile(`/collections/${id}/export?format=json`, `${collection.name}.json`);
    }
  }

  if (!collection) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>
        {collection.name}
        {collection.smartFilter && (
          <span className="badge" style={{ marginLeft: 10, fontSize: "0.6em", verticalAlign: "middle" }}>
            Smart
          </span>
        )}
      </h1>
      {collection.description && <p style={{ color: "var(--muted)" }}>{collection.description}</p>}
      {collection.smartFilter && (
        <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          Membership is computed live from a saved filter — items can't be manually added, removed,
          or reordered here.
        </p>
      )}

      {auth.isAdmin && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <label style={{ margin: 0 }}>Archival retention:</label>
          <select
            value={collection.retentionDays === null ? "" : collection.retentionDays === -1 ? "never" : "custom"}
            onChange={(e) => {
              if (e.target.value === "") updateRetention("");
              else if (e.target.value === "never") updateRetention("-1");
              else if (e.target.value === "custom") updateRetention("30");
            }}
            style={{ width: "auto" }}
          >
            <option value="">Use default</option>
            <option value="custom">Custom days...</option>
            <option value="never">Never archive</option>
          </select>
          {collection.retentionDays !== null && collection.retentionDays !== -1 && (
            <input
              type="number"
              style={{ width: 80 }}
              defaultValue={collection.retentionDays}
              onBlur={(e) => updateRetention(e.target.value)}
            />
          )}
        </div>
      )}

      {collection.items.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button className="secondary" onClick={() => exportList("m3u")}>
            Export as M3U playlist
          </button>
          <button className="secondary" onClick={() => exportList("json")}>
            Export as watch-order list
          </button>
        </div>
      )}

      {collection.items.length === 0 && (
        <p className="empty">
          No items yet — open a media item and use "Add to collection" to add one here.
        </p>
      )}

      <div className="grid">
        {collection.items.map((item, index) => (
          <div key={item.id} className="card">
            <div
              className="poster"
              style={item.posterUrl ? { backgroundImage: `url(${item.posterUrl})` } : undefined}
              onClick={() => navigate(`/media/${item.id}`)}
            >
              {!item.posterUrl && "No poster"}
            </div>
            <div className="meta">
              <div className="title" onClick={() => navigate(`/media/${item.id}`)} style={{ cursor: "pointer" }}>
                {item.title}
              </div>
              <div className="sub">
                {item.year ?? ""} · {labelFor(item.type)}
              </div>
              {!collection.smartFilter && (
                <>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button className="secondary" disabled={index === 0} onClick={() => move(index, -1)} style={{ flex: 1 }}>
                      Up
                    </button>
                    <button
                      className="secondary"
                      disabled={index === collection.items.length - 1}
                      onClick={() => move(index, 1)}
                      style={{ flex: 1 }}
                    >
                      Down
                    </button>
                  </div>
                  <button className="danger" style={{ marginTop: 6, width: "100%" }} onClick={() => removeItem(item.id)}>
                    Remove
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
