import { Link, useParams } from "react-router-dom";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { LibraryItemGrid } from "./LibraryType.js";

/** A flat, filterable view of an entire grouped-type library (currently ROMs only) — the tile
 * System -> Maker browsing tree narrows to one group at a time, with nowhere to filter "every item
 * under System X across all its Makers"; this page exists specifically for that (see LibraryType's
 * System filter dropdown, gated on `groupId === undefined`, which only renders here). */
export default function LibraryAll() {
  const { type = "" } = useParams<{ type: string }>();
  const mediaTypes = useMediaTypes();
  const typeInfo = mediaTypes.find((t) => t.key === type);
  if (!typeInfo) return <p className="empty">Loading...</p>;

  return (
    <div>
      <p>
        <Link to={`/library/${type}`}>← Back to {typeInfo.label}</Link>
      </p>
      <LibraryItemGrid type={type} typeLabel={`${typeInfo.label} — All`} groupId={undefined} groupDetail={null} />
    </div>
  );
}
