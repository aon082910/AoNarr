export interface ConfirmOption {
  key: string;
  label: string;
  defaultChecked?: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  options?: ConfirmOption[];
}

export interface ConfirmResult {
  confirmed: boolean;
  values: Record<string, boolean>;
}

export interface PendingConfirm extends ConfirmRequest {
  resolve: (result: ConfirmResult) => void;
}

type Listener = (pending: PendingConfirm | null) => void;

let current: PendingConfirm | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(current);
}

/** Promise-based replacement for the browser's native confirm() — resolves `true`/`false` for a
 * plain yes/no dialog. Pass `options` (checkboxes, e.g. "delete files"/"add exclusion") for a
 * richer Sonarr/Radarr-style dialog instead of chaining several native confirm() calls; that form
 * resolves the checked values, or `null` if cancelled. Rendered by the singleton `ConfirmModal`
 * component mounted once near the app root (see App.tsx). */
export function confirmDialog(request: ConfirmRequest & { options?: undefined }): Promise<boolean>;
export function confirmDialog(
  request: ConfirmRequest & { options: ConfirmOption[] }
): Promise<{ confirmed: boolean; values: Record<string, boolean> } | null>;
export function confirmDialog(request: ConfirmRequest): Promise<unknown> {
  return new Promise((resolve) => {
    current = {
      ...request,
      resolve: (result) => {
        current = null;
        emit();
        resolve(request.options ? (result.confirmed ? result : null) : result.confirmed);
      },
    };
    emit();
  });
}

export function subscribeConfirm(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
