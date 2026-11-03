import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { QualityProfile, RootFolder, Tag } from "../types.js";
import { PlusCircleIcon, RotateCcwIcon } from "../components/NavIcons.js";
import { TrashIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";
import { formatServerTimestamp } from "../utils/format.js";
import { notify } from "../utils/notify.js";

interface ImportList {
  id: number;
  name: string;
  type: "trakt" | "imdb" | "lastfm" | "tmdb";
  url: string;
  enabled: 0 | 1;
  quality_profile_id: number | null;
  root_folder_id: number | null;
  require_review: 0 | 1;
  last_synced_at: string | null;
  last_added_count: number | null;
  last_error: string | null;
  min_rating: number | null;
  min_votes: number | null;
  exclude_genres: string | null; // JSON array
  monitor: string;
  monitor_new_items: string | null;
  search_on_add: 0 | 1;
  minimum_availability: string | null;
  clean_level: string;
  tag_ids: string | null; // JSON array
}

/** What a list monitors of what it adds. A movie only tells "All" and "None" apart; the rest narrow a show's episodes or an artist's albums. */
function monitorChoices(type: ImportList["type"]): { value: string; label: string }[] {
  const common = [
    { value: "all", label: "All" },
    { value: "future", label: "Future only" },
  ];
  const tail = [{ value: "none", label: "None (catalogue only)" }];
  return type === "lastfm"
    ? [...common, { value: "first", label: "First album" }, { value: "latest", label: "Latest album" }, ...tail]
    : [...common, { value: "firstSeason", label: "First season" }, { value: "latestSeason", label: "Latest season" }, { value: "pilot", label: "Pilot only" }, ...tail];
}

const NEW_ITEM_CHOICES = [
  { value: "", label: "Default" },
  { value: "all", label: "Monitor all new" },
  { value: "new", label: "Only newer than existing" },
  { value: "none", label: "Do not monitor new" },
];

const AVAILABILITY_CHOICES = [
  { value: "", label: "Instance default" },
  { value: "announced", label: "Announced" },
  { value: "inCinemas", label: "In cinemas" },
  { value: "released", label: "Released" },
];

const CLEAN_CHOICES = [
  { value: "disabled", label: "Do nothing" },
  { value: "logOnly", label: "Log only" },
  { value: "keepAndUnmonitor", label: "Keep and unmonitor" },
  { value: "removeAndKeep", label: "Remove, keep files" },
  { value: "removeAndDelete", label: "Remove and delete files" },
];

/** A Last.fm list is the top 50 of a ranking, so what slips out of it is never removed. */
function cleanChoices(type: ImportList["type"]) {
  return type === "lastfm" ? CLEAN_CHOICES.filter((c) => c.value !== "removeAndKeep" && c.value !== "removeAndDelete") : CLEAN_CHOICES;
}

function parseTagIds(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(Number) : [];
  } catch {
    return [];
  }
}

/** Last.fm's top-artists endpoint has no rating/vote/genre data to filter on — these fields are a
 * no-op for that type either way (services/importLists.ts's passesListFilters never rejects on
 * data an entry doesn't have), but hiding them for lastfm avoids implying they do something. */
function listSupportsFilters(type: ImportList["type"]): boolean {
  return type !== "lastfm";
}

function parseGenresList(json: string | null): string {
  if (!json) return "";
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.join(", ") : "";
  } catch {
    return "";
  }
}

const TYPE_LABELS: Record<ImportList["type"], string> = { trakt: "Trakt", imdb: "IMDb", lastfm: "Last.fm", tmdb: "TMDB" };
/** The media types each type of list adds items of (services/importLists.ts's IMPORT_LIST_MEDIA_TYPES). */
const LIST_MEDIA_TYPES: Record<ImportList["type"], string[]> = { trakt: ["movie", "series"], imdb: ["movie", "series"], tmdb: ["movie", "series"], lastfm: ["artist"] };
const AUTO_ROOT_FOLDER_LABEL = "Auto — the type's root folder with the most free space";
const FOLDER_TYPE_LABELS: Record<string, string> = { movie: "Movies", series: "Shows", artist: "Music" };

function folderLabel(folder: RootFolder): string {
  const name = folder.name ? `${folder.name} — ${folder.path}` : folder.path;
  return `${name} (${FOLDER_TYPE_LABELS[folder.mediaType] ?? folder.mediaType})`;
}

/** A list's last result, stored in last_error: a sync that added some items and skipped others
 * reads "Added N; ...", with N its last_added_count, and is a warning rather than a failure. */
function isPartialSyncWarning(list: ImportList): boolean {
  return list.last_added_count != null && !!list.last_error?.startsWith(`Added ${list.last_added_count}; `);
}

const URL_PLACEHOLDERS: Record<ImportList["type"], string> = {
  trakt: "https://trakt.tv/users/you/lists/to-watch (or .../watchlist)",
  imdb: "https://www.imdb.com/list/ls123456789/",
  lastfm: "https://www.last.fm/user/yourname (or just a username)",
  tmdb: "https://www.themoviedb.org/list/8290123 (or just the numeric list id)",
};

export default function ImportLists() {
  const [lists, setLists] = useState<ImportList[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const { sortRows: sortLists, sortableHeader: listHeader } = useSortableTable<ImportList, "name" | "type" | "enabled" | "lastSynced">("name");
  const [profiles, setProfiles] = useState<QualityProfile[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<ImportList["type"]>("trakt");
  const [url, setUrl] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState<number | "">("");
  const [rootFolders, setRootFolders] = useState<RootFolder[]>([]);
  const [rootFolderId, setRootFolderId] = useState<number | "">("");
  const [requireReview, setRequireReview] = useState(false);
  const [minRating, setMinRating] = useState("");
  const [minVotes, setMinVotes] = useState("");
  const [excludeGenres, setExcludeGenres] = useState("");
  const [monitor, setMonitor] = useState("all");
  const [monitorNewItems, setMonitorNewItems] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(false);
  const [minimumAvailability, setMinimumAvailability] = useState("");
  const [cleanLevel, setCleanLevel] = useState("disabled");
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewCounts, setReviewCounts] = useState<Record<number, number>>({});

  function load() {
    api.get<ImportList[]>("/import-lists").then(setLists);
    api.get<{ importListId: number; count: number }[]>("/import-review/counts").then((rows) => {
      setReviewCounts(Object.fromEntries(rows.map((r) => [r.importListId, r.count])));
    });
  }
  useEffect(() => {
    load();
    api.get<QualityProfile[]>("/quality-profiles").then((p) => {
      setProfiles(p);
      if (p.length > 0) setQualityProfileId(p[0].id);
    });
    api.get<RootFolder[]>("/root-folders").then(setRootFolders);
    api.get<Tag[]>("/tags").then(setAllTags).catch(() => undefined);
  }, []);

  function foldersFor(listType: ImportList["type"]): RootFolder[] {
    return rootFolders.filter((f) => LIST_MEDIA_TYPES[listType].includes(f.mediaType));
  }

  function changeType(next: ImportList["type"]) {
    setType(next);
    // The choices differ between lists of artists and of movies and shows.
    if (!monitorChoices(next).some((c) => c.value === monitor)) setMonitor("all");
    if (!cleanChoices(next).some((c) => c.value === cleanLevel)) setCleanLevel("disabled");
    // A folder of a type the new list doesn't add would only be refused by the server.
    if (rootFolderId !== "" && !foldersFor(next).some((f) => f.id === rootFolderId)) setRootFolderId("");
  }

  async function addList(e: FormEvent) {
    e.preventDefault();
    if (!name || !url) return;
    try {
      await api.post("/import-lists", {
        name,
        type,
        url,
        qualityProfileId: qualityProfileId || null,
        rootFolderId: rootFolderId === "" ? null : rootFolderId,
        requireReview,
        minRating: minRating || null,
        minVotes: minVotes || null,
        excludeGenres: excludeGenres || null,
        monitor,
        monitorNewItems: monitorNewItems || null,
        searchOnAdd,
        minimumAvailability: minimumAvailability || null,
        cleanLevel,
        tagIds,
      });
    } catch (err) {
      // Refused (a root folder removed meanwhile, say): the form stays open to fix it.
      notify.error((err as Error).message);
      return;
    }
    setName("");
    setUrl("");
    setRootFolderId("");
    setMinRating("");
    setMinVotes("");
    setExcludeGenres("");
    setMonitor("all");
    setMonitorNewItems("");
    setSearchOnAdd(false);
    setMinimumAvailability("");
    setCleanLevel("disabled");
    setTagIds([]);
    setShowAdd(false);
    load();
  }

  async function saveFilter(list: ImportList, field: "minRating" | "minVotes" | "excludeGenres", value: string) {
    await api.patch(`/import-lists/${list.id}`, { [field]: value || null });
    load();
  }

  async function saveField(list: ImportList, field: "name" | "url", value: string) {
    if (!value.trim() || value === list[field]) return;
    await api.patch(`/import-lists/${list.id}`, { [field]: value.trim() });
    load();
  }

  async function saveRootFolder(list: ImportList, value: string) {
    setError(null);
    try {
      await api.patch(`/import-lists/${list.id}`, { rootFolderId: value ? Number(value) : null });
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  async function saveOption(list: ImportList, patch: Record<string, unknown>) {
    setError(null);
    try {
      await api.patch(`/import-lists/${list.id}`, patch);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  async function toggleEnabled(list: ImportList) {
    await api.patch(`/import-lists/${list.id}`, { enabled: !list.enabled });
    load();
  }

  async function toggleRequireReview(list: ImportList) {
    await api.patch(`/import-lists/${list.id}`, { requireReview: !list.require_review });
    load();
  }

  async function removeList(id: number) {
    await api.del(`/import-lists/${id}`);
    load();
  }

  async function syncNow(id: number) {
    setSyncingId(id);
    setError(null);
    try {
      const result = await api.post<{ added: number; error?: string; warning?: string }>(`/import-lists/${id}/sync`, {});
      if (result.error) setError(result.error);
      else if (result.warning) notify.info(`Added ${result.added} item(s); ${result.warning}`, 8000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncingId(null);
      load();
    }
  }

  return (
    <div>
      <h1>Import Lists</h1>
      <p style={{ color: "var(--muted)" }}>
        Recurring "auto-add anything new here" sources — re-checked on the same schedule as
        auto-search, so anything new on the list gets added to your library automatically. Trakt,
        IMDb, and TMDB lists add movies/shows (TMDB needs an API key set under Settings →
        Metadata); a Last.fm profile adds its all-time top artists to Music (Last.fm has no
        user-playlist concept of its own, so top artists is the closest equivalent).
      </p>

      <PageToolbar left={<ToolbarButton icon={<PlusCircleIcon />} label="Add" onClick={() => setShowAdd(true)} title="Add import list" />} />

      {showAdd && (
        <Modal title="Add Import List" onClose={() => setShowAdd(false)}>
          <form className="form-panel" onSubmit={addList} style={{ padding: 0 }}>
            <label htmlFor="importlists-name-1">Name</label>
            <input id="importlists-name-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="My watchlist" required />
            <label htmlFor="importlists-type-2">Type</label>
            <select id="importlists-type-2" value={type} onChange={(e) => changeType(e.target.value as ImportList["type"])}>
              <option value="trakt">Trakt</option>
              <option value="imdb">IMDb</option>
              <option value="lastfm">Last.fm</option>
              <option value="tmdb">TMDB</option>
            </select>
            <label htmlFor="importlists-url-3">URL</label>
            <input id="importlists-url-3" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_PLACEHOLDERS[type]} required />
            {profiles.length > 0 && (
              <>
                <label htmlFor="importlists-quality-profile-4">Quality profile</label>
                <select id="importlists-quality-profile-4" value={qualityProfileId} onChange={(e) => setQualityProfileId(e.target.value ? Number(e.target.value) : "")}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <label htmlFor="importlists-root-folder-8">Root folder</label>
            <select id="importlists-root-folder-8" value={rootFolderId} onChange={(e) => setRootFolderId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{AUTO_ROOT_FOLDER_LABEL}</option>
              {foldersFor(type).map((f) => (
                <option key={f.id} value={f.id}>
                  {folderLabel(f)}
                </option>
              ))}
            </select>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
              Where this list's items are added. A list of movies and shows uses a movie folder for its
              movies only, and picks automatically for its shows (or the other way round).
            </p>
            {listSupportsFilters(type) && (
              <>
                <label htmlFor="importlists-minimum-rating-0-10-optional-5">Minimum rating (0-10, optional)</label>
                <input id="importlists-minimum-rating-0-10-optional-5"
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={minRating}
                  onChange={(e) => setMinRating(e.target.value)}
                  placeholder="No minimum"
                />
                <label htmlFor="importlists-minimum-vote-count-optional-6">Minimum vote count (optional)</label>
                <input id="importlists-minimum-vote-count-optional-6" type="number" min="0" value={minVotes} onChange={(e) => setMinVotes(e.target.value)} placeholder="No minimum" />
                <label htmlFor="importlists-exclude-genres-comma-separated-optional-7">Exclude genres (comma-separated, optional)</label>
                <input id="importlists-exclude-genres-comma-separated-optional-7" value={excludeGenres} onChange={(e) => setExcludeGenres(e.target.value)} placeholder="e.g. Horror, Documentary" />
                <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                  A list still adds everything it has by default — these narrow it down. Skipped for an
                  item whose rating/votes/genres aren't known, rather than excluding it over missing
                  data.
                </p>
              </>
            )}
            <label htmlFor="importlists-monitor">Monitor</label>
            <select id="importlists-monitor" value={monitor} onChange={(e) => setMonitor(e.target.value)}>
              {monitorChoices(type).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <label htmlFor="importlists-monitor-new">Monitor new items</label>
            <select id="importlists-monitor-new" value={monitorNewItems} onChange={(e) => setMonitorNewItems(e.target.value)}>
              {NEW_ITEM_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {type !== "lastfm" && (
              <>
                <label htmlFor="importlists-availability">Minimum availability</label>
                <select id="importlists-availability" value={minimumAvailability} onChange={(e) => setMinimumAvailability(e.target.value)}>
                  {AVAILABILITY_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            <label className="toolbar" style={{ gap: 8 }}>
              <input type="checkbox" checked={searchOnAdd} onChange={(e) => setSearchOnAdd(e.target.checked)} style={{ width: "auto" }} />
              Search as soon as an item is added
            </label>
            <label htmlFor="importlists-clean">When an item leaves the list</label>
            <select id="importlists-clean" value={cleanLevel} onChange={(e) => setCleanLevel(e.target.value)}>
              {cleanChoices(type).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
              Only items this list added are cleaned, never a protected one, and nothing is cleaned after a sync that read
              nothing or would remove most of the list at once.
            </p>
            {allTags.length > 0 && (
              <fieldset style={{ border: "none", padding: 0, margin: "8px 0" }}>
                <legend style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Tags for what it adds</legend>
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
            <label className="toolbar" style={{ gap: 8 }}>
              <input type="checkbox" checked={requireReview} onChange={(e) => setRequireReview(e.target.checked)} style={{ width: "auto" }} />
              Require review before adding
            </label>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
              When on, a match found on this list is queued on the Import Review page instead of being
              added to your library automatically — approve or dismiss each one by hand.
            </p>
            <button type="submit">Add import list</button>
          </form>
        </Modal>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {lists.length === 0 && <p className="empty">No import lists configured yet.</p>}
      {lists.length > 0 && (
        <table>
          <thead>
            <tr>
              {listHeader("name", "Name")}
              {listHeader("type", "Type")}
              <th>URL</th>
              <th>Root folder</th>
              {listHeader("enabled", "Enabled")}
              <th>Review before add</th>
              <th>Options</th>
              <th>Filters</th>
              {listHeader("lastSynced", "Last synced")}
              <th>Last result</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sortLists(lists, (a, b, key) => {
              if (key === "name") return a.name.localeCompare(b.name);
              if (key === "type") return a.type.localeCompare(b.type);
              if (key === "enabled") return a.enabled - b.enabled;
              return (a.last_synced_at ?? "").localeCompare(b.last_synced_at ?? "");
            }).map((l) => (
              <tr key={l.id}>
                <td>
                  <input
                    key={`${l.id}-name-${l.name}`}
                    defaultValue={l.name}
                    onBlur={(e) => saveField(l, "name", e.target.value)}
                    style={{ fontSize: "0.85rem", minWidth: 120 }}
                  />
                </td>
                <td>{TYPE_LABELS[l.type]}</td>
                <td>
                  <input
                    key={`${l.id}-url-${l.url}`}
                    defaultValue={l.url}
                    onBlur={(e) => saveField(l, "url", e.target.value)}
                    title={l.url}
                    style={{ fontSize: "0.8rem", minWidth: 160 }}
                  />
                </td>
                <td>
                  <select
                    value={l.root_folder_id ?? ""}
                    onChange={(e) => saveRootFolder(l, e.target.value)}
                    title="Where this list's items are added"
                    aria-label="Root folder"
                    style={{ fontSize: "0.8rem", minWidth: 120 }}
                  >
                    <option value="">Auto</option>
                    {foldersFor(l.type).map((f) => (
                      <option key={f.id} value={f.id}>
                        {folderLabel(f)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="checkbox" checked={!!l.enabled} onChange={() => toggleEnabled(l)} />
                </td>
                <td>
                  <input type="checkbox" checked={!!l.require_review} onChange={() => toggleRequireReview(l)} />
                </td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 170, fontSize: "0.8rem" }}>
                    <select value={l.monitor} onChange={(e) => saveOption(l, { monitor: e.target.value })} title="Monitor" aria-label="Monitor" style={{ fontSize: "0.8rem" }}>
                      {monitorChoices(l.type).map((c) => (
                        <option key={c.value} value={c.value}>
                          Monitor: {c.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={l.monitor_new_items ?? ""}
                      onChange={(e) => saveOption(l, { monitorNewItems: e.target.value || null })}
                      title="Monitor new items"
                      aria-label="Monitor new items"
                      style={{ fontSize: "0.8rem" }}
                    >
                      {NEW_ITEM_CHOICES.map((c) => (
                        <option key={c.value} value={c.value}>
                          New items: {c.label}
                        </option>
                      ))}
                    </select>
                    {l.type !== "lastfm" && (
                      <select
                        value={l.minimum_availability ?? ""}
                        onChange={(e) => saveOption(l, { minimumAvailability: e.target.value || null })}
                        title="Minimum availability"
                        aria-label="Minimum availability"
                        style={{ fontSize: "0.8rem" }}
                      >
                        {AVAILABILITY_CHOICES.map((c) => (
                          <option key={c.value} value={c.value}>
                            Available: {c.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={!!l.search_on_add} onChange={(e) => saveOption(l, { searchOnAdd: e.target.checked })} style={{ width: "auto" }} />
                      Search on add
                    </label>
                    <select value={l.clean_level} onChange={(e) => saveOption(l, { cleanLevel: e.target.value })} title="When an item leaves the list" aria-label="Clean level" style={{ fontSize: "0.8rem" }}>
                      {cleanChoices(l.type).map((c) => (
                        <option key={c.value} value={c.value}>
                          Leaves list: {c.label}
                        </option>
                      ))}
                    </select>
                    {allTags.length > 0 && (
                      <div>
                        {allTags.map((tag) => {
                          const chosen = parseTagIds(l.tag_ids);
                          return (
                            <label key={tag.id} style={{ display: "inline-flex", alignItems: "center", gap: 3, marginRight: 8 }}>
                              <input
                                type="checkbox"
                                checked={chosen.includes(tag.id)}
                                onChange={(e) => saveOption(l, { tagIds: e.target.checked ? [...chosen, tag.id] : chosen.filter((id) => id !== tag.id) })}
                                style={{ width: "auto" }}
                              />
                              {tag.name}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </td>
                <td>
                  {listSupportsFilters(l.type) ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
                      <input
                        key={`${l.id}-rating-${l.min_rating}`}
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        defaultValue={l.min_rating ?? ""}
                        placeholder="Min rating"
                        title="Minimum rating (0-10)"
                        onBlur={(e) => saveFilter(l, "minRating", e.target.value)}
                        style={{ fontSize: "0.8rem" }}
                      />
                      <input
                        key={`${l.id}-votes-${l.min_votes}`}
                        type="number"
                        min="0"
                        defaultValue={l.min_votes ?? ""}
                        placeholder="Min votes"
                        title="Minimum vote count"
                        onBlur={(e) => saveFilter(l, "minVotes", e.target.value)}
                        style={{ fontSize: "0.8rem" }}
                      />
                      <input
                        key={`${l.id}-genres-${l.exclude_genres}`}
                        defaultValue={parseGenresList(l.exclude_genres)}
                        placeholder="Exclude genres"
                        title="Comma-separated genres to exclude"
                        onBlur={(e) => saveFilter(l, "excludeGenres", e.target.value)}
                        style={{ fontSize: "0.8rem" }}
                      />
                    </div>
                  ) : (
                    <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>N/A</span>
                  )}
                </td>
                <td>{l.last_synced_at ? formatServerTimestamp(l.last_synced_at) : "Never"}</td>
                <td>
                  {l.last_error ? (
                    <span style={{ color: isPartialSyncWarning(l) ? "#e0b03c" : "var(--danger)" }}>
                      {l.last_error}
                    </span>
                  ) : l.last_added_count != null ? (
                    `+${l.last_added_count}`
                  ) : (
                    ""
                  )}
                  {reviewCounts[l.id] > 0 && (
                    <>
                      {" "}
                      <Link to="/import-review" className="badge" title="Titles that couldn't be confidently matched — review them manually">
                        {reviewCounts[l.id]} {reviewCounts[l.id] === 1 ? "needs" : "need"} review
                      </Link>
                    </>
                  )}
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="icon-button" onClick={() => syncNow(l.id)} disabled={syncingId === l.id} title={syncingId === l.id ? "Syncing..." : "Sync now"} aria-label="Sync now">
                    <RotateCcwIcon />
                  </button>
                  <button type="button" className="icon-button danger" onClick={() => removeList(l.id)} title="Delete" aria-label="Delete">
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
