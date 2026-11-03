import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client.js";
import GroupPicker from "../components/GroupPicker.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import type { LibraryGroup, MediaItem, MediaType, MetadataProfile, MetadataSearchResult, QualityProfile, RootFolder, Tag } from "../types.js";
import { formatBytes } from "../utils/format.js";
import { displayableImageUrl } from "../utils/artwork.js";
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

type CollectionMonitor = "all" | "future" | "first" | "latest" | "none";

/** Lidarr's and Readarr's Monitor choice for an artist's albums or an author's books. As with the
 * episodes above, "missing" and "existing" come out as "all" and "none" on a brand new add. */
const COLLECTION_MONITOR_LABELS: Record<CollectionMonitor, string> = {
  all: "All items",
  future: "Future items",
  first: "First item only",
  latest: "Latest item only",
  none: "None",
};

type NewItemMonitor = "" | "all" | "new" | "none";

const NEW_ITEM_LABELS: Record<NewItemMonitor, string> = {
  "": "Root folder default",
  all: "Monitor all new items",
  new: "Monitor only items newer than what exists",
  none: "Do not monitor new items",
};

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
  // "" leaves the Monitor choice to the root folder's default (the server applies it).
  const [monitorStrategy, setMonitorStrategy] = useState<MonitorStrategy | "">("");
  const [collectionMonitor, setCollectionMonitor] = useState<CollectionMonitor | "">("");
  const [monitorNewItems, setMonitorNewItems] = useState<NewItemMonitor>("");
  const [metadataProfiles, setMetadataProfiles] = useState<MetadataProfile[]>([]);
  const [metadataProfileId, setMetadataProfileId] = useState<number | "">("");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);
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
    api.get<MetadataProfile[]>("/metadata-profiles").then(setMetadataProfiles).catch(() => undefined);
    api.get<Tag[]>("/tags").then(setAllTags).catch(() => undefined);
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
  const posterSrc = displayableImageUrl(result.posterUrl);
  const backdropSrc = displayableImageUrl(result.backdropUrl);

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
        // "" leaves the choice to the root folder's default (server side).
        monitorStrategy: activeTypeInfo?.shape === "episodic" ? monitorStrategy || undefined : activeTypeInfo?.shape === "collection" && collectionMonitor ? collectionMonitor : undefined,
        monitorNewItems: monitorNewItems || undefined,
        metadataProfileId: metadataProfileId || undefined,
        tagIds: tagIds.length > 0 ? tagIds : undefined,
        ...(!manual && {
          releaseDate: result.releaseDate ?? null,
          backdropUrl: result.backdropUrl ?? null,
          rating: result.rating ?? null,
          runtimeMinutes: result.runtimeMinutes ?? null,
          studio: result.studio ?? null,
          performers: result.performers ?? undefined,
          contentRating: result.contentRating ?? null,
          genres: result.genres ?? undefined,
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
      <div className="media-backdrop" style={backdropSrc ? { backgroundImage: `url(${backdropSrc})`, backgroundSize: "cover" } : undefined}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={{ width: 160, flexShrink: 0 }}>
            {posterSrc ? (
              <img src={posterSrc} alt="" style={{ width: "100%", borderRadius: 6 }} />
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
        <select
          id="addpreview-root-folder"
          value={rootFolderId}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : "";
            setRootFolderId(id);
            // The folder's own default quality profile, when it has one, is where the choice starts.
            const folderProfile = foldersForType.find((f) => f.id === id)?.defaultQualityProfileId;
            if (folderProfile && profiles.some((p) => p.id === folderProfile)) setQualityProfileId(folderProfile);
          }}
        >
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
            <select id="addpreview-monitor" value={monitorStrategy} onChange={(e) => setMonitorStrategy(e.target.value as MonitorStrategy | "")}>
              <option value="">Root folder default (All Episodes if none)</option>
              {ADD_MONITOR_STRATEGIES.map((key) => (
                <option key={key} value={key}>
                  {MONITOR_STRATEGY_LABELS[key]}
                </option>
              ))}
            </select>
          </>
        )}

        {activeTypeInfo?.shape === "collection" && (
          <>
            <label htmlFor="addpreview-collection-monitor">Monitor</label>
            <select id="addpreview-collection-monitor" value={collectionMonitor} onChange={(e) => setCollectionMonitor(e.target.value as CollectionMonitor | "")}>
              <option value="">Root folder default</option>
              {(Object.keys(COLLECTION_MONITOR_LABELS) as CollectionMonitor[]).map((key) => (
                <option key={key} value={key}>
                  {COLLECTION_MONITOR_LABELS[key]}
                </option>
              ))}
            </select>
          </>
        )}

        {(activeTypeInfo?.shape === "episodic" || activeTypeInfo?.shape === "collection") && (
          <>
            <label htmlFor="addpreview-monitor-new">Monitor new items</label>
            <select id="addpreview-monitor-new" value={monitorNewItems} onChange={(e) => setMonitorNewItems(e.target.value as NewItemMonitor)}>
              {(Object.keys(NEW_ITEM_LABELS) as NewItemMonitor[]).map((key) => (
                <option key={key || "default"} value={key}>
                  {NEW_ITEM_LABELS[key]}
                </option>
              ))}
            </select>
          </>
        )}

        {(type === "artist" || type === "author") && metadataProfiles.length > 0 && (
          <>
            <label htmlFor="addpreview-metadata-profile">Metadata profile</label>
            <select id="addpreview-metadata-profile" value={metadataProfileId} onChange={(e) => setMetadataProfileId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Root folder default</option>
              {metadataProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}

        {allTags.length > 0 && (
          <fieldset style={{ border: "none", padding: 0, margin: "8px 0" }}>
            <legend style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Tags</legend>
            {allTags.map((tag) => (
              <label key={tag.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={tagIds.includes(tag.id)}
                  onChange={(e) => setTagIds((prev) => (e.target.checked ? [...prev, tag.id] : prev.filter((id) => id !== tag.id)))}
                />
                {tag.name}
              </label>
            ))}
          </fieldset>
        )}

        <button type="button" onClick={() => doImport(false)} disabled={submitting || !title.trim()}>
          {submitting ? "Adding..." : "Add to library"}
        </button>
      </div>
    </div>
  );
}
