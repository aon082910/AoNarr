import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaItem } from "../types.js";
import { formatBytes } from "../utils/format.js";

/** The Library landing page: what's new across every library type, plus one card per type
 * linking into its own browsing page (/library/:type) — the per-type pages carry the
 * filters/sort/view options; this page is purely a status overview. */
export default function LibraryHome() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes().filter((t) => auth.isAdmin || auth.user?.allowedTypes.includes(t.key));
  const [recent, setRecent] = useState<MediaItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [sizes, setSizes] = useState<Record<string, number>>({});

  useEffect(() => {
    api.get<MediaItem[]>("/dashboard/recently-added").then(setRecent);
    api.get<Record<string, number>>("/dashboard/library-counts").then(setCounts);
    api.get<Record<string, number>>("/dashboard/library-sizes").then(setSizes);
  }, []);

  const totalSize = Object.values(sizes).reduce((sum, n) => sum + n, 0);

  return (
    <div>
      <h1>Library</h1>
      <p style={{ color: "var(--muted)" }}>Total library size on disk: {formatBytes(totalSize)}</p>

      <h2>Browse by type</h2>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
        {mediaTypes.map((t) => (
          <div
            key={t.key}
            className="card"
            onClick={() => navigate(`/library/${t.key}`)}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, cursor: "pointer" }}
          >
            <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>{t.label}</div>
            <div style={{ color: "var(--muted)", marginTop: 6 }}>{counts[t.key] ?? 0} item(s)</div>
            <div style={{ color: "var(--muted)", fontSize: "0.8rem" }}>{formatBytes(sizes[t.key] ?? 0)}</div>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: 24 }}>Recently Added (all libraries)</h2>
      {recent.length === 0 && <p className="empty">Nothing added yet.</p>}
      <div className="grid">
        {recent.map((item) => (
          <Link key={item.id} to={`/media/${item.id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="poster" style={item.posterUrl ? { backgroundImage: `url(${item.posterUrl})` } : undefined}>
              {!item.posterUrl && "No poster"}
            </div>
            <div className="meta">
              <div className="title">{item.title}</div>
              <div className="sub">
                {item.year ?? ""} · {mediaTypes.find((t) => t.key === item.type)?.label ?? item.type}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
