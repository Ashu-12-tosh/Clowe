import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastList } from '../components/Toaster';
import { api, ApiRequestError } from './api';
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

describe('outside the admin and seller panels', () => {
  it('leaves failures to the page (the storefront shows its own)', async () => {
    onPage('/cart');
    vi.stubGlobal('fetch', respond(400, { success: false, error: { code: 'OUT_OF_STOCK', message: 'Only 2 left' } }));
    await expect(api('/api/cart/items', { body: { variantId: 'v1', quantity: 3 }, auth: true })).rejects.toThrow('Only 2 left');
    expect(getToasts()).toEqual([]);
  });
});
