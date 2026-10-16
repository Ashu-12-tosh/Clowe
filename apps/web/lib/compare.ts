'use client';

import { useEffect, useState } from 'react';
import { COMPARE_MAX } from '@clowe/shared';

// The shopper's compare list: up to four product ids, kept in this browser.

const KEY = 'clowe_compare';
const EVENT = 'clowe:compare-changed';

export function readCompare(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, COMPARE_MAX) : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(0, COMPARE_MAX)));
  } catch {
    // private mode: the list lives for this page only
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Add or remove; false when the list is already full. */
export function toggleCompare(id: string): boolean {
  const ids = readCompare();
  if (ids.includes(id)) {
    write(ids.filter((x) => x !== id));
    return true;
  }
  if (ids.length >= COMPARE_MAX) return false;
  write([...ids, id]);
  return true;
}

export function clearCompare() {
  write([]);
}

export function useCompare(): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setIds(readCompare());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return ids;
}
