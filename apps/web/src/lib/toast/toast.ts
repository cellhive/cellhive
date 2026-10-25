import { createStore, useStore } from '../store';

/** `warning`: something needs a decision, e.g. an edit conflict (FRONTEND §4.1). */
export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  /** Already translated. */
  label: string;
  onClick: () => void;
  /** The recommended action, drawn as the primary button. */
  primary?: boolean;
}

/** A labelled value under the message, e.g. both sides of a conflict (FRONTEND §4.1). */
export interface ToastDetail {
  /** Already translated. */
  label: string;
  value: string;
}

export interface ToastInput {
  variant?: ToastVariant;
  /** Short heading above the message (already translated). */
  title?: string;
  /** Already translated text. With `error` and no `message`, the error is translated. */
  message?: string;
  /** Labelled values shown under the message. */
  details?: readonly ToastDetail[];
  /**
   * A failure to explain: translated by `code` (+ `errors[].code`) at render
   * time, with its `request_id` to copy (FRONTEND §8.1).
   */
  error?: unknown;
  /** Up to two buttons, e.g. "Keep their value" / "Write my value" of a conflict (FRONTEND §4.1). */
  actions?: readonly ToastAction[];
  /**
   * Auto-dismiss delay; `null` keeps the toast until dismissed. Default:
   * 5 s, except errors and toasts with actions, which stay (WCAG 2.2.1).
   */
  durationMs?: number | null;
  /** Progress of a background job, 0–1 (a bar under the message); `null` for none. */
  progress?: number | null;
}

export interface Toast extends Required<Pick<ToastInput, 'variant'>> {
  id: number;
  title: string | undefined;
  message: string | undefined;
  details: readonly ToastDetail[];
  error: unknown;
  actions: readonly ToastAction[];
  durationMs: number | null;
  progress: number | null;
}

/** Oldest toasts are dropped beyond this many. */
export const MAX_TOASTS = 5;
export const DEFAULT_TOAST_MS = 5000;

const store = createStore<readonly Toast[]>([]);
let nextId = 1;

function toastOf(id: number, input: ToastInput): Toast {
  const variant = input.variant ?? (input.error === undefined ? 'info' : 'error');
  const actions = input.actions ?? [];
  const sticky = variant === 'error' || actions.length > 0;
  return {
    id,
    variant,
    title: input.title,
    message: input.message,
    details: input.details ?? [],
    error: input.error,
    actions,
    durationMs:
      input.durationMs === undefined ? (sticky ? null : DEFAULT_TOAST_MS) : input.durationMs,
    progress: input.progress ?? null,
  };
}

/** Shows a toast; returns its id for `dismissToast`. */
export function showToast(input: ToastInput): number {
  const id = nextId++;
  const toast = toastOf(id, input);
  store.set((toasts) => [...toasts, toast].slice(-MAX_TOASTS));
  return id;
}

/**
 * Replaces the content of a toast still shown (job progress, then its
 * outcome); `false` when it was dismissed meanwhile.
 */
export function updateToast(id: number, input: ToastInput): boolean {
  let found = false;
  store.set((toasts) =>
    toasts.map((toast) => {
      if (toast.id !== id) return toast;
      found = true;
      return toastOf(id, input);
    }),
  );
  return found;
}

/** Shorthand for a failed request: translated message plus request ID. */
export function showErrorToast(error: unknown, input: Omit<ToastInput, 'error'> = {}): number {
  return showToast({ ...input, variant: 'error', error });
}

export function dismissToast(id: number): void {
  store.set((toasts) =>
    toasts.some((toast) => toast.id === id) ? toasts.filter((toast) => toast.id !== id) : toasts,
  );
}

export function clearToasts(): void {
  store.set([]);
}

export function useToasts(): readonly Toast[] {
  return useStore(store);
}
