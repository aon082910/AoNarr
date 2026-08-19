import { Link, useParams } from "react-router-dom";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { LibraryItemGrid } from "./LibraryType.js";

/** Items of a grouped type (ROMs/Adult/Online Videos/Courses) that haven't been filed under a
 * group yet — reachable from the type's top-level group-browse page. */
export default function LibraryUngrouped() {
  const { type = "" } = useParams<{ type: string }>();
  const mediaTypes = useMediaTypes();
  const typeInfo = mediaTypes.find((t) => t.key === type);
  if (!typeInfo) return <p className="empty">Loading...</p>;

  return (
    <div>
      <p>
        <Link to={`/library/${type}`}>← Back to {typeInfo.label}</Link>
      </p>
      <LibraryItemGrid type={type} typeLabel={`${typeInfo.label} — Ungrouped`} groupId="none" groupDetail={null} />
    </div>
  );
}
