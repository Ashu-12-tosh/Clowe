'use client';

import { useCallback, useState } from 'react';
import { ApiRequestError } from './api';

// ---------------------------------------------------------------------------
// Errors that belong to one input are shown next to it (<FieldError />), and
// the page scrolls to the first. An input is found by its `data-field` or
// `name` attribute, matching the key used here — the same key the API names
// in a validation error (`error.field`, e.g. "gstNumber").
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;

/** The input for a name; for a nested one ("variantAxes.0.label") the nearest named parent. */
function fieldElement(name: string): HTMLElement | null {
  for (let parts = name.split('.'); parts.length > 0; parts = parts.slice(0, -1)) {
    const key = CSS.escape(parts.join('.'));
    const el = document.querySelector<HTMLElement>(`[data-field="${key}"], [name="${key}"]`);
    if (el) return el;
  }
  return null;
}

/** The message for an input, including one about something inside it ("variantAxes.0.label" for "variantAxes"). */
export function fieldError(errors: FieldErrors, name: string): string | undefined {
  if (errors[name]) return errors[name];
  const nested = Object.keys(errors).find((k) => k.startsWith(`${name}.`));
  return nested ? errors[nested] : undefined;
}

/** Of these inputs, the one highest on the page (the first named if none is found). */
function firstOnPage(names: string[]): string {
  const found = names
    .map((name) => ({ name, el: fieldElement(name) }))
    .filter((f): f is { name: string; el: HTMLElement } => !!f.el)
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return found[0]?.name ?? names[0]!;
}

/** Schema issues (zod's `error.issues`) as one message per input, keyed by its path. */
export function issuesToFieldErrors(issues: { path: PropertyKey[]; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    if (key && !(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

/** Bring an input into view and put the cursor in it. */
export function scrollToField(name: string) {
  const el = fieldElement(name);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const input = el.matches('input, select, textarea, button')
    ? el
    : el.querySelector<HTMLElement>('input, select, textarea, button');
  input?.focus({ preventScroll: true });
}

export function useFieldErrors() {
  const [errors, setErrors] = useState<FieldErrors>({});

  /** Show these errors and scroll to the first on the page; false when there are none. */
  const show = useCallback((next: FieldErrors): boolean => {
    setErrors(next);
    const names = Object.keys(next);
    if (names.length === 0) return false;
    // After React has painted the messages, so the page doesn't jump twice.
    requestAnimationFrame(() => scrollToField(firstOnPage(names)));
    return true;
  }, []);

  /** A validation error the API pinned to one input; false when it names none. */
  const fromError = useCallback(
    (err: unknown): boolean => {
      if (!(err instanceof ApiRequestError) || !err.field) return false;
      // "gstNumber: Invalid GSTIN" → "Invalid GSTIN": the input already says what it is.
      const message = err.message.startsWith(`${err.field}: `) ? err.message.slice(err.field.length + 2) : err.message;
      return show({ [err.field]: message });
    },
    [show],
  );

  const clear = useCallback((name?: string) => {
    setErrors((prev) => {
      if (name === undefined) return Object.keys(prev).length ? {} : prev;
      if (!(name in prev)) return prev;
      const { [name]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  return { errors, show, fromError, clear };
}
