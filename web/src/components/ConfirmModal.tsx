import { useEffect, useState } from "react";
import Modal from "./Modal.js";
import { subscribeConfirm, type PendingConfirm } from "../utils/confirmDialog.js";

/** Mounted once near the app root (see App.tsx) — renders whatever confirmDialog.ts's singleton
 * pending request currently holds, on top of the shared Modal shell (focus trap, Escape-to-close,
 * dialog stacking all come for free from Modal). Replaces this app's former use of the browser's
 * native confirm(). */
export default function ConfirmModal() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [values, setValues] = useState<Record<string, boolean>>({});

  useEffect(
    () =>
      subscribeConfirm((next) => {
        setPending(next);
        setValues(Object.fromEntries((next?.options ?? []).map((o) => [o.key, !!o.defaultChecked])));
      }),
    []
  );

  if (!pending) return null;

  function respond(confirmed: boolean) {
    pending!.resolve({ confirmed, values });
  }

  return (
    <Modal title={pending.title} onClose={() => respond(false)} maxWidth={440}>
      <p style={{ marginTop: 0, whiteSpace: "pre-line" }}>{pending.message}</p>
      {pending.options?.map((o) => (
        <label key={o.key} style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0", cursor: "pointer" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={!!values[o.key]}
            onChange={(e) => setValues((v) => ({ ...v, [o.key]: e.target.checked }))}
          />
          {o.label}
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
        <button type="button" className={pending.danger ? "danger" : ""} onClick={() => respond(true)}>
          {pending.confirmLabel ?? "Confirm"}
        </button>
        <button type="button" className="secondary" onClick={() => respond(false)}>
          {pending.cancelLabel ?? "Cancel"}
        </button>
      </div>
    </Modal>
  );
}
