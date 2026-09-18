import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { ArrowLeftIcon, FolderIcon } from "../components/ActionIcons.js";
import { ClockIcon } from "../components/NavIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";

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

      <PageToolbar
        left={<ToolbarButton icon={<ArrowLeftIcon />} label="Back" onClick={() => navigate(-1)} title={`Back to ${track.subItem?.title ?? "album"}`} />}
      />

      <div className="detail-pills">
        <span className="pill">
          <ClockIcon />
          {duration}
        </span>
        <span className={`badge ${track.hasFile ? "ok" : ""}`}>{track.hasFile ? "Downloaded" : "Missing"}</span>
        {track.filePath && (
          <span className="pill" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>
            <FolderIcon />
            {track.filePath}
          </span>
        )}
      </div>
    </div>
  );
}
