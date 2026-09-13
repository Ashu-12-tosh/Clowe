'use client';

import type { AuthTokensResponse, AuthUser } from '@clowe/shared';

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

/** Upload images (multipart) and get back their public URLs. */
export async function uploadImages(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) form.append('images', file);
  const token = localStorage.getItem(ACCESS_KEY);
  const res = await fetch(`${API_URL}/api/uploads`, {
    method: 'POST',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const json = await res.json();
  if (!json.success) {
    throw new ApiRequestError(json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Upload failed');
  }
  return json.data.urls as string[];
}

/** Upload one packing video (multipart) and get back its public URL. */
export async function uploadVideo(file: File): Promise<string> {
  const form = new FormData();
  form.append('video', file);
  const token = localStorage.getItem(ACCESS_KEY);
  const res = await fetch(`${API_URL}/api/uploads/video`, {
    method: 'POST',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const json = await res.json();
  if (!json.success) {
    throw new ApiRequestError(json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Upload failed');
  }
  return json.data.url as string;
}

// --- Fetch helper with the standard { success, data, error } envelope ---

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function rawRequest(path: string, options: { method?: string; body?: unknown; auth?: boolean }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth) {
    const token = localStorage.getItem(ACCESS_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    credentials: 'include',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { res, json: await res.json() };
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  let { res, json } = await rawRequest(path, options);

  // Access token expired? Silently rotate via the refresh cookie and retry
  // once — active users never see a login screen.
  if (!json.success && res.status === 401 && options.auth && !path.startsWith('/api/auth/')) {
    const renewed = await refreshSession();
    if (renewed) {
      ({ res, json } = await rawRequest(path, options));
    }
  }

  if (!json.success) {
    throw new ApiRequestError(
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Something went wrong',
    );
  }
  return json.data as T;
}

/**
 * Download an authenticated file response (e.g. the try-on CSV export) and
 * hand it to the browser as a save dialog.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = localStorage.getItem(ACCESS_KEY);
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new ApiRequestError('DOWNLOAD_FAILED', 'Could not download the file');
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
