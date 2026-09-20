import { useEffect, useState } from "react";
import Modal from "./Modal.js";
import { subscribePrompt, type PendingPrompt } from "../utils/promptDialog.js";

/** Mounted once near the app root (see App.tsx) — renders whatever promptDialog.ts's singleton
 * pending request currently holds, on the shared Modal shell. Replaces this app's former use of
 * the browser's native prompt(). */
export default function PromptModal() {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(
    () =>
      subscribePrompt((next) => {
        setPending(next);
        setValues(Object.fromEntries((next?.fields ?? []).map((f) => [f.key, f.defaultValue ?? ""])));
      }),
    []
  );

  if (!pending) return null;

  return (
    <Modal title={pending.title} onClose={() => pending.resolve(null)} maxWidth={440} zIndex={1100}>
      {pending.message && <p style={{ marginTop: 0 }}>{pending.message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          pending.resolve(values);
        }}
      >
        {pending.fields.map((f, idx) => (
          <div key={f.key}>
            <label htmlFor={`promptmodal-${f.key}`}>{f.label}</label>
            <input
              id={`promptmodal-${f.key}`}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              autoFocus={idx === 0}
            />
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button type="submit">{pending.confirmLabel ?? "OK"}</button>
          <button type="button" className="secondary" onClick={() => pending.resolve(null)}>
            {pending.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
