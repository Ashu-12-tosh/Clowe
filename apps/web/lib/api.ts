'use client';

import type { AuthTokensResponse, AuthUser, UploadableImagePurpose, UploadedAsset } from '@clowe/shared';
import { toast } from './toast';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const ACCESS_KEY = 'clowe.accessToken';
const LEGACY_REFRESH_KEY = 'clowe.refreshToken'; // pre-cookie sessions only
const USER_KEY = 'clowe.user';

// --- Session storage ---
// The refresh token lives in an httpOnly cookie set by the API (never
// readable by JS). Locally we keep only the short-lived access token + user.

export function saveSession(data: AuthTokensResponse) {
  localStorage.setItem(ACCESS_KEY, data.accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

export function clearSession() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Overwrite the cached user (e.g. after a profile update). */
export function setStoredUser(user: AuthUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser(): AuthUser | null {
  const raw = typeof window !== 'undefined' ? localStorage.getItem(USER_KEY) : null;
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}

/**
 * Rotate the session via the httpOnly refresh cookie (older sessions fall
 * back to their stored token once, migrating them onto the cookie).
 * Returns the fresh user, or null when the session can't be renewed.
 */
export async function refreshSession(): Promise<AuthUser | null> {
  try {
    const legacyToken = localStorage.getItem(LEGACY_REFRESH_KEY);
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyToken ? { refreshToken: legacyToken } : {}),
    });
    const json = await res.json();
    if (!json.success) return null;
    saveSession(json.data as AuthTokensResponse);
    return (json.data as AuthTokensResponse).user;
  } catch {
    return null;
  }
}

/** Logout on this device: revoke the cookie session + clear local state. */
export async function logoutSession(): Promise<void> {
  try {
    const legacyToken = localStorage.getItem(LEGACY_REFRESH_KEY);
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyToken ? { refreshToken: legacyToken } : {}),
    });
  } catch {
    // Local logout still proceeds if the API is unreachable.
  }
  clearSession();
}

/** POST a multipart form; a failure is reported like any other action. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  try {
    const token = localStorage.getItem(ACCESS_KEY);
    const { json } = await send(`${API_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    if (!json.success) throw errorFrom(json, 'Upload failed');
    return json.data as T;
  } catch (err) {
    reportFailure(err, {});
    throw err;
  }
}

/** Upload images (multipart) and get back their public URLs. */
export async function uploadImages(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) form.append('images', file);
  return (await upload<{ urls: string[] }>('/api/uploads', form)).urls;
}

/**
 * Upload personal photos (a return's damage photos, a try-on photo). They are
 * stored privately: each comes back as a reference to submit and a URL that
 * previews it for a few minutes.
 */
export async function uploadPrivateImages(files: File[], purpose: UploadableImagePurpose): Promise<UploadedAsset[]> {
  const form = new FormData();
  form.append('purpose', purpose);
  for (const file of files) form.append('images', file);
  return (await upload<{ items: UploadedAsset[] }>('/api/uploads/private', form)).items;
}

/** Upload one packing video (multipart): a reference to submit, and a URL to preview it. */
export async function uploadVideo(file: File): Promise<UploadedAsset> {
  const form = new FormData();
  form.append('video', file);
  return upload<UploadedAsset>('/api/uploads/video', form);
}

// --- Fetch helper with the standard { success, data, error } envelope ---

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** The input a validation error is about (e.g. "gstNumber"), when the API names one. */
    public readonly field?: string,
  ) {
    super(message);
  }
}

/** Options every request accepts. `signal` lets a caller cancel a stale one. */
export interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  /** Abort an in-flight request — type-ahead uses this so an older reply
      cannot land after a newer one and repaint with stale results. */
  signal?: AbortSignal;
  /** Toasted when a change succeeds, worded for the action: "Saved", "Approved"… */
  success?: string;
  /** Don't toast a failure: the caller shows it in place (next to a field, say).
      Failed changes made from admin and seller pages are toasted otherwise. */
  quiet?: boolean;
}

/** fetch, with a dropped connection or a non-JSON reply (a proxy's error page) turned into a readable error. */
async function send(url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('NETWORK_ERROR', 'Could not reach Clowe — check your connection and try again');
  }
  try {
    return { res, json: await res.json() };
  } catch {
    throw new ApiRequestError(
      'BAD_RESPONSE',
      `The server did not answer properly (HTTP ${res.status}) — try again in a minute`,
    );
  }
}

function errorFrom(json: { error?: { code?: string; message?: string; field?: string } }, fallback: string) {
  return new ApiRequestError(json.error?.code ?? 'UNKNOWN', json.error?.message ?? fallback, json.error?.field);
}

/** Changes made from the admin and seller panels report every failure. */
function reportFailure(err: unknown, options: ApiOptions) {
  if (options.quiet || typeof window === 'undefined') return;
  if (err instanceof DOMException && err.name === 'AbortError') return;
  if (!/^\/(admin|seller)(\/|$)/.test(window.location.pathname)) return;
  toast.error(err instanceof Error ? err.message : 'Something went wrong');
}

async function rawRequest(path: string, options: ApiOptions) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth) {
    const token = localStorage.getItem(ACCESS_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return send(`${API_URL}${path}`, {
    method: methodOf(options),
    credentials: 'include',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}

const methodOf = (options: ApiOptions) => options.method ?? (options.body ? 'POST' : 'GET');

async function request<T>(path: string, options: ApiOptions): Promise<T> {
  let { res, json } = await rawRequest(path, options);

  // Access token expired? Silently rotate via the refresh cookie and retry
  // once — active users never see a login screen.
  if (!json.success && res.status === 401 && options.auth && !path.startsWith('/api/auth/')) {
    const renewed = await refreshSession();
    if (renewed) {
      ({ res, json } = await rawRequest(path, options));
    }
  }

  if (!json.success) throw errorFrom(json, 'Something went wrong');
  return json.data as T;
}

/** Changes still on their way to the server, so a double click can't send one twice. */
const inFlight = new Map<string, Promise<unknown>>();

export function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = methodOf(options);
  if (method === 'GET') return request<T>(path, options);

  // The same change while the first is still running joins it instead of
  // being sent again: one request, one message.
  const key = `${method} ${path} ${JSON.stringify(options.body ?? null)}`;
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const sent = request<T>(path, options)
    .then(
      (data) => {
        if (options.success) toast.success(options.success);
        return data;
      },
      (err: unknown) => {
        reportFailure(err, options);
        throw err;
      },
    )
    .finally(() => inFlight.delete(key));
  inFlight.set(key, sent);
  return sent;
}

/**
 * Download an authenticated file response (e.g. the try-on CSV export) and
 * hand it to the browser as a save dialog.
 */
export function downloadFile(path: string, filename: string): Promise<void> {
  // A second click while the first is still downloading joins it.
  const key = `DOWNLOAD ${path}`;
  const running = inFlight.get(key);
  if (running) return running as Promise<void>;
  const started = fetchFile(path, filename)
    .catch((err: unknown) => {
      reportFailure(err, {});
      throw err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

async function fetchFile(path: string, filename: string): Promise<void> {
  const token = localStorage.getItem(ACCESS_KEY);
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  }).catch(() => {
    throw new ApiRequestError('NETWORK_ERROR', 'Could not reach Clowe — check your connection and try again');
  });
  if (!res.ok) {
    // The API explains a refusal in its usual envelope; say why when it does.
    const json = await res.json().catch(() => null);
    throw new ApiRequestError(json?.error?.code ?? 'DOWNLOAD_FAILED', json?.error?.message ?? `Could not download ${filename}`);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
