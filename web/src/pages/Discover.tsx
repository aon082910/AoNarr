import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import type { MediaItem, QualityProfile } from "../types.js";
import { PlusCircleIcon } from "../components/NavIcons.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import type { AddPreviewState } from "./AddPreview.js";

interface DiscoverItem {
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  type: "movie" | "series";
  inLibrary: boolean;
  mediaItemId: number | null;
  backdropUrl?: string | null;
  rating?: number | null;
}

interface DiscoverResponse {
  movies: DiscoverItem[];
  series: DiscoverItem[];
}

const INITIAL_VISIBLE_COUNT = 12;

export default function Discover() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (auth.isAdmin) api.get<QualityProfile[]>("/quality-profiles").then(setProfiles);
    api
      .get<DiscoverResponse>("/discover")
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [auth.isAdmin]);

  function keyFor(item: DiscoverItem) {
    // Trending routinely holds two titles that only differ by year (remakes) — key on the
    // provider id when there is one so "Request" on one doesn't mark the other as requested too.
    const id = item.externalIds?.tmdb ?? item.externalIds?.tvdb ?? item.externalIds?.imdb ?? `${item.title}-${item.year ?? ""}`;
    return `${item.type}-${id}`;
  }

  /** Card click — mirrors GlobalSearch.tsx's own "in library -> detail page, otherwise -> add
   * preview" split, so browsing Discover feels the same as browsing search results. */
  function openPreview(item: DiscoverItem) {
    if (item.inLibrary && item.mediaItemId) {
      navigate(`/media/${item.mediaItemId}`);
      return;
    }
    // /add/preview is an admin-only route; a household account would fall through to the
    // catch-all redirect and be dumped on the Dashboard. Its card's Request button is the action.
    if (!auth.isAdmin) return;
    const state: AddPreviewState = {
      type: item.type,
      result: {
        title: item.title,
        year: item.year,
        overview: item.overview,
        posterUrl: item.posterUrl,
        externalIds: item.externalIds,
        backdropUrl: item.backdropUrl ?? null,
        rating: item.rating ?? null,
      },
      manual: false,
    };
    navigate("/add/preview", { state });
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
      notify.error((e as Error).message);
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
        if (
          await confirmDialog({
            title: "Already requested",
            message: `"${d.title}${d.year ? ` (${d.year})` : ""}" was already requested by ${d.username}. Submit another request for it anyway?`,
          })
        ) {
          await requestItem(item, true);
          return;
        }
      } else {
        notify.error((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }

  function renderSection(sectionKey: string, title: string, items: DiscoverItem[]) {
    if (items.length === 0) return null;
    const isExpanded = expanded.has(sectionKey);
    const visible = isExpanded ? items : items.slice(0, INITIAL_VISIBLE_COUNT);
    return (
      <>
        <h2>{title}</h2>
        <div className="grid">
          {visible.map((item) => {
            const key = keyFor(item);
            const alreadyRequested = requested.has(key);
            const clickable = auth.isAdmin || (item.inLibrary && !!item.mediaItemId);
            return (
              <div
                key={key}
                className={clickable ? "card" : "card static"}
                style={clickable ? undefined : { cursor: "default" }}
                onClick={() => openPreview(item)}
              >
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
                    <button
                      type="button"
                      className="icon-button"
                      style={{ marginTop: 6 }}
                      disabled={busy === key}
                      onClick={(e) => {
                        e.stopPropagation();
                        addDirectly(item);
                      }}
                      title={busy === key ? "Adding..." : "Add"}
                      aria-label="Add to library"
                    >
                      <PlusCircleIcon />
                    </button>
                  ) : alreadyRequested ? (
                    <span className="badge ok" style={{ marginTop: 6, display: "inline-block" }}>
                      Requested
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="icon-button"
                      style={{ marginTop: 6 }}
                      disabled={busy === key}
                      onClick={(e) => {
                        e.stopPropagation();
                        requestItem(item);
                      }}
                      title={busy === key ? "Requesting..." : "Request"}
                      aria-label="Request"
                    >
                      <PlusCircleIcon />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!isExpanded && items.length > INITIAL_VISIBLE_COUNT && (
          <button type="button" className="secondary" onClick={() => setExpanded((prev) => new Set(prev).add(sectionKey))}>
            View more ({items.length - INITIAL_VISIBLE_COUNT} more)
          </button>
        )}
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
      {data && renderSection("movies", "Trending Movies", data.movies)}
      {data && renderSection("series", "Trending TV", data.series)}
      {data && data.movies.length === 0 && data.series.length === 0 && !error && (
        <p className="empty">Nothing to show — check that a TMDB API key is configured and you have access to Movies or TV Shows.</p>
      )}
    </div>
  );
}
