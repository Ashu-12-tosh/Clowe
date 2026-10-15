// ---------------------------------------------------------------------------
// The one place every action reports back: "Saved", "Approved", or what went
// wrong. Callable from anywhere (no hook or provider needed); <Toaster />,
// mounted once in the root layout, shows the messages.
//
// Failed admin and seller requests are toasted by the API client itself
// (lib/api.ts), so an action that shows nothing on failure can't happen; a
// success message is the caller's `success` option, worded for its action.
// ---------------------------------------------------------------------------

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/** How long each kind stays: errors longer, so the reason can be read. */
export const TOAST_MS: Record<ToastKind, number> = { success: 4000, info: 5000, error: 8000 };
const MAX_SHOWN = 4;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

function push(kind: ToastKind, message: string): number {
  const text = message.trim() || (kind === 'error' ? 'Something went wrong' : 'Done');
  // A message already showing (a double click, a retry, a page repeating the
  // error the API client just reported) shows once, for longer.
  const same = items.find((t) => t.message === text);
  if (same) {
    schedule(same.id, same.kind);
    return same.id;
  }
  const id = nextId++;
  items = [...items, { id, kind, message: text }].slice(-MAX_SHOWN);
  schedule(id, kind);
  emit();
  return id;
}

function schedule(id: number, kind: ToastKind) {
  clearTimeout(timers.get(id));
  if (typeof window === 'undefined') return;
  timers.set(
    id,
    setTimeout(() => dismiss(id), TOAST_MS[kind]),
  );
}

function dismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const before = items.length;
  items = items.filter((t) => t.id !== id);
  if (items.length !== before) emit();
}

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
  dismiss,
};

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): ToastItem[] {
  return items;
}

/** For tests: forget every toast. */
export function clearToasts() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  items = [];
  emit();
}
