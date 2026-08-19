import { type ReactNode } from "react";

/** Shared popup shell — dark overlay + centered panel. Used by every "Add X" flow that used to be
 * an always-visible inline form at the top of its list page (Starr-app style: a button opens
 * this instead). */
export default function Modal({
  title,
  onClose,
  children,
  maxWidth = 480,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="form-panel"
        style={{ maxWidth, width: "90%", maxHeight: "80vh", overflowY: "auto", position: "relative" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="secondary" onClick={onClose} style={{ padding: "2px 10px" }}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
