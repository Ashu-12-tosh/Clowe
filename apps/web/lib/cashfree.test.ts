import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Attack on Batch 1 (2026-10-30, agent C): a payment check whose request hung
// left the return page's spinner up for minutes, and "Check again" sent
// nothing — it joined the hung request.

const store = new Map<string, string>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  // A connection that never answers: the request ends only when it is aborted.
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('confirmPayment', () => {
  it('gives up on a hung request after its time limit, as a connection problem', async () => {
    const { confirmPayment, CONFIRM_TIMEOUT_MS } = await import('./cashfree');
    const asked = confirmPayment('ORDER', 'order-1', { attempts: 1 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 10);
    const err = (await asked) as { code?: string };
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('is cancelled by its caller at once, so a new check can really be sent', async () => {
    const { confirmPayment } = await import('./cashfree');
    const controller = new AbortController();
    const asked = confirmPayment('ORDER', 'order-2', { attempts: 1, signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const err = await asked;
    expect(err).toBeInstanceOf(DOMException);
    // The next ask is a new request, not joined to the cancelled one.
    void confirmPayment('ORDER', 'order-2', { attempts: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
