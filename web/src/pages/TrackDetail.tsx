import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";

interface TrackDetailResponse {
  id: number;
  subItemId: number;
  trackNumber: number;
  title: string;
  durationSeconds: number | null;
  hasFile: 0 | 1;
  filePath: string | null;
  subItem: { id: number; title: string } | null;
  parent: { id: number; title: string; type: string } | null;
}

export default function TrackDetail() {
  const { mediaId, subItemId, trackId } = useParams<{ mediaId: string; subItemId: string; trackId: string }>();
  const navigate = useNavigate();
  const [track, setTrack] = useState<TrackDetailResponse | null>(null);

  useEffect(() => {
    api.get<TrackDetailResponse>(`/media/${mediaId}/subitems/${subItemId}/tracks/${trackId}`).then(setTrack);
  }, [mediaId, subItemId, trackId]);

  if (!track) return <p className="empty">Loading...</p>;

  const duration = track.durationSeconds
    ? `${Math.floor(track.durationSeconds / 60)}:${String(track.durationSeconds % 60).padStart(2, "0")}`
    : "-";

  return (
    <div>
      <p style={{ color: "var(--muted)" }}>
        {track.parent && <Link to={`/media/${track.parent.id}`}>{track.parent.title}</Link>}
        {track.parent && track.subItem && " / "}
        {track.subItem && <Link to={`/media/${mediaId}/item/${subItemId}`}>{track.subItem.title}</Link>}
      </p>
      <h1>
        {track.trackNumber}. {track.title}
      </h1>

      <table style={{ maxWidth: 640 }}>
        <tbody>
          <tr>
            <th>Duration</th>
            <td>{duration}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              <span className={`badge ${track.hasFile ? "ok" : ""}`}>{track.hasFile ? "Downloaded" : "Missing"}</span>
            </td>
          </tr>
          {track.filePath && (
            <tr>
              <th>Path</th>
              <td style={{ wordBreak: "break-all" }}>{track.filePath}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={() => navigate(-1)}>
          Back to {track.subItem?.title ?? "album"}
        </button>
      </div>
    </div>
  );
}
