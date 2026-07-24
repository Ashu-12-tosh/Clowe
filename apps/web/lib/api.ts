'use client';

import type { AuthTokensResponse, AuthUser } from '@clowe/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const ACCESS_KEY = 'clowe.accessToken';
const REFRESH_KEY = 'clowe.refreshToken';
const USER_KEY = 'clowe.user';

// --- Token storage (localStorage for now; revisited during security phase) ---

export function saveSession(data: AuthTokensResponse) {
  localStorage.setItem(ACCESS_KEY, data.accessToken);
  localStorage.setItem(REFRESH_KEY, data.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}

export function clearSession() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
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

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

/**
 * Exchange the stored refresh token for a fresh session (e.g. after the
 * user's role changes on the server). Returns the updated user, or null.
 */
export async function refreshSession(): Promise<AuthUser | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const data = await api<AuthTokensResponse>('/api/auth/refresh', { body: { refreshToken } });
    saveSession(data);
    return data.user;
  } catch {
    return null;
  }
}

/** Upload images (multipart) and get back their public URLs. */
export async function uploadImages(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) form.append('images', file);
  const token = localStorage.getItem(ACCESS_KEY);
  const res = await fetch(`${API_URL}/api/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const json = await res.json();
  if (!json.success) {
    throw new ApiRequestError(json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Upload failed');
  }
  return json.data.urls as string[];
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

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth) {
    const token = localStorage.getItem(ACCESS_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json();

  if (!json.success) {
    throw new ApiRequestError(
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Something went wrong',
    );
  }
  return json.data as T;
}
