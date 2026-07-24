'use client';

import { useEffect, useState } from 'react';
import type { HealthResponse } from '@clowe/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Status = 'loading' | 'ok' | 'error';

/** Pings the backend health endpoint so we can see the full stack is wired up. */
export default function ApiStatus() {
  const [status, setStatus] = useState<Status>('loading');
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((res) => res.json())
      .then((json) => {
        setHealth(json.data as HealthResponse);
        setStatus('ok');
      })
      .catch(() => setStatus('error'));
  }, []);

  if (status === 'loading') {
    return <p className="text-sm text-gray-500">Checking API…</p>;
  }

  if (status === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <span className="font-semibold">API unreachable.</span> Start it with{' '}
        <code className="rounded bg-red-100 px-1">npm run dev:api</code>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
      <p>
        <span className="font-semibold">API connected</span> — service{' '}
        <code className="rounded bg-green-100 px-1">{health?.service}</code> v{health?.version}
      </p>
      <p className="mt-1">
        Database:{' '}
        <span className={health?.database === 'up' ? 'font-semibold' : 'font-semibold text-red-600'}>
          {health?.database === 'up' ? 'connected' : 'down — run npm run db:up'}
        </span>
      </p>
    </div>
  );
}
