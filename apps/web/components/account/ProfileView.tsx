'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { AddressInfo, AuthUser, Gender } from '@clowe/shared';
import { GENDERS, GENDER_LABELS } from '@clowe/shared';
import { api, ApiRequestError, clearSession, setStoredUser, uploadImages } from '@/lib/api';
import AccountStats from '@/components/AccountStats';
import TryOnPhotoCard from '@/components/TryOnPhotoCard';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600';

function initialsOf(name: string | null): string {
  if (!name?.trim()) return '👤';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

interface Props {
  user: AuthUser;
  onUserUpdate: (user: AuthUser) => void;
  onLogout: () => void;
}

export default function ProfileView({ user, onUserUpdate, onLogout }: Props) {
  const [editing, setEditing] = useState(false);
  const personalRef = useRef<HTMLDivElement>(null);

  function applyUser(updated: AuthUser) {
    setStoredUser(updated);
    onUserUpdate(updated);
  }

  return (
    <div className="space-y-4">
      <ProfileHeader
        user={user}
        onUpdated={applyUser}
        onEditProfile={() => {
          setEditing(true);
          personalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />
      <AccountStats />
      <div ref={personalRef}>
        <PersonalInfoCard user={user} editing={editing} setEditing={setEditing} onUpdated={applyUser} />
      </div>
      <DefaultAddressCard />
      <PreferencesCard user={user} onUpdated={applyUser} />
      <TryOnPhotoCard />
      <QuickLinks referralCode={user.referralCode} role={user.role} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={onLogout}
          className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-100"
        >
          Logout (this device)
        </button>
        <button
          onClick={() => void logoutAllDevices()}
          className="flex-1 rounded-lg border border-red-200 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50"
        >
          Logout from all devices
        </button>
      </div>
    </div>
  );
}

/** Revokes every session for this account, then returns to the login screen. */
async function logoutAllDevices() {
  if (!window.confirm('Logout from ALL devices? You will need to login again everywhere.')) return;
  try {
    await api('/api/auth/logout-all', { method: 'POST', body: {}, auth: true });
  } catch {
    // Local logout still proceeds.
  }
  clearSession();
  window.location.href = '/login';
}

// ---------------------------------------------------------------------------

function ProfileHeader({
  user,
  onUpdated,
  onEditProfile,
}: {
  user: AuthUser;
  onUpdated: (u: AuthUser) => void;
  onEditProfile: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function uploadAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const [url] = await uploadImages([file]);
      const updated = await api<AuthUser>('/api/auth/me', {
        method: 'PATCH',
        body: { avatarUrl: url },
        auth: true,
      });
      onUpdated(updated);
    } catch {
      // non-fatal — avatar stays unchanged
    } finally {
      setBusy(false);
    }
  }

  const memberSince = new Date(user.createdAt).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="flex flex-wrap items-center gap-4">
        {/* Avatar + camera */}
        <div className="relative">
          {user.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.avatarUrl}
              alt={user.name ?? 'Profile photo'}
              className="h-20 w-20 rounded-full border-2 border-brand-100 object-cover"
            />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-ink-900 text-xl font-bold text-brand-400">
              {initialsOf(user.name)}
            </div>
          )}
          <label className="absolute -bottom-1 -right-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-gray-200 bg-white text-sm shadow hover:bg-cream-100">
            {busy ? '…' : '📷'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                void uploadAvatar(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-bold text-ink-900">{user.name ?? 'Clowe Shopper'}</h2>
          <p className="text-sm text-gray-500">+91 {user.phone}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-bold text-brand-700">
              ⭐ Clowe Member
            </span>
            <span className="text-xs text-gray-400">Member since {memberSince}</span>
          </p>
        </div>

        <button
          onClick={onEditProfile}
          className="rounded-lg border-2 border-brand-600 px-4 py-2 text-sm font-bold text-brand-600 hover:bg-brand-50"
        >
          ✎ Edit Profile
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PersonalInfoCard({
  user,
  editing,
  setEditing,
  onUpdated,
}: {
  user: AuthUser;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onUpdated: (u: AuthUser) => void;
}) {
  const [name, setName] = useState(user.name ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [dob, setDob] = useState(user.dateOfBirth ?? '');
  const [gender, setGender] = useState<Gender | ''>(user.gender ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Phone change sub-flow
  const [phoneStep, setPhoneStep] = useState<'idle' | 'enter' | 'otp'>('idle');
  const [newPhone, setNewPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState('');

  useEffect(() => {
    setName(user.name ?? '');
    setEmail(user.email ?? '');
    setDob(user.dateOfBirth ?? '');
    setGender(user.gender ?? '');
  }, [user]);

  async function save() {
    setError('');
    // Client-side checks (server validates again).
    if (dob) {
      const d = new Date(dob);
      const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (Number.isNaN(d.getTime()) || d >= new Date() || age < 13) {
        setError('Date of birth must be a past date and you must be at least 13.');
        return;
      }
    }
    setBusy(true);
    try {
      const updated = await api<AuthUser>('/api/auth/me', {
        method: 'PATCH',
        body: {
          name: name.trim() || undefined,
          email: email.trim() || null,
          dateOfBirth: dob || null,
          gender: gender || null,
        },
        auth: true,
      });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  }

  async function requestPhoneChange() {
    setError('');
    setBusy(true);
    try {
      const data = await api<{ devOtp?: string }>('/api/auth/me/change-phone/request', {
        body: { newPhone },
        auth: true,
      });
      if (data.devOtp) {
        setDevOtp(data.devOtp);
        setCode(data.devOtp);
      }
      setPhoneStep('otp');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send OTP');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPhoneChange() {
    setError('');
    setBusy(true);
    try {
      const updated = await api<AuthUser>('/api/auth/me/change-phone/confirm', {
        body: { newPhone, code },
        auth: true,
      });
      onUpdated(updated);
      setPhoneStep('idle');
      setNewPhone('');
      setCode('');
      setDevOtp('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not verify OTP');
    } finally {
      setBusy(false);
    }
  }

  const Row = ({ icon, label, value }: { icon: string; label: string; value: React.ReactNode }) => (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100 text-base">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-gray-500">{label}</p>
        <div className="text-sm font-medium text-ink-900">{value}</div>
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold">Personal Information</h3>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="text-sm font-semibold text-brand-600 hover:underline"
          >
            ✎ Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => {
                setEditing(false);
                setError('');
              }}
              className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm text-gray-600"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-lg bg-ink-900 px-5 py-1.5 text-sm font-bold text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {!editing ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Row icon="👤" label="Full Name" value={user.name ?? '—'} />
          <Row icon="🎂" label="Date of Birth" value={user.dateOfBirth ? new Date(user.dateOfBirth).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'} />
          <Row icon="📧" label="Email Address" value={user.email ?? '—'} />
          <Row icon="⚧" label="Gender" value={user.gender ? GENDER_LABELS[user.gender] : '—'} />
          <Row
            icon="📱"
            label="Phone Number"
            value={
              <span>
                +91 {user.phone}{' '}
                {phoneStep === 'idle' && (
                  <button
                    onClick={() => setPhoneStep('enter')}
                    className="ml-1 text-xs font-semibold text-brand-600 hover:underline"
                  >
                    Change
                  </button>
                )}
              </span>
            }
          />
          <Row icon="🔐" label="Login Method" value={`OTP via +91-${user.phone.slice(0, 5)}•••••`} />
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-semibold text-gray-500">Full Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`mt-1 ${field}`} placeholder="Your name" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500">Email Address</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${field}`} placeholder="you@example.com" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500">Date of Birth</label>
            <input
              type="date"
              value={dob}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDob(e.target.value)}
              className={`mt-1 ${field}`}
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500">Gender</label>
            <div className="relative mt-1">
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender | '')}
                className={`${field} appearance-none bg-white pr-8`}
              >
                <option value="">— select —</option>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABELS[g]}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                ▾
              </span>
            </div>
          </div>
          <p className="text-xs text-gray-400 sm:col-span-2">
            Phone number is your login ID — change it from the view mode using its own OTP
            verification.
          </p>
        </div>
      )}

      {/* Phone change sub-flow */}
      {phoneStep !== 'idle' && (
        <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50 p-4">
          <p className="text-sm font-bold text-ink-900">Change phone number</p>
          <p className="mt-0.5 text-xs text-gray-500">
            We&apos;ll verify the NEW number with an OTP before switching your login.
          </p>
          {phoneStep === 'enter' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, ''))}
                placeholder="New 10-digit number"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
              <button
                onClick={() => void requestPhoneChange()}
                disabled={busy || newPhone.length !== 10}
                className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                Send OTP
              </button>
              <button onClick={() => setPhoneStep('idle')} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
                Cancel
              </button>
            </div>
          )}
          {phoneStep === 'otp' && (
            <div className="mt-3 space-y-2">
              {devOtp && (
                <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <span className="font-semibold">Dev mode:</span> OTP for +91 {newPhone} is{' '}
                  <span className="font-mono font-bold">{devOtp}</span>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <input
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="6-digit OTP"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-center text-sm tracking-widest outline-none focus:border-brand-600"
                />
                <button
                  onClick={() => void confirmPhoneChange()}
                  disabled={busy || code.length !== 6}
                  className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  Verify & Update
                </button>
                <button onClick={() => setPhoneStep('idle')} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DefaultAddressCard() {
  const [address, setAddress] = useState<AddressInfo | null | undefined>(undefined);

  useEffect(() => {
    api<AddressInfo[]>('/api/addresses', { auth: true })
      .then((list) => setAddress(list.find((a) => a.isDefault) ?? list[0] ?? null))
      .catch(() => setAddress(null));
  }, []);

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold">Default Address</h3>
        <Link href="/checkout" className="text-sm font-semibold text-brand-600 hover:underline">
          Manage Addresses
        </Link>
      </div>
      {address === undefined && <p className="mt-3 text-sm text-gray-500">Loading…</p>}
      {address === null && (
        <div className="mt-3 text-sm text-gray-600">
          <p>No address saved yet.</p>
          <Link
            href="/checkout"
            className="mt-2 inline-block rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
          >
            + Add Address
          </Link>
        </div>
      )}
      {address && (
        <div className="mt-3 flex items-start gap-3 text-sm">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100">📍</span>
          <div>
            <p className="font-semibold">{address.name} · +91 {address.phone}</p>
            <p className="mt-0.5 text-gray-600">
              {address.line1}
              {address.line2 ? `, ${address.line2}` : ''}
              <br />
              {address.city}, {address.state} {address.pincode}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PreferencesCard({ user, onUpdated }: { user: AuthUser; onUpdated: (u: AuthUser) => void }) {
  const [savedKey, setSavedKey] = useState('');
  // Older cached sessions may predate the prefs field — default everything on.
  const prefs = user.prefs ?? { email: true, sms: true, whatsapp: true, recommendations: true };

  async function toggle(key: 'email' | 'sms' | 'whatsapp' | 'recommendations') {
    try {
      const updated = await api<AuthUser>('/api/auth/me/preferences', {
        method: 'PATCH',
        body: { [key]: !prefs[key] },
        auth: true,
      });
      onUpdated(updated);
      setSavedKey(key);
      setTimeout(() => setSavedKey(''), 1200);
    } catch {
      // keep previous state on failure
    }
  }

  const rows: { key: 'email' | 'sms' | 'whatsapp' | 'recommendations'; icon: string; label: string }[] = [
    { key: 'email', icon: '📧', label: 'Email Notifications' },
    { key: 'sms', icon: '✉️', label: 'SMS Notifications' },
    { key: 'whatsapp', icon: '🟢', label: 'WhatsApp Notifications' },
    { key: 'recommendations', icon: '✨', label: 'Personalized Recommendations' },
  ];

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <h3 className="text-base font-bold">Account Preferences</h3>
      <p className="mt-0.5 text-xs text-gray-400">
        OTP and order-critical updates are always sent.
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((row) => {
          const on = prefs[row.key];
          return (
            <div key={row.key} className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm">
                <span>{row.icon}</span> {row.label}
                {savedKey === row.key && <span className="text-xs font-semibold text-green-600">✓ Saved</span>}
              </p>
              <button
                onClick={() => void toggle(row.key)}
                role="switch"
                aria-checked={on}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-brand-600' : 'bg-gray-300'}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[1.375rem]' : 'left-0.5'}`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function QuickLinks({ referralCode, role }: { referralCode: string; role: AuthUser['role'] }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-sm">
      {role !== 'CUSTOMER' && (
        <Link
          href={role === 'ADMIN' ? '/admin' : '/seller'}
          className="col-span-2 rounded-lg bg-ink-900 p-3 text-center font-bold text-white hover:bg-ink-800"
        >
          {role === 'ADMIN' ? '🛡 Open Admin Dashboard →' : '🏪 Open Seller Dashboard →'}
        </Link>
      )}
      <Link href="/orders" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
        📦 My Orders
      </Link>
      <Link href="/referrals" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
        🎁 Refer & Earn
        <span className="block font-mono text-[11px] text-brand-600">{referralCode}</span>
      </Link>
      <Link href="/tryon" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
        ✨ My Try-Ons
      </Link>
      <Link href="/track" className="rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
        🚚 Track Order
      </Link>
      <Link href="/complaints" className="col-span-2 rounded-lg border border-gray-200 bg-white p-3 text-center font-medium hover:border-brand-600">
        📢 My Complaints
      </Link>
    </div>
  );
}
