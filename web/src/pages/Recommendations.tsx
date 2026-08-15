import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import type { MediaItem, MediaType, QualityProfile } from "../types.js";

interface Recommendation {
  title: string;
  year: number | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  type: MediaType;
  sourceTitle: string;
}

interface RecommendationsResponse {
  movies: Recommendation[];
  series: Recommendation[];
  artists: Recommendation[];
}

export default function Recommendations() {
  const navigate = useNavigate();
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get<QualityProfile[]>("/quality-profiles").then(setProfiles);
    api
      .get<RecommendationsResponse>("/recommendations")
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  async function add(r: Recommendation) {
    setAdding(`${r.type}-${r.title}`);
    try {
      const created = await api.post<MediaItem>("/metadata/import", {
        type: r.type,
        title: r.title,
        year: r.year,
        posterUrl: r.posterUrl,
        externalIds: r.externalIds,
        qualityProfileId: profiles[0]?.id ?? null,
        monitored: 1,
      });
      navigate(`/media/${created.id}`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setAdding(null);
    }
  }

  async function notInterested(r: Recommendation) {
    const key = `${r.type}-${r.title}`;
    const provider = Object.keys(r.externalIds)[0];
    await api.post("/import-exclusions", {
      type: r.type,
      title: r.title,
      year: r.year,
      externalId: provider ? r.externalIds[provider] : null,
      externalProvider: provider ?? null,
      reason: "Dismissed from Recommendations",
    });
    setDismissed((prev) => new Set(prev).add(key));
  }

  function section(title: string, items: Recommendation[]) {
    const visible = items.filter((r) => !dismissed.has(`${r.type}-${r.title}`));
    if (visible.length === 0) return null;
    return (
      <>
        <h2>{title}</h2>
        <div className="grid">
          {visible.map((r, idx) => (
            <div key={idx} className="card">
              <div className="poster" style={r.posterUrl ? { backgroundImage: `url(${r.posterUrl})` } : undefined}>
                {!r.posterUrl && "No poster"}
              </div>
              <div className="meta">
                <div className="title">{r.title}</div>
                <div className="sub">
                  {r.year ?? ""} · because you added {r.sourceTitle}
                </div>
                <button
                  style={{ marginTop: 8, width: "100%" }}
                  disabled={adding === `${r.type}-${r.title}`}
                  onClick={() => add(r)}
                >
                  {adding === `${r.type}-${r.title}` ? "Adding..." : "Add"}
                </button>
                <button className="secondary" style={{ marginTop: 6, width: "100%" }} onClick={() => notInterested(r)}>
                  Not interested
                </button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  if (loading) return <p className="empty">Loading...</p>;

  const empty = !data || (data.movies.length === 0 && data.series.length === 0 && data.artists.length === 0);

  return (
    <div>
      <h1>Recommendations</h1>
      <p style={{ color: "var(--muted)" }}>
        Based on what's already in your library — movies and TV shows need a TMDB API key,
        artists need a Last.fm API key (both in Settings).
      </p>
      {empty && (
        <p className="empty">
          Nothing to suggest yet — add a few movies/series/artists (with a TMDB/Last.fm key
          configured) and recommendations will appear here.
        </p>
      )}
      {data && section("Movies", data.movies)}
      {data && section("TV Shows", data.series)}
      {data && section("Music", data.artists)}
    </div>
  );
}
