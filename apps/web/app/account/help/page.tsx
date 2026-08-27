'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_CATEGORY_LABELS,
  complaintCreateSchema,
  type ComplaintCategory,
  type ComplaintRow,
  type OrderListRow,
} from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';
import {
  FAQ_CATEGORIES,
  FAQ_CATEGORY_META,
  FAQ_ENTRIES,
  type FaqCategory,
  type FaqEntry,
} from '@/lib/support/faq-content';
import { SUPPORT_CHAT_EVENT } from '@/components/SupportChat';
import {
  BoxIcon,
  CardIcon,
  HeadsetIcon,
  ReturnIcon,
  ShieldCheckIcon,
  TruckIcon,
} from '@/components/cart/CartIcons';

/** Where "Call us" and "Email support" actually go. */
const SUPPORT_EMAIL = 'support@clowe.example';
const SUPPORT_PHONE = '+911800000000';
const SUPPORT_HOURS = 'Available everyday, 9 AM – 9 PM';

const HELP_RESOURCES = [
  { slug: 'shipping-info', label: 'Shipping Information', icon: '🚚' },
  { slug: 'return-policy', label: 'Return Policy', icon: '↩' },
  { slug: 'payment-policy', label: 'Payment Methods', icon: '💳' },
  { slug: 'terms-conditions', label: 'Terms & Conditions', icon: '📄' },
  { slug: 'privacy-policy', label: 'Privacy Policy', icon: '🔒' },
];

const TRUST_STRIP = [
  { Icon: BoxIcon, title: '100% Original Products', text: 'Sourced directly from brands' },
  { Icon: ReturnIcon, title: 'Easy Returns', text: 'Hassle-free returns within 7 days' },
  { Icon: ShieldCheckIcon, title: 'Secure Payments', text: '100% safe & secure payments' },
  { Icon: TruckIcon, title: 'Free Delivery', text: 'On orders above ₹999' },
  { Icon: HeadsetIcon, title: '24/7 Support', text: 'We are here for you' },
];

/** Bot answers use \n\n paragraphs — render them as real paragraphs. */
function Answer({ entry }: { entry: FaqEntry }) {
  return (
    <div className="pb-4 pl-1 pr-6">
      {entry.answer.split('\n\n').map((para, i) => (
        <p key={i} className="t-body whitespace-pre-line text-gray-600 [&:not(:first-child)]:mt-2">
          {para}
        </p>
      ))}
      {entry.links && entry.links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {entry.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="t-caption rounded-lg border border-gray-300 px-3 py-1.5 font-semibold text-ink-900 transition hover:border-brand-600 hover:text-brand-600"
            >
              {link.label} →
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HelpCenterPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FaqCategory | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Request form
  const [orders, setOrders] = useState<OrderListRow[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [reqCategory, setReqCategory] = useState<ComplaintCategory>('ORDER');
  const [orderId, setOrderId] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [myRequests, setMyRequests] = useState<ComplaintRow[]>([]);

  useEffect(() => {
    if (!getStoredUser()) return;
    api<OrderListRow[]>('/api/orders', { auth: true }).then(setOrders).catch(() => {});
    api<ComplaintRow[]>('/api/complaints/me', { auth: true }).then(setMyRequests).catch(() => {});
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = FAQ_ENTRIES;
    if (category) list = list.filter((e) => e.category === category);
    if (q) {
      list = list.filter(
        (e) =>
          e.label.toLowerCase().includes(q) ||
          e.answer.toLowerCase().includes(q) ||
          e.keywords.some((k) => k.includes(q)),
      );
    }
    return list;
  }, [query, category]);

  const visible = showAll || query || category ? results : results.slice(0, 6);

  const countByCategory = useMemo(() => {
    const map = new Map<FaqCategory, number>();
    for (const entry of FAQ_ENTRIES) {
      map.set(entry.category, (map.get(entry.category) ?? 0) + 1);
    }
    return map;
  }, []);

  async function submitRequest() {
    setError('');
    const parsed = complaintCreateSchema.safeParse({
      category: reqCategory,
      description: description.trim(),
      ...(orderId ? { orderId } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const created = await api<ComplaintRow>('/api/complaints', {
        body: parsed.data,
        auth: true,
      });
      setMyRequests((prev) => [created, ...prev]);
      setDescription('');
      setOrderId('');
      setFormOpen(false);
      setNotice(`Request ${created.complaintId} raised — our team will get back to you.`);
      setTimeout(() => setNotice(''), 6000);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not submit your request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-2 text-xs text-gray-500">
        <Link href="/" className="hover:text-brand-600">
          Home
        </Link>
        <span>›</span>
        <span className="font-medium text-ink-900">Help Center</span>
      </nav>

      <div>
        <h1 className="t-page-title text-ink-900">Help Center</h1>
        <p className="t-section-desc mt-1 text-gray-500">
          We&apos;re here to help! Find answers or connect with our support team.
        </p>
      </div>

      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* Search */}
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              ⌕
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for help articles, topics or issues..."
              aria-label="Search help"
              className="t-search w-full rounded-xl border border-gray-200 bg-white py-3.5 pl-10 pr-4 outline-none focus:border-brand-600"
            />
          </div>

          {/* Category cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {FAQ_CATEGORIES.map((key) => {
              const meta = FAQ_CATEGORY_META[key];
              const active = category === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    setCategory(active ? null : key);
                    setOpenId(null);
                  }}
                  className={`rounded-2xl border bg-white p-4 text-center transition hover:-translate-y-0.5 hover:shadow-md ${
                    active ? 'border-brand-600 ring-1 ring-brand-600' : 'border-gray-100'
                  }`}
                >
                  <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-xl">
                    {meta.icon}
                  </span>
                  <p className="t-card-label mt-2.5 text-ink-900">{meta.title}</p>
                  <p className="t-caption mt-1 text-gray-500">{meta.blurb}</p>
                  <p className="t-caption mt-2 font-semibold text-brand-600">
                    {active ? 'Clear filter' : `View ${countByCategory.get(key) ?? 0} articles →`}
                  </p>
                </button>
              );
            })}
          </div>

          {/* FAQ */}
          <section className="rounded-2xl border border-gray-100 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="t-sub-heading text-ink-900">
                {category ? FAQ_CATEGORY_META[category].title : 'Frequently Asked Questions'}
              </h2>
              {!query && !category && FAQ_ENTRIES.length > 6 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="t-caption font-semibold text-brand-600 hover:underline"
                >
                  {showAll ? 'Show fewer' : `View All FAQs (${FAQ_ENTRIES.length}) →`}
                </button>
              )}
            </div>

            {visible.length === 0 ? (
              <div className="py-10 text-center">
                <p className="t-body text-gray-500">
                  No articles match &ldquo;{query}&rdquo;.
                </p>
                <button
                  onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
                  className="t-btn mt-4 rounded-lg bg-ink-900 px-5 py-2.5 text-white hover:bg-ink-800"
                >
                  Ask our support assistant
                </button>
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-gray-100">
                {visible.map((entry) => {
                  const open = openId === entry.id;
                  return (
                    <li key={entry.id}>
                      <button
                        onClick={() => setOpenId(open ? null : entry.id)}
                        aria-expanded={open}
                        className="flex w-full items-center justify-between gap-3 py-4 text-left"
                      >
                        <span className="t-card-label text-ink-900">{entry.label}</span>
                        <span
                          className={`shrink-0 text-gray-400 transition-transform ${
                            open ? 'rotate-180' : ''
                          }`}
                        >
                          ⌄
                        </span>
                      </button>
                      {open && <Answer entry={entry} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* My requests */}
          {myRequests.length > 0 && (
            <section className="rounded-2xl border border-gray-100 bg-white p-5">
              <h2 className="t-sub-heading text-ink-900">My Support Requests</h2>
              <ul className="mt-3 divide-y divide-gray-100">
                {myRequests.slice(0, 5).map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="t-card-label text-ink-900">
                        {row.complaintId}
                        <span className="t-caption ml-2 font-normal text-gray-500">
                          {COMPLAINT_CATEGORY_LABELS[row.category as ComplaintCategory] ??
                            row.category}
                        </span>
                      </p>
                      <p className="t-caption line-clamp-1 text-gray-500">{row.description}</p>
                    </div>
                    <span
                      className={`t-badge shrink-0 rounded-full px-2.5 py-1 ${
                        row.status === 'RESOLVED' || row.status === 'CLOSED'
                          ? 'bg-green-50 text-green-700'
                          : 'bg-orange-50 text-orange-700'
                      }`}
                    >
                      {row.status.replace('_', ' ').toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                href="/complaints"
                className="t-caption mt-3 inline-block font-semibold text-brand-600 hover:underline"
              >
                View all requests →
              </Link>
            </section>
          )}
        </div>

        {/* ── Right rail ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Contact Support</h2>
            <p className="t-caption mt-1 text-gray-500">Choose a way to get in touch with us</p>

            <ul className="mt-4 space-y-3">
              <li className="flex items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100">
                  💬
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Live Chat</p>
                  <p className="t-caption text-gray-500">Chat with our support assistant</p>
                </div>
                <button
                  onClick={() => window.dispatchEvent(new Event(SUPPORT_CHAT_EVENT))}
                  className="t-caption shrink-0 rounded-lg border border-brand-600 px-3 py-1.5 font-bold text-brand-700 transition hover:bg-brand-50"
                >
                  Start Chat
                </button>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100">
                  ✉️
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Email Support</p>
                  <p className="t-caption text-gray-500">We&apos;ll get back within 24 hours</p>
                </div>
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="t-caption shrink-0 rounded-lg border border-brand-600 px-3 py-1.5 font-bold text-brand-700 transition hover:bg-brand-50"
                >
                  Send Email
                </a>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-100">
                  📞
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-card-label text-ink-900">Call Us</p>
                  <p className="t-caption text-gray-500">{SUPPORT_HOURS}</p>
                </div>
                <a
                  href={`tel:${SUPPORT_PHONE}`}
                  className="t-caption shrink-0 rounded-lg border border-brand-600 px-3 py-1.5 font-bold text-brand-700 transition hover:bg-brand-50"
                >
                  Call Now
                </a>
              </li>
            </ul>
          </div>

          {/* Order support */}
          <div className="rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
            <p className="t-card-label flex items-center gap-2 text-ink-900">
              <BoxIcon className="h-4 w-4 text-brand-600" />
              Order Support
            </p>
            <p className="t-caption mt-1 text-gray-600">Need help with a specific order?</p>
            {orders.length === 0 ? (
              <p className="t-caption mt-3 text-gray-500">You have no orders yet.</p>
            ) : (
              <select
                value={orderId}
                onChange={(e) => {
                  setOrderId(e.target.value);
                  setReqCategory('ORDER');
                  setFormOpen(true);
                }}
                className="t-body mt-3 w-full rounded-lg border border-brand-300 bg-white px-3 py-2.5 outline-none focus:border-brand-600"
              >
                <option value="">Select an Order</option>
                {orders.map((order) => (
                  <option key={order.id} value={order.id}>
                    #{order.orderNumber} · {order.itemCount} item
                    {order.itemCount === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Resources */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="t-sub-heading text-ink-900">Help Resources</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              {HELP_RESOURCES.map((row) => (
                <li key={row.slug}>
                  <Link
                    href={`/pages/${row.slug}`}
                    className="flex items-center gap-2.5 py-3 transition hover:text-brand-600"
                  >
                    <span className="w-5 text-center">{row.icon}</span>
                    <span className="t-card-label min-w-0 flex-1 text-ink-900">{row.label}</span>
                    <span className="shrink-0 text-gray-300">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Submit a request */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4">
            <p className="t-card-label flex items-center gap-2 text-ink-900">
              <HeadsetIcon className="h-4 w-4 text-gray-500" />
              Still need help?
            </p>
            <p className="t-caption mt-1 text-gray-500">
              Our support team is here for you.
            </p>

            {formOpen ? (
              <div className="mt-3 space-y-2.5">
                <label className="t-caption block text-gray-600">
                  What is it about?
                  <select
                    value={reqCategory}
                    onChange={(e) => setReqCategory(e.target.value as ComplaintCategory)}
                    className="t-body mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-600"
                  >
                    {COMPLAINT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {COMPLAINT_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </label>
                {orders.length > 0 && (
                  <label className="t-caption block text-gray-600">
                    Related order (optional)
                    <select
                      value={orderId}
                      onChange={(e) => setOrderId(e.target.value)}
                      className="t-body mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-600"
                    >
                      <option value="">None</option>
                      {orders.map((order) => (
                        <option key={order.id} value={order.id}>
                          #{order.orderNumber}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
                  rows={4}
                  placeholder="Describe the issue in a few words…"
                  aria-label="Describe your issue"
                  className="t-body w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-600"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void submitRequest()}
                    disabled={busy}
                    className="t-btn flex-1 rounded-lg bg-brand-600 py-2.5 text-white transition hover:bg-brand-700 disabled:opacity-50"
                  >
                    {busy ? 'Sending…' : 'Submit'}
                  </button>
                  <button
                    onClick={() => setFormOpen(false)}
                    className="t-btn rounded-lg border border-gray-300 px-4 py-2.5 text-gray-600"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setFormOpen(true)}
                className="t-btn mt-3 w-full rounded-lg border-2 border-brand-600 py-2.5 text-brand-600 transition hover:bg-brand-50"
              >
                Submit a Request
              </button>
            )}
          </div>

          <div className="flex items-start gap-2.5 rounded-2xl border border-gray-100 bg-white p-4">
            <CardIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
            <p className="t-caption text-gray-600">
              Requests get a tracking id like <span className="font-semibold">CMP-2026-00042</span>{' '}
              so you can follow them from{' '}
              <Link href="/complaints" className="font-semibold text-brand-600 hover:underline">
                My Requests
              </Link>
              .
            </p>
          </div>
        </aside>
      </div>

      {/* Trust strip */}
      <section className="grid gap-3 rounded-2xl border border-gray-100 bg-white p-5 sm:grid-cols-2 lg:grid-cols-5">
        {TRUST_STRIP.map(({ Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0">
              <p className="t-caption font-bold text-ink-900">{title}</p>
              <p className="t-caption text-gray-500">{text}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
