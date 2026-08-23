import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { HdrFormat, MediaInfo } from "../types.js";
import { formatMediaInfo } from "../utils/format.js";

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

const HDR_LABELS: Record<HdrFormat, string> = {
  none: "SDR",
  hdr10: "HDR10",
  hdr10plus: "HDR10+",
  hlg: "HLG",
  "dolby-vision": "Dolby Vision",
  "dolby-vision-hdr10": "Dolby Vision + HDR10",
  unknown: "Unknown",
};

function CountTable({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="form-panel" style={{ minWidth: 220 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <table style={{ margin: 0 }}>
        <tbody>
          {entries.map(([key, count]) => (
            <tr key={key}>
              <td>{key === "none" ? "SDR" : key}</td>
              <td style={{ textAlign: "right" }}>{count}</td>
            </tr>
          ))}
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
  const [running, setRunning] = useState(false);
  const [filterLevel, setFilterLevel] = useState<"all" | "caution" | "incompatible">("all");

  function load() {
    setLoading(true);
    const qs = type ? `?type=${type}` : "";
    api
      .get<AnalysisResponse>(`/media-analysis${qs}`)
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(load, [type]);

  async function runAnalysis() {
    setRunning(true);
    try {
      const qs = type ? `?type=${type}` : "";
      await api.post(`/media-analysis/run${qs}`, {});
      alert(
        "Analysis started in the background — this re-probes every file and can take a while for a large library. Check the Logs page for the result, or come back to this page shortly."
      );
    } finally {
      setTimeout(() => setRunning(false), 5000);
    }
  }

  if (loading && !data) return <p className="empty">Loading...</p>;

  const filteredItems = data?.items.filter((i) => filterLevel === "all" || i.compatibilityNotes.some((n) => n.level === filterLevel)) ?? [];

  return (
    <div>
      <h1>Media Analyzer</h1>
      <p style={{ color: "var(--muted)" }}>
        Read-only inspection of every file's actual codec, resolution, HDR/Dolby Vision signaling,
        audio tracks, and subtitle tracks — plus rule-based playback-compatibility notes for common
        hardware/software gotchas. Nothing here modifies or moves any file.
      </p>

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All libraries</option>
          {mediaTypes.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <button onClick={runAnalysis} disabled={running}>
          {running ? "Analyzing..." : "Analyze now"}
        </button>
      </div>

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
            <CountTable title="Video codec" counts={data.summary.byVideoCodec} />
            <CountTable title="HDR format" counts={data.summary.byHdrFormat} />
            <CountTable title="Audio codec" counts={data.summary.byAudioCodec} />
            <CountTable title="Resolution" counts={data.summary.byResolution} />
            <CountTable title="Subtitle languages" counts={data.summary.subtitleLanguages} />
          </div>

          <div className="toolbar" style={{ marginBottom: 10 }}>
            <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as typeof filterLevel)} style={{ maxWidth: 220 }}>
              <option value="all">All files ({data.items.length})</option>
              <option value="caution">With caution notes ({data.items.filter((i) => i.compatibilityNotes.some((n) => n.level === "caution")).length})</option>
              <option value="incompatible">
                With incompatible notes ({data.items.filter((i) => i.compatibilityNotes.some((n) => n.level === "incompatible")).length})
              </option>
            </select>
          </div>

          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>File info</th>
                <th>HDR</th>
                <th>Audio</th>
                <th>Subtitles</th>
                <th>Compatibility notes</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    Nothing to show.
                  </td>
                </tr>
              )}
              {filteredItems.map((item) => (
                <tr key={`${item.table}-${item.id}`}>
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
                      .map((a) => `${a.codec ?? "?"}${a.channels ? ` ${a.channels}ch` : ""}${a.language ? ` (${a.language})` : ""}`)
                      .join(", ") || "-"}
                  </td>
                  <td>
                    {(item.mediaInfo.subtitleStreams ?? []).length > 0
                      ? (item.mediaInfo.subtitleStreams ?? []).map((s) => s.language ?? s.codec ?? "?").join(", ")
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
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
