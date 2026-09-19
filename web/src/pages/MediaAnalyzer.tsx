import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadFile } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { HdrFormat, MediaInfo } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";
import { SearchIcon, DownloadIcon, ZapIcon } from "../components/NavIcons.js";
import { ArrowRightIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";
import Pagination, { DEFAULT_PAGE_SIZE_OPTIONS } from "../components/Pagination.js";
import { notify } from "../utils/notify.js";

interface CompatibilityNote {
  level: "ok" | "caution" | "incompatible";
  message: string;
}

interface AnalysisSummary {
  totalFiles: number;
  filesWithoutMediaInfo: number;
  byVideoCodec: Record<string, number>;
  byHdrFormat: Record<string, number>;
  byAudioCodec: Record<string, number>;
  byResolution: Record<string, number>;
  subtitleLanguages: Record<string, number>;
  spokenLanguages: Record<string, number>;
}

type StatCategory = "videoCodec" | "hdrFormat" | "audioCodec" | "resolution" | "subtitleLanguage" | "spokenLanguage";

interface StatFilter {
  category: StatCategory;
  value: string;
}

const STAT_LABELS: Record<StatCategory, string> = {
  videoCodec: "Video codec",
  hdrFormat: "HDR format",
  audioCodec: "Audio codec",
  resolution: "Resolution",
  subtitleLanguage: "Subtitle language",
  spokenLanguage: "Spoken language",
};

/** Mirrors server/src/services/mediaAnalysis.ts's normalizeLanguage() exactly — a raw embedded
 * language tag can be 2-letter ("en"), 3-letter ("eng"/"deu"/"ger" — muxers aren't consistent
 * about bibliographic vs. terminology ISO 639-2 forms), or missing/"und". Intl.DisplayNames
 * (built into every modern browser, no dependency) resolves all of those to the same canonical
 * name, which is what fixes "English"/"en"/"eng" showing up as three separate rows — and is used
 * here too so a stat-table click (grouped server-side) matches the same items client-side. */
const languageDisplayNames = new Intl.DisplayNames(["en"], { type: "language" });
function normalizeLanguage(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "und" || trimmed === "unk" || trimmed === "n/a" || trimmed === "null") return "Unknown";
  try {
    const resolved = languageDisplayNames.of(trimmed);
    if (!resolved || resolved.toLowerCase() === trimmed) return trimmed.toUpperCase();
    return resolved;
  } catch {
    return trimmed.toUpperCase();
  }
}

/** Mirrors server/src/services/mediaAnalysis.ts's resolutionTier() exactly — see that function's
 * comment for why the long edge (not raw height) drives the HD/UHD classification. */
function resolutionTier(width: number | null | undefined, height: number | null | undefined): string {
  if (!width || !height) return "Unknown";
  const long = Math.max(width, height);
  if (long >= 3200) return "2160p (4K)";
  if (long >= 1600) return "1080p";
  if (long >= 960) return "720p";
  const short = Math.min(width, height);
  if (short >= 500) return "576p";
  if (short >= 400) return "480p";
  return "SD";
}

/** A click on a count table row needs to reproduce that same grouping key client-side to find the
 * matching items, since there's no server round-trip for this (every item is already in `data.items`). */
function matchesStatFilter(item: AnalysisItem, filter: StatFilter): boolean {
  switch (filter.category) {
    case "videoCodec":
      return (item.mediaInfo.videoCodec ?? "unknown") === filter.value;
    case "hdrFormat":
      return (item.mediaInfo.hdrFormat ?? "unknown") === filter.value;
    case "audioCodec":
      return (item.mediaInfo.audioStreams ?? []).some((a) => (a.codec ?? "unknown") === filter.value);
    case "resolution":
      return resolutionTier(item.mediaInfo.width, item.mediaInfo.height) === filter.value;
    case "subtitleLanguage":
      return (item.mediaInfo.subtitleStreams ?? []).some((s) => normalizeLanguage(s.language) === filter.value);
    case "spokenLanguage":
      return (item.mediaInfo.audioStreams ?? []).some((a) => normalizeLanguage(a.language) === filter.value);
    default:
      return true;
  }
}

interface AnalysisItem {
  id: number;
  table: "media_items" | "episodes" | "sub_items";
  mediaItemId: number;
  title: string;
  type: string;
  path: string;
  mediaInfo: MediaInfo;
  compatibilityNotes: CompatibilityNote[];
}

interface AnalysisResponse {
  summary: AnalysisSummary;
  items: AnalysisItem[];
  truncated: boolean;
}

interface AnalysisProgress {
  running: boolean;
  type: string | null;
  total: number;
  done: number;
  failed: number;
  startedAt: number | null;
  finishedAt: number | null;
}

const HDR_LABELS: Record<HdrFormat, string> = {
  none: "SDR",
  hdr10: "HDR10",
  hdr10plus: "HDR10+",
  hlg: "HLG",
  "dolby-vision": "Dolby Vision",
  "dolby-vision-hdr10": "Dolby Vision + HDR10",
  unknown: "Unknown",
};

function itemKey(item: AnalysisItem): string {
  return `${item.table}-${item.id}`;
}

function toSearchTarget(item: AnalysisItem) {
  return {
    mediaItemId: item.mediaItemId,
    episodeId: item.table === "episodes" ? item.id : undefined,
    subItemId: item.table === "sub_items" ? item.id : undefined,
  };
}

const BULK_SEARCH_CHUNK = 100;

function CountTable({
  title,
  counts,
  category,
  activeValue,
  onSelect,
}: {
  title: string;
  counts: Record<string, number>;
  category: StatCategory;
  activeValue: string | null;
  onSelect: (category: StatCategory, value: string) => void;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="form-panel" style={{ minWidth: 220 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <table style={{ margin: 0 }}>
        <tbody>
          {entries.map(([key, count]) => {
            const active = activeValue === key;
            return (
              <tr
                key={key}
                onClick={() => onSelect(category, key)}
                title={`Show every file with ${title.toLowerCase()} "${key === "none" ? "SDR" : key}"`}
                style={{ cursor: "pointer", background: active ? "var(--panel-2, rgba(255,255,255,0.08))" : undefined }}
              >
                <td>{key === "none" ? "SDR" : key}</td>
                <td style={{ textAlign: "right" }}>{count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function MediaAnalyzer() {
  const mediaTypes = useMediaTypes();
  const [type, setType] = useState<string>("");
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [filterLevel, setFilterLevel] = useState<"all" | "caution" | "incompatible">("all");
  const [statFilter, setStatFilter] = useState<StatFilter | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem("aonarr_media_analyzer_page_size")) || 60);
  const { sortRows, sortableHeader } = useSortableTable<AnalysisItem, "title">("title");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function load() {
    setLoading(true);
    setStatFilter(null);
    setSelected(new Set());
    setLoadError(null);
    // Cleared up front, not just on success — otherwise a failed reload after switching type kept
    // showing the previous type's stats/file list with no indication it's stale/wrong-type data.
    setData(null);
    const qs = type ? `?type=${type}` : "";
    api
      .get<AnalysisResponse>(`/media-analysis${qs}`)
      .then(setData)
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  }

  /** Clicking the same row again clears the filter instead of re-applying it — a quick "toggle off". */
  function selectStat(category: StatCategory, value: string) {
    setStatFilter((prev) => (prev && prev.category === category && prev.value === value ? null : { category, value }));
    setPage(1);
  }

  useEffect(load, [type]);
  useEffect(() => setPage(1), [filterLevel, statFilter]);
  useEffect(() => {
    localStorage.setItem("aonarr_media_analyzer_page_size", String(pageSize));
  }, [pageSize]);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function pollProgress() {
    api
      .get<AnalysisProgress>("/media-analysis/progress")
      .then((p) => {
        setProgress(p);
        if (!p.running) {
          stopPolling();
          notify.success(`Analysis finished — ${p.done - p.failed} probed${p.failed > 0 ? `, ${p.failed} failed` : ""}.`);
          load();
        }
      })
      .catch(() => stopPolling());
  }

  // Picks up an already-running analysis (e.g. started from this page in another tab, or just
  // before a page refresh) instead of only ever noticing a run this page itself started.
  useEffect(() => {
    api
      .get<AnalysisProgress>("/media-analysis/progress")
      .then((p) => {
        if (p.running) {
          setProgress(p);
          pollRef.current = setInterval(pollProgress, 1200);
        }
      })
      .catch(() => {});
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAnalysis() {
    const qs = type ? `?type=${type}` : "";
    const result = await api.post<{ started: boolean; reason?: string }>(`/media-analysis/run${qs}`, {});
    if (!result.started) {
      notify.info("An analysis run is already in progress — showing its live progress.");
    }
    setProgress({ running: true, type: type || null, total: 0, done: 0, failed: 0, startedAt: Date.now(), finishedAt: null });
    stopPolling();
    pollRef.current = setInterval(pollProgress, 1200);
  }

  async function searchItems(targets: AnalysisItem[]) {
    setSearching(true);
    try {
      let grabbed = 0;
      for (let i = 0; i < targets.length; i += BULK_SEARCH_CHUNK) {
        const chunk = targets.slice(i, i + BULK_SEARCH_CHUNK);
        const results = await api.post<{ grabbed: boolean; error?: string }[]>("/search/bulk", {
          targets: chunk.map(toSearchTarget),
        });
        grabbed += results.filter((r) => r.grabbed).length;
      }
      notify.success(`Grabbed ${grabbed} of ${targets.length} item(s).`);
    } finally {
      setSearching(false);
    }
  }

  function toggleSelect(item: AnalysisItem) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (loading && !data) return <p className="empty">Loading...</p>;

  const filteredItems = sortRows(
    data?.items.filter((i) => {
      if (filterLevel !== "all" && !i.compatibilityNotes.some((n) => n.level === filterLevel)) return false;
      if (statFilter && !matchesStatFilter(i, statFilter)) return false;
      return true;
    }) ?? [],
    (a, b) => a.title.localeCompare(b.title)
  );
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const pageItems = filteredItems.slice((page - 1) * pageSize, page * pageSize);
  const pageAllSelected = pageItems.length > 0 && pageItems.every((i) => selected.has(itemKey(i)));

  function toggleSelectPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) pageItems.forEach((i) => next.delete(itemKey(i)));
      else pageItems.forEach((i) => next.add(itemKey(i)));
      return next;
    });
  }

  return (
    <div>
      <h1>Media Analyzer</h1>
      <p style={{ color: "var(--muted)" }}>
        Read-only inspection of every file's actual codec, resolution, HDR/Dolby Vision signaling,
        audio tracks, and subtitle tracks — plus rule-based playback-compatibility notes for common
        hardware/software gotchas. Nothing here modifies or moves any file, other than "Search" —
        which behaves exactly like Cutoff Unmet's own re-search action.
      </p>

      <PageToolbar
        left={
          <ToolbarButton
            icon={<ZapIcon />}
            label={progress?.running ? "Analyzing..." : "Analyze Now"}
            onClick={runAnalysis}
            disabled={!!progress?.running}
            title={progress?.running ? "Analyzing..." : "Analyze now"}
          />
        }
        right={
          <>
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
              <option value="">All libraries</option>
              {mediaTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <ToolbarButton
              icon={<DownloadIcon />}
              label="Export CSV"
              onClick={() => downloadFile(`/media-analysis/export.csv${type ? `?type=${type}` : ""}`, `aonarr-media-analysis${type ? `-${type}` : ""}.csv`)}
              disabled={!data || data.items.length === 0}
              title="Export the current analysis as CSV"
            />
          </>
        }
      />

      {progress?.running && (
        <div className="form-panel" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: "0.85rem", color: "var(--muted)" }}>
            <span>
              Analyzing {progress.type ?? "all libraries"}
              {progress.total > 0 ? ` — ${progress.done} of ${progress.total} probed` : "…"}
              {progress.failed > 0 ? ` (${progress.failed} failed)` : ""}
            </span>
            {progress.total > 0 && <span>{Math.round((progress.done / progress.total) * 100)}%</span>}
          </div>
          <div className="progress-bar" style={{ width: "100%" }}>
            <div style={{ width: progress.total > 0 ? `${Math.round((progress.done / progress.total) * 100)}%` : "3%" }} />
          </div>
        </div>
      )}

      {loadError && <p style={{ color: "var(--danger)" }}>{loadError}</p>}

      {data && (
        <>
          <p>
            <span className="badge ok">{data.summary.totalFiles - data.summary.filesWithoutMediaInfo} analyzed</span>{" "}
            {data.summary.filesWithoutMediaInfo > 0 && (
              <span className="badge" title="Imported before this feature existed, or ffprobe couldn't read them yet">
                {data.summary.filesWithoutMediaInfo} not yet analyzed
              </span>
            )}
            {data.truncated && (
              <span className="badge danger" style={{ marginLeft: 6 }}>
                showing first 2000 items — summary above still covers everything
              </span>
            )}
          </p>

          {data.summary.filesWithoutMediaInfo > 0 && (
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              Click "Analyze now" to probe the {data.summary.filesWithoutMediaInfo} file(s) above with
              the full HDR/Dolby Vision/audio/subtitle-aware analyzer.
            </p>
          )}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <CountTable
              title="Video codec"
              counts={data.summary.byVideoCodec}
              category="videoCodec"
              activeValue={statFilter?.category === "videoCodec" ? statFilter.value : null}
              onSelect={selectStat}
            />
            <CountTable
              title="HDR format"
              counts={data.summary.byHdrFormat}
              category="hdrFormat"
              activeValue={statFilter?.category === "hdrFormat" ? statFilter.value : null}
              onSelect={selectStat}
            />
            <CountTable
              title="Audio codec"
              counts={data.summary.byAudioCodec}
              category="audioCodec"
              activeValue={statFilter?.category === "audioCodec" ? statFilter.value : null}
              onSelect={selectStat}
            />
            <CountTable
              title="Resolution"
              counts={data.summary.byResolution}
              category="resolution"
              activeValue={statFilter?.category === "resolution" ? statFilter.value : null}
              onSelect={selectStat}
            />
            <CountTable
              title="Subtitle languages"
              counts={data.summary.subtitleLanguages}
              category="subtitleLanguage"
              activeValue={statFilter?.category === "subtitleLanguage" ? statFilter.value : null}
              onSelect={selectStat}
            />
            <CountTable
              title="Spoken languages"
              counts={data.summary.spokenLanguages}
              category="spokenLanguage"
              activeValue={statFilter?.category === "spokenLanguage" ? statFilter.value : null}
              onSelect={selectStat}
            />
          </div>

          {statFilter && (
            <p style={{ color: "var(--muted)" }}>
              Filtered to files where {STAT_LABELS[statFilter.category].toLowerCase()} is{" "}
              <strong>{statFilter.value === "none" ? "SDR" : statFilter.value}</strong> ({filteredItems.length} of {data.items.length}){" "}
              <button type="button" className="secondary" onClick={() => setStatFilter(null)}>
                Clear
              </button>
            </p>
          )}

          <div className="toolbar" style={{ marginBottom: 10 }}>
            <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as typeof filterLevel)} style={{ maxWidth: 220 }}>
              <option value="all">All files ({data.items.length})</option>
              <option value="caution">With caution notes ({data.items.filter((i) => i.compatibilityNotes.some((n) => n.level === "caution")).length})</option>
              <option value="incompatible">
                With incompatible notes ({data.items.filter((i) => i.compatibilityNotes.some((n) => n.level === "incompatible")).length})
              </option>
            </select>
          </div>

          {selected.size > 0 && (
            <div className="form-panel" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <strong>{selected.size} selected</strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => searchItems(filteredItems.filter((i) => selected.has(itemKey(i))))}
                disabled={searching}
                title={searching ? "Searching..." : "Search selected"}
                aria-label="Search selected"
              >
                <SearchIcon />
              </button>
              <button type="button" className="secondary" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </div>
          )}

          {filteredItems.length > 1 && (
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <ToolbarButton
                icon={<SearchIcon />}
                label={searching ? "Searching..." : `Search All (${filteredItems.length})`}
                onClick={() => searchItems(filteredItems)}
                disabled={searching}
                title="Search every file currently shown (respects the filters above)"
              />
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={pageAllSelected} onChange={toggleSelectPage} title="Select all on this page" aria-label="Select all on this page" />
                </th>
                {sortableHeader("title", "Title")}
                <th>File info</th>
                <th>HDR</th>
                <th>Audio</th>
                <th>Subtitles</th>
                <th>Compatibility notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    Nothing to show.
                  </td>
                </tr>
              )}
              {pageItems.map((item) => (
                <tr key={itemKey(item)}>
                  <td>
                    <input type="checkbox" checked={selected.has(itemKey(item))} onChange={() => toggleSelect(item)} />
                  </td>
                  <td>
                    <Link to={`/media/${item.mediaItemId}`}>{item.title}</Link>
                  </td>
                  <td>{formatMediaInfo(item.mediaInfo) ?? "-"}</td>
                  <td>
                    <span className={`badge ${item.mediaInfo.hdrFormat && item.mediaInfo.hdrFormat !== "none" ? "ok" : ""}`}>
                      {HDR_LABELS[item.mediaInfo.hdrFormat ?? "unknown"]}
                    </span>
                  </td>
                  <td>
                    {(item.mediaInfo.audioStreams ?? [])
                      .map((a) => `${a.codec ?? "?"}${a.channels ? ` ${a.channels}ch` : ""}${a.language ? ` (${normalizeLanguage(a.language)})` : ""}`)
                      .join(", ") || "-"}
                  </td>
                  <td>
                    {(item.mediaInfo.subtitleStreams ?? []).length > 0
                      ? (item.mediaInfo.subtitleStreams ?? []).map((s) => (s.language ? normalizeLanguage(s.language) : s.codec ?? "?")).join(", ")
                      : "-"}
                  </td>
                  <td>
                    {item.compatibilityNotes.length === 0 && <span style={{ color: "var(--muted)" }}>-</span>}
                    {item.compatibilityNotes.map((n, idx) => (
                      <div key={idx} style={{ marginBottom: 4 }}>
                        <span className={`badge ${n.level === "ok" ? "ok" : n.level === "incompatible" ? "danger" : ""}`}>{n.level}</span>{" "}
                        <span style={{ fontSize: "0.8rem" }}>{n.message}</span>
                      </div>
                    ))}
                  </td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => searchItems([item])}
                      disabled={searching}
                      title="Search for a better release"
                      aria-label="Search for a better release"
                    >
                      <SearchIcon />
                    </button>
                    <Link to={`/media/${item.mediaItemId}`}>
                      <button type="button" className="icon-button" title="Open" aria-label="Open">
                        <ArrowRightIcon />
                      </button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination
            page={page}
            totalPages={totalPages}
            total={filteredItems.length}
            pageSize={pageSize}
            hasPrev={page > 1}
            hasNext={page < totalPages}
            onPrev={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
            pageSizeOptions={DEFAULT_PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  );
}
