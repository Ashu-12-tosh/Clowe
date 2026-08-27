'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  GENDERS,
  GENDER_LABELS,
  INTEREST_OPTIONS,
  PROFESSION_OPTIONS,
  type AuthUser,
  type Gender,
  type SecurityOverview,
  type SessionInfo,
  type TryOnQuota,
  type WishlistShare,
} from '@clowe/shared';
import {
  api,
  ApiRequestError,
  getStoredUser,
  logoutSession,
  setStoredUser,
  uploadImages,
} from '@/lib/api';
import ChipPicker from '@/components/account/ChipPicker';
import {
  CardIcon,
  HeadsetIcon,
  LockIcon,
  MapPinIcon,
  ShieldCheckIcon,
  TagIcon,
} from '@/components/cart/CartIcons';

const TABS = [
  { key: 'profile', label: 'Profile Details', icon: '👤' },
  { key: 'security', label: 'Login & Security', icon: '🛡' },
  { key: 'privacy', label: 'Privacy', icon: '🔒' },
  { key: 'preferences', label: 'Preferences', icon: '⚙' },
  { key: 'communication', label: 'Communication', icon: '✉' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const QUICK_ACTIONS = [
  { href: '/account/addresses', Icon: MapPinIcon, title: 'Manage Addresses', text: 'Add, edit or remove saved addresses' },
  { href: '/account/payments', Icon: CardIcon, title: 'Payment Methods', text: 'Manage cards, UPI & wallets' },
  { href: '/account/credits', Icon: TagIcon, title: 'Clowe Credits', text: 'View balance and transactions' },
  { href: '/account/coupons', Icon: TagIcon, title: 'My Coupons', text: 'View all available coupons' },
  { href: '/account/notifications/settings', Icon: HeadsetIcon, title: 'Notification Settings', text: 'Customize your notifications' },
];

const PINCODE_KEY = 'clowe.pincode';

const field =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600';

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-5">
      <h2 className="t-sub-heading text-ink-900">{title}</h2>
      {subtitle && <p className="t-caption mt-1 text-gray-500">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function VerifiedPill({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span
      className={`t-badge rounded px-1.5 py-0.5 ${
        ok ? 'bg-green-50 text-green-700' : 'bg-cream-100 text-gray-500'
      }`}
    >
      {ok ? 'Verified' : (label ?? 'Not verified')}
    </span>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-brand-600' : 'bg-gray-300'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[1.375rem]' : 'left-0.5'}`}
      />
    </button>
  );
}

export default function AccountSettingsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('profile');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [security, setSecurity] = useState<SecurityOverview | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [quota, setQuota] = useState<TryOnQuota | null>(null);
  const [sharePath, setSharePath] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Draft copies of the editable profile fields.
  const [form, setForm] = useState({
    name: '',
    email: '',
    dateOfBirth: '',
    gender: '' as Gender | '',
    location: '',
    profession: '',
  });
  const [interests, setInterests] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [pincode, setPincode] = useState('');

  const applyUser = (fresh: AuthUser) => {
    setStoredUser(fresh);
    setUser(fresh);
    setForm({
      name: fresh.name ?? '',
      email: fresh.email ?? '',
      dateOfBirth: fresh.dateOfBirth ?? '',
      gender: fresh.gender ?? '',
      location: fresh.location ?? '',
      profession: fresh.profession ?? '',
    });
    setInterests(fresh.interests ?? []);
    setBrands(fresh.favouriteBrands ?? []);
    setCategories(fresh.preferredCategories ?? []);
  };

  const loadSecurity = () => {
    api<SecurityOverview>('/api/auth/me/security', { auth: true }).then(setSecurity).catch(() => {});
    api<SessionInfo[]>('/api/auth/me/sessions', { auth: true }).then(setSessions).catch(() => {});
  };

  useEffect(() => {
    if (!getStoredUser()) {
      router.replace('/login');
      return;
    }
    setPincode(localStorage.getItem(PINCODE_KEY) ?? '');
    api<AuthUser>('/api/auth/me', { auth: true }).then(applyUser).catch(() => {});
    api<TryOnQuota>('/api/tryon/quota', { auth: true }).then(setQuota).catch(() => {});
    loadSecurity();
  }, [router]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(''), 3000);
  }

  async function saveProfile() {
    setError('');
    setSaving(true);
    try {
      const fresh = await api<AuthUser>('/api/auth/me', {
        method: 'PATCH',
        body: {
          ...(form.name.trim() ? { name: form.name.trim() } : {}),
          email: form.email.trim(),
          dateOfBirth: form.dateOfBirth || null,
          gender: form.gender || null,
          location: form.location.trim() || null,
          profession: form.profession || null,
          interests,
          favouriteBrands: brands,
          preferredCategories: categories,
        },
        auth: true,
      });
      applyUser(fresh);
      loadSecurity();
      flash('Profile saved');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your profile');
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('Photo must be under 2 MB');
      return;
    }
    setError('');
    try {
      const [avatarUrl] = await uploadImages([file]);
      applyUser(await api<AuthUser>('/api/auth/me', { method: 'PATCH', body: { avatarUrl }, auth: true }));
      flash('Photo updated');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload that photo');
    }
  }

  async function togglePref(key: 'email' | 'sms' | 'whatsapp' | 'recommendations') {
    const prefs = user?.prefs ?? { email: true, sms: true, whatsapp: true, recommendations: true };
    try {
      applyUser(
        await api<AuthUser>('/api/auth/me/preferences', {
          method: 'PATCH',
          body: { [key]: !prefs[key] },
          auth: true,
        }),
      );
      loadSecurity();
    } catch {
      setError('Could not save that preference');
    }
  }

  async function revokeSession(id: string) {
    try {
      setSessions(await api<SessionInfo[]>(`/api/auth/me/sessions/${id}`, { method: 'DELETE', auth: true }));
      loadSecurity();
      flash('Device signed out');
    } catch {
      setError('Could not sign that device out');
    }
  }

  async function deleteAccount() {
    const phone = prompt('This permanently deletes your account. Type your 10-digit mobile number to confirm:');
    if (!phone) return;
    setError('');
    try {
      await api('/api/auth/me', { method: 'DELETE', body: { confirmPhone: phone.trim() }, auth: true });
      await logoutSession();
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete your account');
    }
  }

  if (!user) return <div className="h-96 animate-pulse rounded-2xl bg-cream-100" />;

  const prefs = user.prefs ?? { email: true, sms: true, whatsapp: true, recommendations: true };
  const scoreColor =
    !security || security.score >= 90
      ? 'bg-green-600'
      : security.score >= 70
        ? 'bg-brand-600'
        : security.score >= 45
          ? 'bg-orange-500'
          : 'bg-red-500';

  return (
    <div>
      {/* Breadcrumb + title */}
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <Link href="/account" className="hover:text-brand-600">
          My Account
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Account Settings</span>
      </nav>
      <h1 className="t-page-title mt-2 text-ink-900">Account Settings</h1>
      <p className="t-section-desc mt-1 text-gray-500">
        Manage your personal information, preferences and security settings.
      </p>

      {notice && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* Tabs */}
          <div className="scrollbar-none flex gap-1 overflow-x-auto rounded-2xl border border-gray-100 bg-white px-2">
            {TABS.map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`t-nav flex shrink-0 items-center gap-2 border-b-2 px-4 py-3.5 transition ${
                  tab === item.key
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-600 hover:text-ink-900'
                }`}
              >
                <span>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>

          {/* ---------------- Profile Details ---------------- */}
          {tab === 'profile' && (
            <>
              <Card
                title="Profile Details"
                subtitle="Update your personal information and how others see you on Clowe."
              >
                <div className="grid gap-5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <div className="text-center">
                    <label className="relative mx-auto block h-28 w-28 cursor-pointer overflow-hidden rounded-full bg-cream-100">
                      {user.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full items-center justify-center text-4xl">👤</span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 bg-ink-900/70 py-1 text-[10px] font-bold text-white">
                        📷 Change
                      </span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(e) => void uploadAvatar(e.target.files)}
                      />
                    </label>
                    <p className="t-caption mt-2 font-semibold text-ink-900">Change Photo</p>
                    <p className="t-caption text-gray-400">JPG, PNG. Max size 2MB</p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="t-card-label text-gray-600">
                      Full Name
                      <input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        className={`mt-1.5 ${field}`}
                      />
                    </label>
                    <label className="t-card-label text-gray-600">
                      <span className="flex items-center gap-2">
                        Email Address <VerifiedPill ok={user.emailVerified} label="Unverified" />
                      </span>
                      <input
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        placeholder="you@example.com"
                        className={`mt-1.5 ${field}`}
                      />
                    </label>
                    <label className="t-card-label text-gray-600">
                      <span className="flex items-center gap-2">
                        Mobile Number <VerifiedPill ok />
                      </span>
                      <input
                        value={`+91 ${user.phone}`}
                        readOnly
                        className={`mt-1.5 cursor-not-allowed bg-cream-50 ${field}`}
                      />
                      <button
                        onClick={() => setTab('security')}
                        className="t-caption mt-1 font-semibold text-brand-600 hover:underline"
                      >
                        Change number →
                      </button>
                    </label>
                    <label className="t-card-label text-gray-600">
                      Date of Birth
                      <input
                        type="date"
                        value={form.dateOfBirth}
                        onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
                        className={`mt-1.5 ${field}`}
                      />
                    </label>
                    <label className="t-card-label text-gray-600">
                      Gender
                      <select
                        value={form.gender}
                        onChange={(e) => setForm({ ...form, gender: e.target.value as Gender | '' })}
                        className={`mt-1.5 ${field}`}
                      >
                        <option value="">Prefer not to say</option>
                        {GENDERS.map((g) => (
                          <option key={g} value={g}>
                            {GENDER_LABELS[g]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="t-card-label text-gray-600">
                      Location
                      <input
                        value={form.location}
                        onChange={(e) => setForm({ ...form, location: e.target.value })}
                        placeholder="City, Country"
                        className={`mt-1.5 ${field}`}
                      />
                    </label>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-50/60 px-4 py-3">
                  <p className="t-caption flex items-start gap-2 text-gray-600">
                    <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <span>
                      Your profile helps us personalise your shopping experience.
                      <br />
                      This information is never shared with sellers or other shoppers.
                    </span>
                  </p>
                  <button
                    onClick={() => void saveProfile()}
                    disabled={saving}
                    className="t-btn rounded-lg bg-brand-600 px-5 py-2.5 text-white transition hover:bg-brand-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </Card>

              <Card
                title="About You (Optional)"
                subtitle="Tell us more about yourself to get better recommendations."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <ChipPicker
                    label="Interests"
                    options={INTEREST_OPTIONS}
                    value={interests}
                    onChange={setInterests}
                  />
                  <label className="t-card-label text-gray-600">
                    Profession
                    <select
                      value={form.profession}
                      onChange={(e) => setForm({ ...form, profession: e.target.value })}
                      className={`mt-1.5 ${field}`}
                    >
                      <option value="">Select…</option>
                      {PROFESSION_OPTIONS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ChipPicker
                    label="Favourite Brands (Optional)"
                    options={['NovaTech', 'Vertex', 'Fleur', 'Stridewear', 'Soniq', 'Orbita']}
                    value={brands}
                    onChange={setBrands}
                  />
                  <ChipPicker
                    label="Preferred Categories"
                    options={['Electronics', 'Fashion', 'Books', 'Home & Kitchen', 'Beauty', 'Sports']}
                    value={categories}
                    onChange={setCategories}
                  />
                </div>
                <button
                  onClick={() => void saveProfile()}
                  disabled={saving}
                  className="t-btn mt-4 rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </Card>

              <section className="rounded-2xl border border-red-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="text-xl text-red-500">⚠</span>
                    <div>
                      <h2 className="t-sub-heading text-ink-900">Delete Account</h2>
                      <p className="t-caption mt-1 text-gray-500">
                        Once you delete your account, there is no going back.
                        <br />
                        Your profile, addresses, wishlist and credits are permanently removed.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => void deleteAccount()}
                    className="t-btn rounded-lg border-2 border-red-500 px-5 py-2.5 text-red-600 transition hover:bg-red-50"
                  >
                    Delete My Account
                  </button>
                </div>
              </section>
            </>
          )}

          {/* ---------------- Login & Security ---------------- */}
          {tab === 'security' && (
            <>
              <Card title="Quick-login PIN" subtitle="A 4-digit PIN lets you sign in without waiting for an OTP.">
                <PinForm hasPin={user.hasPin} onSaved={() => { loadSecurity(); flash('PIN saved'); }} />
              </Card>

              <Card title="Mobile Number" subtitle="Your number is your login — changing it needs an OTP on the new number.">
                <PhoneChange currentPhone={user.phone} onChanged={applyUser} />
              </Card>

              <Card title="Active Sessions" subtitle="Devices currently signed in to your account.">
                {sessions === null ? (
                  <div className="h-20 animate-pulse rounded-lg bg-cream-100" />
                ) : sessions.length === 0 ? (
                  <p className="t-caption text-gray-500">No other active sessions.</p>
                ) : (
                  <ul className="space-y-2">
                    {sessions.map((session) => (
                      <li
                        key={session.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5"
                      >
                        <LockIcon className="h-4 w-4 shrink-0 text-gray-500" />
                        <div className="min-w-0 flex-1">
                          <p className="t-card-label text-ink-900">
                            Signed in{' '}
                            {new Date(session.createdAt).toLocaleDateString('en-IN', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })}
                            {session.isCurrent && (
                              <span className="t-badge ml-2 rounded bg-green-50 px-1.5 py-0.5 text-green-700">
                                This device
                              </span>
                            )}
                          </p>
                          <p className="t-caption text-gray-500">
                            Expires{' '}
                            {new Date(session.expiresAt).toLocaleDateString('en-IN', {
                              day: '2-digit',
                              month: 'short',
                            })}
                          </p>
                        </div>
                        {!session.isCurrent && (
                          <button
                            onClick={() => void revokeSession(session.id)}
                            className="t-caption rounded-lg border border-gray-300 px-3 py-1.5 font-semibold text-gray-600 transition hover:border-red-300 hover:text-red-600"
                          >
                            Sign out
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  onClick={() => {
                    void api('/api/auth/logout-all', { auth: true }).then(async () => {
                      await logoutSession();
                      window.location.href = '/login';
                    });
                  }}
                  className="t-btn mt-4 rounded-lg border border-gray-300 px-5 py-2.5 text-ink-900 transition hover:border-red-300 hover:text-red-600"
                >
                  Sign out of all devices
                </button>
              </Card>
            </>
          )}

          {/* ---------------- Privacy ---------------- */}
          {tab === 'privacy' && (
            <>
              <Card title="Personalisation" subtitle="Control how your activity shapes what you see.">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="t-card-label text-ink-900">Personalised recommendations</p>
                    <p className="t-caption text-gray-500">
                      Use my browsing and orders to suggest products.
                    </p>
                  </div>
                  <Toggle
                    on={prefs.recommendations}
                    onClick={() => void togglePref('recommendations')}
                    label="Personalised recommendations"
                  />
                </div>
              </Card>

              <Card title="AI Try-On photo" subtitle="Saved so you don't have to upload it every time.">
                {quota?.savedPhotoUrl ? (
                  <div className="flex items-center gap-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={quota.savedPhotoUrl}
                      alt="Your saved try-on photo"
                      className="h-24 w-20 rounded-lg border border-gray-200 object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="t-caption text-gray-500">
                        Private to your account — never shown to sellers or other shoppers.
                      </p>
                      <button
                        onClick={() => {
                          void api('/api/tryon/photo', { method: 'DELETE', auth: true }).then(() => {
                            setQuota((q) => (q ? { ...q, savedPhotoUrl: null } : q));
                            flash('Saved photo deleted');
                          });
                        }}
                        className="t-caption mt-2 font-semibold text-red-600 underline"
                      >
                        Delete my saved photo
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="t-caption text-gray-500">No try-on photo saved.</p>
                )}
              </Card>

              <Card title="Wishlist sharing" subtitle="A share link lets anyone with it view your wishlist.">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => {
                      void api<WishlistShare>('/api/wishlist/share', { method: 'POST', auth: true })
                        .then((r) => {
                          setSharePath(r.path);
                          flash('Share link ready');
                        })
                        .catch(() => setError('Could not create a share link'));
                    }}
                    className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-ink-900 transition hover:border-brand-600"
                  >
                    Create / show link
                  </button>
                  <button
                    onClick={() => {
                      void api<WishlistShare>('/api/wishlist/share', { method: 'DELETE', auth: true })
                        .then(() => {
                          setSharePath(null);
                          flash('Share link revoked');
                        })
                        .catch(() => setError('Could not revoke the link'));
                    }}
                    className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-gray-600 transition hover:border-red-300 hover:text-red-600"
                  >
                    Revoke link
                  </button>
                </div>
                {sharePath && (
                  <p className="t-caption mt-3 break-all rounded-lg bg-cream-50 px-3 py-2 text-gray-600">
                    {typeof window !== 'undefined' ? window.location.origin : ''}
                    {sharePath}
                  </p>
                )}
              </Card>
            </>
          )}

          {/* ---------------- Preferences ---------------- */}
          {tab === 'preferences' && (
            <Card title="Shopping Preferences" subtitle="Defaults applied while you browse and check out.">
              <label className="t-card-label block text-gray-600">
                Default delivery pincode
                <span className="mt-1.5 flex gap-2">
                  <input
                    value={pincode}
                    onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="6-digit pincode"
                    inputMode="numeric"
                    className={field}
                  />
                  <button
                    onClick={() => {
                      if (!/^\d{6}$/.test(pincode)) {
                        setError('Enter a valid 6-digit pincode');
                        return;
                      }
                      localStorage.setItem(PINCODE_KEY, pincode);
                      setError('');
                      flash('Delivery pincode saved');
                    }}
                    className="t-btn shrink-0 rounded-lg bg-ink-900 px-5 text-white transition hover:bg-ink-800"
                  >
                    Save
                  </button>
                </span>
              </label>
              <p className="t-caption mt-2 text-gray-500">
                Used to quote delivery on product pages. Stored on this device only.
              </p>

              <div className="mt-5 border-t border-gray-100 pt-4">
                <p className="t-card-label text-ink-900">Preferred categories</p>
                <p className="t-caption mt-1 text-gray-500">
                  {categories.length > 0 ? categories.join(', ') : 'None picked yet'} ·{' '}
                  <button
                    onClick={() => setTab('profile')}
                    className="font-semibold text-brand-600 hover:underline"
                  >
                    Edit in About You
                  </button>
                </p>
              </div>
            </Card>
          )}

          {/* ---------------- Communication ---------------- */}
          {tab === 'communication' && (
            <Card
              title="Communication"
              subtitle="Choose how we reach you. OTPs and order-critical messages are always sent."
            >
              <ul className="divide-y divide-gray-100">
                {(
                  [
                    { key: 'email', icon: '📧', label: 'Email', text: 'Order updates, offers and newsletters' },
                    { key: 'sms', icon: '✉️', label: 'SMS', text: 'Delivery and order alerts by text' },
                    { key: 'whatsapp', icon: '🟢', label: 'WhatsApp', text: 'Confirmations and shipping updates' },
                  ] as const
                ).map((row) => (
                  <li key={row.key} className="flex items-center gap-3 py-3.5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cream-100 text-lg">
                      {row.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="t-card-label text-ink-900">{row.label}</p>
                      <p className="t-caption text-gray-500">{row.text}</p>
                    </div>
                    <Toggle on={prefs[row.key]} onClick={() => void togglePref(row.key)} label={row.label} />
                  </li>
                ))}
              </ul>
              <Link
                href="/account/notifications"
                className="t-caption mt-3 inline-block font-semibold text-brand-600 hover:underline"
              >
                View my notifications →
              </Link>
            </Card>
          )}
        </div>

        {/* ---------------- Right rail ---------------- */}
        <aside className="space-y-4 xl:sticky xl:top-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Account Security</h2>
            <p className="t-caption mt-1 text-gray-500">Keep your account safe and secure.</p>

            <ul className="mt-4 space-y-3">
              <li className="flex items-start gap-2.5">
                <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Quick-login PIN</p>
                  <p className="t-caption text-gray-500">
                    {security?.hasPin ? 'Enabled' : 'Not set'}
                  </p>
                </div>
                <button
                  onClick={() => setTab('security')}
                  className="t-caption shrink-0 font-semibold text-brand-600 hover:underline"
                >
                  {security?.hasPin ? 'Change' : 'Set up'}
                </button>
              </li>
              <li className="flex items-start gap-2.5">
                <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Mobile verification</p>
                  <p className="t-caption text-gray-500">Verified via OTP</p>
                </div>
              </li>
              <li className="flex items-start gap-2.5">
                <HeadsetIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Active Sessions</p>
                  <p className="t-caption text-gray-500">
                    {security ? `${security.activeSessions} active` : '…'}
                  </p>
                </div>
                <button
                  onClick={() => setTab('security')}
                  className="t-caption shrink-0 font-semibold text-brand-600 hover:underline"
                >
                  Manage
                </button>
              </li>
              <li className="flex items-start gap-2.5">
                <CardIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Login Alerts</p>
                  <p className="t-caption text-gray-500">
                    {security?.loginAlerts ? 'Enabled' : 'All channels off'}
                  </p>
                </div>
                <button
                  onClick={() => setTab('communication')}
                  className="t-caption shrink-0 font-semibold text-brand-600 hover:underline"
                >
                  Manage
                </button>
              </li>
            </ul>

            {security && (
              <div className="mt-4 rounded-xl bg-cream-50 p-3">
                <p className="flex items-center justify-between">
                  <span className="t-card-label text-ink-900">Security Score</span>
                  <span className="t-card-label text-green-700">{security.label}</span>
                </p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-200">
                  <div
                    className={`h-full rounded-full ${scoreColor} transition-all`}
                    style={{ width: `${security.score}%` }}
                  />
                </div>
                <p className="t-caption mt-2 text-gray-600">
                  {security.suggestions.length === 0
                    ? 'Great! Your account is well protected.'
                    : security.suggestions[0]}
                </p>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Quick Actions</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              {QUICK_ACTIONS.map(({ href, Icon, title, text }) => (
                <li key={title}>
                  <Link href={href} className="flex items-center gap-2.5 py-3 transition hover:text-brand-600">
                    <Icon className="h-4 w-4 shrink-0 text-gray-500" />
                    <span className="min-w-0 flex-1">
                      <span className="t-card-label block text-ink-900">{title}</span>
                      <span className="t-caption block text-gray-500">{text}</span>
                    </span>
                    <span className="shrink-0 text-gray-300">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
            <span className="text-2xl">🎧</span>
            <p className="t-card-label mt-1 text-ink-900">Need Help?</p>
            <p className="t-caption text-gray-500">Our support team is here to help you.</p>
            <Link
              href="/pages/help"
              className="t-btn mt-3 block rounded-lg border-2 border-brand-600 py-2.5 text-brand-600 transition hover:bg-brand-50"
            >
              Visit Help Center
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Set or replace the 4-digit quick-login PIN. */
function PinForm({ hasPin, onSaved }: { hasPin: boolean; onSaved: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!/^\d{4}$/.test(pin)) {
      setError('PIN must be exactly 4 digits');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/me/set-pin', { body: { pin }, auth: true });
      setPin('');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="t-caption mb-2 text-gray-500">
        {hasPin ? 'A PIN is set. Enter a new one to replace it.' : 'No PIN set yet.'}
      </p>
      <div className="flex gap-2">
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="4-digit PIN"
          inputMode="numeric"
          type="password"
          className="w-40 rounded-lg border border-gray-300 px-3 py-2.5 text-sm tracking-[0.5em] outline-none focus:border-brand-600"
        />
        <button
          onClick={() => void save()}
          disabled={busy}
          className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN'}
        </button>
      </div>
      {error && <p className="t-caption mt-2 font-medium text-red-600">{error}</p>}
    </div>
  );
}

/** Two-step mobile number change: request an OTP, then confirm it. */
function PhoneChange({
  currentPhone,
  onChanged,
}: {
  currentPhone: string;
  onChanged: (user: AuthUser) => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'idle' | 'sent'>('idle');
  const [devOtp, setDevOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function request() {
    setError('');
    setBusy(true);
    try {
      const data = await api<{ devOtp?: string }>('/api/auth/me/change-phone/request', {
        body: { newPhone: phone },
        auth: true,
      });
      setDevOtp(data.devOtp ?? '');
      setStage('sent');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send the OTP');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setError('');
    setBusy(true);
    try {
      const fresh = await api<AuthUser>('/api/auth/me/change-phone/confirm', {
        body: { newPhone: phone, code },
        auth: true,
      });
      onChanged(fresh);
      setStage('idle');
      setPhone('');
      setCode('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not confirm the change');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="t-caption mb-2 text-gray-500">Current number: +91 {currentPhone}</p>
      <div className="flex flex-wrap gap-2">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
          placeholder="New 10-digit number"
          inputMode="numeric"
          className="w-52 rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600"
        />
        {stage === 'sent' && (
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="OTP"
            inputMode="numeric"
            className="w-28 rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600"
          />
        )}
        <button
          onClick={() => void (stage === 'idle' ? request() : confirm())}
          disabled={busy || phone.length !== 10}
          className="t-btn rounded-lg bg-ink-900 px-5 py-2.5 text-white transition hover:bg-ink-800 disabled:opacity-50"
        >
          {busy ? 'Please wait…' : stage === 'idle' ? 'Send OTP' : 'Confirm change'}
        </button>
      </div>
      {devOtp && (
        <p className="t-caption mt-2 text-gray-500">
          Dev mode OTP: <span className="font-bold text-ink-900">{devOtp}</span>
        </p>
      )}
      {error && <p className="t-caption mt-2 font-medium text-red-600">{error}</p>}
    </div>
  );
}
