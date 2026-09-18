export interface PromptField {
  key: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface PromptRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  fields?: PromptField[];
}

export interface PendingPrompt {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  fields: PromptField[];
  resolve: (values: Record<string, string> | null) => void;
}

type Listener = (pending: PendingPrompt | null) => void;

let current: PendingPrompt | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(current);
}

/** Promise-based replacement for the browser's native prompt() — resolves the typed string, or
 * `null` if cancelled (same null-vs-string contract prompt() itself has, so callers keep their
 * existing `if (x === null) return;` guards unchanged). Pass `fields` (2+ labeled inputs) instead
 * of `label`/`defaultValue` for what used to be two chained prompt() calls (e.g. a name then a
 * follow-up question) — one richer dialog instead, resolving `Record<string, string> | null`. */
export function promptDialog(request: PromptRequest & { label: string; fields?: undefined }): Promise<string | null>;
export function promptDialog(request: PromptRequest & { fields: PromptField[] }): Promise<Record<string, string> | null>;
export function promptDialog(request: PromptRequest): Promise<unknown> {
  const multiField = Array.isArray(request.fields);
  const fields: PromptField[] = multiField
    ? request.fields!
    : [
        {
          key: "value",
          label: request.label!,
          defaultValue: request.defaultValue,
          placeholder: request.placeholder,
        },
      ];
  return new Promise((resolve) => {
    current = {
      title: request.title,
      message: request.message,
      confirmLabel: request.confirmLabel,
      cancelLabel: request.cancelLabel,
      fields,
      resolve: (values) => {
        current = null;
        emit();
        resolve(multiField ? values : values ? values.value : null);
      },
    };
    emit();
  });
}

export function subscribePrompt(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
