'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Which actions are waiting on the server, by key (a row id, "save", "approve:<id>"…),
 * so the button that started one shows it and can't start it again. `run` ignores
 * a key that is already running: a double click sends one request.
 */
export function usePending() {
  const running = useRef(new Set<string>());
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());

  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current.has(key)) return undefined;
    running.current.add(key);
    setKeys(new Set(running.current));
    try {
      return await fn();
    } finally {
      running.current.delete(key);
      setKeys(new Set(running.current));
    }
  }, []);

  const isPending = useCallback((key: string) => keys.has(key), [keys]);

  return { run, isPending, anyPending: keys.size > 0 };
}
