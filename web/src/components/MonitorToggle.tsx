/**
 * Sonarr/Radarr-style monitored toggle: a small bookmark-ribbon icon, filled when monitored and
 * outline when not, clickable directly inside a table row without navigating it — the same
 * affordance Sonarr's season/episode list uses instead of making you open the episode just to
 * flip one flag. `stopPropagation` matters here since every caller renders this inside a
 * click-to-navigate `<tr onClick=...>`.
 */
export default function MonitorToggle({
  monitored,
  onToggle,
  title,
}: {
  monitored: boolean;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={title ?? (monitored ? "Monitored — click to unmonitor" : "Unmonitored — click to monitor")}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        color: monitored ? "var(--accent)" : "var(--muted)",
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M6 3a2 2 0 0 0-2 2v16l8-5 8 5V5a2 2 0 0 0-2-2H6z"
          fill={monitored ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
