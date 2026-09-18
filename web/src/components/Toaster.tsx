import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts, type ToastItem } from "../utils/notify.js";
import { XIcon } from "./ActionIcons.js";

/** Mounted once near the app root (see App.tsx) — renders whatever notify.ts's singleton list
 * currently holds. Sonarr/Radarr-style stacked, auto-dismissing toasts, replacing this app's
 * former use of the browser's native alert(). */
export default function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.variant}`} role="status">
          <span className="toast-message">{t.message}</span>
          <button type="button" className="icon-button" onClick={() => dismissToast(t.id)} title="Dismiss" aria-label="Dismiss">
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
