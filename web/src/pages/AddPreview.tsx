import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import GroupPicker from "../components/GroupPicker.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import type { LibraryGroup, MediaItem, MediaType, MetadataSearchResult, QualityProfile, RootFolder } from "../types.js";
import { formatBytes } from "../utils/format.js";
import { CalendarIcon, ClockIcon, StarIcon, BriefcaseIcon } from "../components/NavIcons.js";

type MonitorStrategy = "all" | "future" | "missing" | "existing" | "recent" | "firstSeason" | "latestSeason" | "pilot" | "none";

const MONITOR_STRATEGY_LABELS: Record<MonitorStrategy, string> = {
  all: "All Episodes",
  future: "Future Episodes",
  missing: "Missing Episodes",
  existing: "Existing Episodes",
  recent: "Recent Episodes (last season)",
  firstSeason: "First Season",
  latestSeason: "Latest Season",
  pilot: "Pilot Episode Only",
  none: "None",
};

// This page only ever runs the fresh-add code path (server's episodesToMonitor(), called only from
// POST /metadata/import's brand-new-item branch) — nothing is downloaded and no episode "exists"
// yet, so "Missing Episodes" always monitors the exact same set as "All Episodes" there, and
// "Existing Episodes" always monitors nothing, same as "None". Offering all nine options here would
// mean two of them can never behave differently from two others already in the same list, with
// nothing telling the user that. The full set stays meaningful for a possible future "change
// monitoring" control on an already-added series, where existing/missing episode state is real.
const ADD_MONITOR_STRATEGIES: MonitorStrategy[] = ["all", "future", "recent", "firstSeason", "latestSeason", "pilot", "none"];

/** What AddMedia.tsx (or GlobalSearch.tsx's "Add new" results) hands off via router navigation
 * state once a candidate has been found — `manual` marks best-effort/user-supplied data (a plain
 * manual entry, an .nfo file, a scraped course page) as opposed to a confirmed metadata-provider
 * match, which gates whether Title/Year/Overview render as editable fields here. */
export interface AddPreviewState {
  type: MediaType;
  result: MetadataSearchResult;
  manual: boolean;
  initialGroupChain?: (number | null)[];
}

/** Radarr/Sonarr-style "Add New" page — styled like the real MediaDetail.tsx hero (poster/
 * backdrop, title, overview) since this item doesn't have a numeric id yet, so the cast/ratings/
 * file-status sections a real detail page also shows simply have nothing to fetch. Reached only by
 * navigating here with state (see AddPreviewState) — a direct visit/refresh has nothing to preview,
 * so it bounces back to the search page. */
export default function AddPreview() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as AddPreviewState | null) ?? null;
  const mediaTypes = useMediaTypes();

  const [title, setTitle] = useState(state?.result.title ?? "");
  const [year, setYear] = useState(state?.result.year ? String(state.result.year) : "");
  const [overview, setOverview] = useState(state?.result.overview ?? "");
  const [rootFolders, setRootFolders] = useState<RootFolder[]>([]);
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [rootFolderId, setRootFolderId] = useState<number | "">("");
  const [qualityProfileId, setQualityProfileId] = useState<number | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [groupChain, setGroupChain] = useState<(number | null)[] | undefined>(state?.initialGroupChain);
  const [monitorStrategy, setMonitorStrategy] = useState<MonitorStrategy>("all");
  const [romDetailsLoading, setRomDetailsLoading] = useState(false);

  const activeTypeInfo = mediaTypes.find((t) => t.key === state?.type);

  useEffect(() => {
    if (!state) navigate("/add", { replace: true });
  }, [state, navigate]);

  useEffect(() => {
    api.get<RootFolder[]>("/root-folders").then(setRootFolders);
    api.get<QualityProfile[]>("/quality-profiles").then((p) => {
      setProfiles(p);
      if (p.length > 0) setQualityProfileId(p[0].id);
    });
  }, []);

  async function findOrCreateGroup(
    mediaType: MediaType,
    kind: string,
    name: string,
    parentGroupId: number | null,
    logoUrl?: string | null
  ): Promise<number> {
    const groups = await api.get<LibraryGroup[]>(
      `/library-groups?mediaType=${mediaType}${parentGroupId ? `&parentId=${parentGroupId}` : ""}`
    );
    const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const created = await api.post<LibraryGroup>("/library-groups", { mediaType, kind, name, parentGroupId, logoUrl });
    return created.id;
  }

  // RAWG/IGDB's search results don't carry overview/platform/developer — only their per-game
  // detail lookup does, so this is a follow-up call rather than something already in `result`.
  // Fire-and-forget (not awaited before rendering) so the page is usable immediately; the group
  // picker's default just fills in once this resolves, same as AddMedia.tsx did before this page
  // existed.
  useEffect(() => {
    if (!state || state.type !== "rom" || state.manual) return;
    const [provider, externalId] = Object.entries(state.result.externalIds ?? {})[0] ?? [];
    if (!provider || !externalId) return;
    setRomDetailsLoading(true);
    api
      .get<{ overview: string | null; system: string | null; maker: string | null; systemLogoUrl: string | null }>(
        `/metadata/rom-details?provider=${provider}&externalId=${encodeURIComponent(externalId)}`
      )
      .then(async (details) => {
        if (details.overview) setOverview(details.overview);
        if (details.system) {
          const systemId = await findOrCreateGroup("rom", "system", details.system, null, details.systemLogoUrl);
          const makerId = details.maker ? await findOrCreateGroup("rom", "maker", details.maker, systemId) : null;
          setGroupChain([systemId, makerId]);
        }
      })
      .catch(() => {
        // Best-effort enrichment — a failed lookup just leaves overview/group exactly where the
        // basic search result already put them.
      })
      .finally(() => setRomDetailsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return null;

  const { type, result, manual } = state;
  const foldersForType = rootFolders.filter((f) => f.mediaType === type);

  async function doImport(confirmDuplicate = false) {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const payload = {
        type,
        title: title.trim(),
        year: year ? Number(year) : null,
        overview: overview || null,
        posterUrl: result.posterUrl ?? null,
        externalIds: result.externalIds ?? {},
        rootFolderId: rootFolderId || null,
        qualityProfileId: qualityProfileId || null,
        monitored: 1,
        confirmDuplicate,
        groupId,
        monitorStrategy: activeTypeInfo?.shape === "episodic" ? monitorStrategy : undefined,
        ...(!manual && {
          releaseDate: result.releaseDate ?? null,
          backdropUrl: result.backdropUrl ?? null,
          rating: result.rating ?? null,
          runtimeMinutes: result.runtimeMinutes ?? null,
          studio: result.studio ?? null,
          performers: result.performers ?? undefined,
          contentRating: result.contentRating ?? null,
        }),
      };
      const created = await api.post<MediaItem>(manual ? "/media" : "/metadata/import", payload);
      navigate(`/media/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.body?.duplicates)) {
        const names = err.body.duplicates.map((d: any) => `${d.title}${d.year ? ` (${d.year})` : ""}`).join(", ");
        if (
          await confirmDialog({
            title: "Possible duplicate",
            message: `This looks like it might already be in your library: ${names}. Add it anyway?`,
          })
        ) {
          await doImport(true);
          return;
        }
      } else {
        notify.error((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="media-backdrop" style={result.backdropUrl ? { backgroundImage: `url(${result.backdropUrl})`, backgroundSize: "cover" } : undefined}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={{ width: 160, flexShrink: 0 }}>
            {result.posterUrl ? (
              <img src={result.posterUrl} alt="" style={{ width: "100%", borderRadius: 6 }} />
            ) : (
              <div className="poster" style={{ width: "100%" }}>
                No poster
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ marginBottom: 4 }}>{title || "Untitled"}</h1>
            {overview && <p style={{ maxWidth: 720 }}>{overview}</p>}
            {/* Same detail-pills treatment as the real MediaDetail hero, for visual consistency —
                read-only facts about the match, not the config form further down. */}
            <div className="detail-pills">
              {year && (
                <span className="pill" title="Year">
                  <CalendarIcon /> {year}
                </span>
              )}
              <span className="pill" title="Type">{activeTypeInfo?.label ?? type}</span>
              {typeof result.runtimeMinutes === "number" && (
                <span className="pill" title="Runtime">
                  <ClockIcon /> {result.runtimeMinutes} min
                </span>
              )}
              {typeof result.rating === "number" && (
                <span className="pill" title="Rating">
                  <StarIcon /> {result.rating.toFixed(1)}
                </span>
              )}
              {result.studio && (
                <span className="pill" title="Studio">
                  <BriefcaseIcon /> {result.studio}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {manual && (
        <div className="form-panel">
          <label htmlFor="addpreview-title">Title</label>
          <input id="addpreview-title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus={!title} />
          <label htmlFor="addpreview-year">Year</label>
          <input id="addpreview-year" value={year} onChange={(e) => setYear(e.target.value)} type="number" />
          <label htmlFor="addpreview-overview">Overview</label>
          <textarea id="addpreview-overview" value={overview} onChange={(e) => setOverview(e.target.value)} rows={3} />
        </div>
      )}

      <div className="form-panel">
        {type === "rom" && romDetailsLoading && <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>Looking up system/maker...</p>}
        {activeTypeInfo && activeTypeInfo.groupLevels.length > 0 && (
          <GroupPicker
            key={groupChain?.join(",") ?? "unset"}
            type={type}
            groupLevels={activeTypeInfo.groupLevels}
            initialChain={groupChain}
            onChange={setGroupId}
          />
        )}

        <label htmlFor="addpreview-root-folder">Root folder</label>
        <select id="addpreview-root-folder" value={rootFolderId} onChange={(e) => setRootFolderId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Auto (most free space)</option>
          {foldersForType.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
              {typeof f.freeBytes === "number" ? ` — ${formatBytes(f.freeBytes)} free` : ""}
            </option>
          ))}
        </select>

        <label htmlFor="addpreview-quality-profile">Quality profile</label>
        <select id="addpreview-quality-profile" value={qualityProfileId} onChange={(e) => setQualityProfileId(e.target.value ? Number(e.target.value) : "")}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {activeTypeInfo?.shape === "episodic" && (
          <>
            <label htmlFor="addpreview-monitor">Monitor</label>
            <select id="addpreview-monitor" value={monitorStrategy} onChange={(e) => setMonitorStrategy(e.target.value as MonitorStrategy)}>
              {ADD_MONITOR_STRATEGIES.map((key) => (
                <option key={key} value={key}>
                  {MONITOR_STRATEGY_LABELS[key]}
                </option>
              ))}
            </select>
          </>
        )}

        <button type="button" onClick={() => doImport(false)} disabled={submitting || !title.trim()}>
          {submitting ? "Adding..." : "Add to library"}
        </button>
      </div>
    </div>
  );
}
