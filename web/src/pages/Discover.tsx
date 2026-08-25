import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import type { MediaItem, QualityProfile } from "../types.js";

interface DiscoverItem {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  type: "movie" | "series";
  inLibrary: boolean;
}

interface DiscoverResponse {
  movies: DiscoverItem[];
  series: DiscoverItem[];
}

export default function Discover() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (auth.isAdmin) api.get<QualityProfile[]>("/quality-profiles").then(setProfiles);
    api
      .get<DiscoverResponse>("/discover")
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [auth.isAdmin]);

  function keyFor(item: DiscoverItem) {
    return `${item.type}-${item.title}`;
  }

  async function addDirectly(item: DiscoverItem) {
    const key = keyFor(item);
    setBusy(key);
    try {
      const created = await api.post<MediaItem>("/metadata/import", {
        type: item.type,
        title: item.title,
        year: item.year,
        overview: item.overview,
        posterUrl: item.posterUrl,
        externalIds: item.externalIds,
        qualityProfileId: profiles[0]?.id ?? null,
        monitored: 1,
      });
      navigate(`/media/${created.id}`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function requestItem(item: DiscoverItem, confirmDuplicate = false) {
    const key = keyFor(item);
    setBusy(key);
    try {
      await api.post("/requests", {
        type: item.type,
        title: item.title,
        year: item.year,
        overview: item.overview,
        posterUrl: item.posterUrl,
        externalIds: item.externalIds,
        confirmDuplicate,
      });
      setRequested((prev) => new Set(prev).add(key));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body?.duplicate) {
        const d = e.body.duplicate;
        if (confirm(`"${d.title}${d.year ? ` (${d.year})` : ""}" was already requested by ${d.username}. Submit another request for it anyway?`)) {
          await requestItem(item, true);
          return;
        }
      } else {
        alert((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }

  function renderSection(title: string, items: DiscoverItem[]) {
    if (items.length === 0) return null;
    return (
      <>
        <h2>{title}</h2>
        <div className="grid">
          {items.map((item) => {
            const key = keyFor(item);
            const alreadyRequested = requested.has(key);
            return (
              <div key={key} className="card" style={{ cursor: "default" }}>
                <div className="poster" style={item.posterUrl ? { backgroundImage: `url(${item.posterUrl})` } : undefined}>
                  {!item.posterUrl && "No poster"}
                </div>
                <div className="meta">
                  <div className="title">{item.title}</div>
                  <div className="sub">{item.year ?? ""}</div>
                  {item.inLibrary ? (
                    <span className="badge ok" style={{ marginTop: 6, display: "inline-block" }}>
                      In library
                    </span>
                  ) : auth.isAdmin ? (
                    <button className="secondary" style={{ marginTop: 6 }} disabled={busy === key} onClick={() => addDirectly(item)}>
                      {busy === key ? "Adding..." : "Add"}
                    </button>
                  ) : alreadyRequested ? (
                    <span className="badge ok" style={{ marginTop: 6, display: "inline-block" }}>
                      Requested
                    </span>
                  ) : (
                    <button className="secondary" style={{ marginTop: 6 }} disabled={busy === key} onClick={() => requestItem(item)}>
                      {busy === key ? "Requesting..." : "Request"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div>
      <h1>Discover</h1>
      <p style={{ color: "var(--muted)" }}>
        Trending movies and TV this week, from TMDB.{" "}
        {auth.isAdmin ? "Add anything that isn't already in the library." : "Request anything that isn't already in the library."}
      </p>
      {loading && <p className="empty">Loading...</p>}
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {data && renderSection("Trending Movies", data.movies)}
      {data && renderSection("Trending TV", data.series)}
      {data && data.movies.length === 0 && data.series.length === 0 && !error && (
        <p className="empty">Nothing to show — check that a TMDB API key is configured and you have access to Movies or TV Shows.</p>
      )}
    </div>
  );
}
