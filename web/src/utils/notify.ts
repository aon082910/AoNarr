export type ToastVariant = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(toasts);
}

function push(variant: ToastVariant, message: string, durationMs: number) {
  const id = nextId++;
  toasts = [...toasts, { id, variant, message }];
  emit();
  setTimeout(() => dismissToast(id), durationMs);
}

export const notify = {
  success: (message: string, durationMs = 4000) => push("success", message, durationMs),
  error: (message: string, durationMs = 6000) => push("error", message, durationMs),
  info: (message: string, durationMs = 4000) => push("info", message, durationMs),
};

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Subscribes to the current toast list, called immediately with the current value (same shape
 * every other imperative singleton in this app follows — see confirmDialog.ts). */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
