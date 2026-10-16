import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastList } from '../components/Toaster';
import { api, ApiRequestError, RATE_LIMIT_RETRY_MS, TOO_MANY_REQUESTS } from './api';
import { clearToasts, getToasts } from './toast';

// The API client in a browser-like setting: an admin page, a stored session,
// and a fetch that answers as the API would.

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

function onPage(pathname: string) {
  vi.stubGlobal('window', { location: { pathname } });
}

beforeEach(() => {
  const store = new Map<string, string>([['clowe.accessToken', 'token']]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  onPage('/admin/settings');
  clearToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('a failed save', () => {
  it('shows its error message, with the reason the API gave', async () => {
    const reason = 'gstUniformPercent: Number must be less than or equal to 40';
    vi.stubGlobal(
      'fetch',
      respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: reason, field: 'gstUniformPercent' } }),
    );

    const saving = api('/api/admin/settings', { method: 'PUT', body: { gstUniformPercent: 99 }, auth: true, success: 'Settings saved' });
    const err = await saving.catch((e: unknown) => e);

    // The caller learns which field it was, to mark it.
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', field: 'gstUniformPercent', message: reason });
    // And the page shows it: an error toast with the reason, and no "Saved".
    expect(getToasts()).toEqual([expect.objectContaining({ kind: 'error', message: reason })]);
    const html = renderToStaticMarkup(<ToastList items={getToasts()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(reason);
    expect(html).not.toContain('Settings saved');
  });

  it('says so when the server is unreachable or answers with an error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api('/api/admin/banners', { body: { headline: 'Sale' }, auth: true })).rejects.toThrow(/Could not reach Clowe/);

    vi.stubGlobal('fetch', respond(502, '<html>Bad gateway</html>'));
    await expect(api('/api/admin/banners', { body: { headline: 'Sale!' }, auth: true })).rejects.toThrow(/HTTP 502/);

    expect(getToasts().map((t) => [t.kind, t.message])).toEqual([
      ['error', 'Could not reach Clowe — check your connection and try again'],
      ['error', 'The server did not answer properly (HTTP 502) — try again in a minute'],
    ]);
  });

  it('is left to the caller when it asks for quiet', async () => {
    vi.stubGlobal('fetch', respond(400, { success: false, error: { code: 'KYC_WARNINGS_UNACKNOWLEDGED', message: 'PAN name mismatch' } }));
    await expect(api('/api/admin/sellers/s1/status', { method: 'PATCH', body: { action: 'approve' }, auth: true, quiet: true })).rejects.toThrow();
    expect(getToasts()).toEqual([]);
  });
});

describe('a successful save', () => {
  it('shows the message the action asked for', async () => {
    vi.stubGlobal('fetch', respond(200, { success: true, data: { ok: true } }));
    await api('/api/admin/settings', { method: 'PUT', body: {}, auth: true, success: 'Settings saved' });
    expect(getToasts()).toEqual([expect.objectContaining({ kind: 'success', message: 'Settings saved' })]);
  });
});

describe('a double click', () => {
  it('sends the change once', async () => {
    let release!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ success: true, data: { id: 'b1' } }), { status: 200 }));
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const first = api('/api/admin/sellers/s1/status', { method: 'PATCH', body: { action: 'approve' }, auth: true, success: 'Seller approved' });
    const second = api('/api/admin/sellers/s1/status', { method: 'PATCH', body: { action: 'approve' }, auth: true, success: 'Seller approved' });
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ id: 'b1' }, { id: 'b1' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(1);
  });
});

describe('a busy moment (429)', () => {
  const tooMany = () => new Response(JSON.stringify({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS } }), { status: 429 });
  const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits a moment and tries once more', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok({ items: [1] }));
    vi.stubGlobal('fetch', fetch);
    const loading = api<{ items: number[] }>('/api/home');
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(loading).resolves.toEqual({ items: [1] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getToasts()).toEqual([]);
  });

  it('says "Too many requests" when the retry is refused too, and stops there', async () => {
    const fetch = vi.fn(async () => tooMany());
    vi.stubGlobal('fetch', fetch);
    const saving = api('/api/admin/banners', { body: { headline: 'Sale' }, auth: true });
    const refused = expect(saving).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
    await refused;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getToasts()).toEqual([expect.objectContaining({ kind: 'error', message: TOO_MANY_REQUESTS })]);
  });

  it('reads the same when a proxy answers the 429 with a page, not "Could not reach Clowe"', async () => {
    vi.stubGlobal('fetch', respond(429, '<html>429 Too Many Requests</html>'));
    const loading = api('/api/categories');
    const refused = expect(loading).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
    await refused;
  });

  it('does not retry other failures', async () => {
    const fetch = respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Nope' } });
    vi.stubGlobal('fetch', fetch);
    await expect(api('/api/products/x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('outside the admin and seller panels', () => {
  it('leaves failures to the page (the storefront shows its own)', async () => {
    onPage('/cart');
    vi.stubGlobal('fetch', respond(400, { success: false, error: { code: 'OUT_OF_STOCK', message: 'Only 2 left' } }));
    await expect(api('/api/cart/items', { body: { variantId: 'v1', quantity: 3 }, auth: true })).rejects.toThrow('Only 2 left');
    expect(getToasts()).toEqual([]);
  });
});
