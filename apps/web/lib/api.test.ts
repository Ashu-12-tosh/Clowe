import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, RATE_LIMIT_RETRY_MS, TOO_MANY_REQUESTS } from './api';

const tooMany = () =>
  new Response(JSON.stringify({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS } }), { status: 429 });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('api() on a 429', () => {
  it('waits a moment and tries once more', async () => {
    fetchMock.mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok({ items: [1] }));
    const result = api<{ items: number[] }>('/api/home');
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ items: [1] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says "Too many requests" when the retry is refused too, and stops there', async () => {
    fetchMock.mockImplementation(async () => tooMany());
    const result = api('/api/orders/o1/cancel', { method: 'POST' });
    const caught = expect(result).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
    await caught;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 429 that is not JSON (a proxy page) reads the same, not "could not reach Clowe"', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>429 Too Many Requests</html>', { status: 429 }));
    const result = api('/api/categories');
    const caught = expect(result).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
    await caught;
  });

  it('does not retry other failures', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Nope' } }), { status: 404 }));
    await expect(api('/api/products/x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
