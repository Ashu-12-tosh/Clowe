'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthUser } from '@clowe/shared';
import { api, getStoredUser, logoutSession, setStoredUser } from '@/lib/api';
import ProfileView from '@/components/account/ProfileView';

/** My Account — profile, preferences, addresses. Login lives at /login. */
export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) {
      router.replace('/login');
      return;
    }
    setUser(stored);
    // Refresh cached fields (prefs, avatar, hasPin…) in the background.
    api<AuthUser>('/api/auth/me', { auth: true })
      .then((fresh) => {
        setStoredUser(fresh);
        setUser(fresh);
      })
      .catch(() => {});
  }, [router]);

  async function logout() {
    await logoutSession();
    window.location.href = '/login';
  }

  if (!user) return null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-3xl font-bold tracking-tight text-brand-900">My Profile</h1>
      <div className="mt-6">
        <ProfileView user={user} onUserUpdate={setUser} onLogout={() => void logout()} />
      </div>
    </main>
  );
}
