'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  HELP_ARTICLES,
  HELP_TOPICS,
  SELLER_POLICIES,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  ticketCreateSchema,
  type HelpArticle,
  type HelpTopicId,
  type SellerAssistantReply,
  type SellerSupportSummary,
  type SupportTicketPage,
  type TicketCategory,
  type TicketPriorityValue,
} from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';
import TicketDrawer, { TICKET_STATUS_STYLES } from '@/components/seller/support/TicketDrawer';

const HEALTH_STYLES: Record<string, string> = {
  GOOD: 'text-green-600',
  WATCH: 'text-yellow-600',
  POOR: 'text-red-600',
};

const HEALTH_BADGE: Record<string, string> = {
  GOOD: 'bg-green-100 text-green-700',
  WATCH: 'bg-yellow-100 text-yellow-700',
  POOR: 'bg-red-100 text-red-700',
};

const QUICK_QUESTIONS = [
  'How do I create a promotion?',
  'How do I add a new product?',
  'Payout not received',
  'What is the return & refund process?',
  'Why is my product not visible?',
];

function fmtMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function KpiCard({
  icon,
  label,
  value,
  footer,
}: {
  icon: string;
  label: string;
  value: string;
  footer: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cream-100 text-base">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 truncate font-display text-lg font-bold text-ink-900">{value}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">{footer}</p>
    </div>
  );
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  sources?: { id: string; title: string }[];
}

export default function SellerSupportPage() {
  const [summary, setSummary] = useState<SellerSupportSummary | null>(null);
  const [tickets, setTickets] = useState<SupportTicketPage | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Assistant
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Knowledge base
  const [kbQuery, setKbQuery] = useState('');
  const [topic, setTopic] = useState<HelpTopicId | 'ALL'>('ALL');
  const [openArticle, setOpenArticle] = useState<HelpArticle | null>(null);

  // New ticket form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    category: 'ORDERS' as TicketCategory,
    subject: '',
    body: '',
    priority: 'MEDIUM' as TicketPriorityValue,
    orderNumber: '',
  });
  const [creating, setCreating] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<SellerSupportSummary>('/api/seller/support/summary', { auth: true }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load support');
    }
  }, []);

  const loadTickets = useCallback(async () => {
    try {
      setTickets(
        await api<SupportTicketPage>(
          `/api/seller/support/tickets?status=${statusFilter}&pageSize=10`,
          { auth: true },
        ),
      );
    } catch {
      setTickets(null);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  async function ask(text: string) {
    const q = text.trim();
    if (q.length < 3 || asking) return;
    setQuestion('');
    setChat((prev) => [...prev, { role: 'user', content: q }]);
    setAsking(true);
    try {
      const reply = await api<SellerAssistantReply>('/api/ai/seller-assistant', {
        body: { question: q, history: chat.slice(-6).map((t) => ({ role: t.role, content: t.content })) },
        auth: true,
      });
      setChat((prev) => [
        ...prev,
        { role: 'assistant', content: reply.answer, sources: reply.sources },
      ]);
    } catch (err) {
      setChat((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            err instanceof ApiRequestError
              ? err.message
              : 'The assistant is unavailable right now — please raise a ticket.',
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  async function createTicket() {
    setError('');
    const payload = {
      category: form.category,
      subject: form.subject.trim(),
      body: form.body.trim(),
      priority: form.priority,
      orderNumber: form.orderNumber.trim() || undefined,
      attachments: [],
    };
    const parsed = ticketCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }

    setCreating(true);
    try {
      await api('/api/seller/support/tickets', { body: parsed.data, auth: true });
      setForm({ category: 'ORDERS', subject: '', body: '', priority: 'MEDIUM', orderNumber: '' });
      setShowForm(false);
      await Promise.all([loadSummary(), loadTickets()]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not raise the ticket');
    } finally {
      setCreating(false);
    }
  }

  const articles = HELP_ARTICLES.filter((a) => {
    if (topic !== 'ALL' && a.topic !== topic) return false;
    if (!kbQuery.trim()) return true;
    const q = kbQuery.toLowerCase();
    return (
      a.title.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      a.tags.some((t) => t.includes(q))
    );
  });

  const t = summary?.tickets;

  return (
    <div className="pb-10">
      {/* --- Header ---------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Support &amp; Help Center</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Answers from the seller handbook, and a human when you need one.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700"
        >
          ＋ Raise a ticket
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* --- KPIs -------------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {t && summary ? (
          <>
            <KpiCard icon="📬" label="Open tickets" value={String(t.open)} footer="Waiting on support" />
            <KpiCard
              icon="⏳"
              label="In progress"
              value={String(t.inProgress)}
              footer="Being worked on"
            />
            <KpiCard icon="✅" label="Resolved" value={String(t.resolved)} footer="All time" />
            <KpiCard
              icon="⚡"
              label="First response"
              value={fmtMinutes(t.avgResponseMinutes)}
              footer="Median across your tickets"
            />
            <KpiCard
              icon="⭐"
              label="Your rating"
              value={t.satisfaction != null ? `${t.satisfaction}/5` : '—'}
              footer={t.ratedCount > 0 ? `From ${t.ratedCount} rating(s)` : 'Rate a resolved ticket'}
            />
          </>
        ) : (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-100" />
          ))
        )}
      </div>

      {/* --- New ticket form --------------------------------------------- */}
      {showForm && (
        <section className="mt-4 rounded-2xl border border-gray-100 bg-white p-4">
          <h2 className="text-sm font-bold text-ink-900">Raise a support ticket</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold text-gray-500">What is it about?</label>
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as TicketCategory }))}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none"
              >
                {TICKET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {TICKET_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">Priority</label>
              <select
                value={form.priority}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priority: e.target.value as TicketPriorityValue }))
                }
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none"
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TICKET_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-gray-500">Subject</label>
              <input
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                maxLength={120}
                placeholder="One line about the problem"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-gray-500">
                Details (at least 20 characters)
              </label>
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={4}
                maxLength={4000}
                placeholder="What happened, what you expected, and anything you have already tried."
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500">
                Order number (if it is about one order)
              </label>
              <input
                value={form.orderNumber}
                onChange={(e) => setForm((f) => ({ ...f, orderNumber: e.target.value }))}
                placeholder="CLW-2026-000123"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void createTicket()}
              disabled={creating}
              className="rounded-lg bg-ink-900 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {creating ? 'Submitting…' : 'Submit ticket'}
            </button>
          </div>
        </section>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* --- AI assistant ------------------------------------------- */}
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink-900">
                ✦ AI Seller Assistant
                <span className="ml-1.5 rounded-full bg-cream-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500">
                  Beta
                </span>
              </h2>
            </div>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Answers come from the seller handbook below — it will say so when something is not
              covered.
            </p>

            <div className="mt-3 max-h-72 space-y-2.5 overflow-y-auto rounded-xl bg-cream-50 p-3">
              {chat.length === 0 && (
                <p className="text-sm text-gray-500">
                  Hello — ask me anything about selling on Clowe.
                </p>
              )}
              {chat.map((turn, i) => (
                <div
                  key={i}
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                    turn.role === 'user' ? 'ml-auto bg-ink-900 text-white' : 'bg-white text-ink-900'
                  }`}
                >
                  <p className="whitespace-pre-line">{turn.content}</p>
                  {turn.sources && turn.sources.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-gray-500">
                      Sources:{' '}
                      {turn.sources.map((s, j) => (
                        <button
                          key={s.id}
                          onClick={() =>
                            setOpenArticle(HELP_ARTICLES.find((a) => a.id === s.id) ?? null)
                          }
                          className="underline hover:text-brand-600"
                        >
                          {s.title}
                          {j < turn.sources!.length - 1 ? ', ' : ''}
                        </button>
                      ))}
                    </p>
                  )}
                </div>
              ))}
              {asking && <p className="text-xs text-gray-400">Thinking…</p>}
              <div ref={chatEndRef} />
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => void ask(q)}
                  disabled={asking}
                  className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:border-brand-600 hover:text-brand-600 disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>

            <div className="mt-2 flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void ask(question);
                }}
                placeholder="Type your question here…"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
              />
              <button
                onClick={() => void ask(question)}
                disabled={asking || question.trim().length < 3}
                className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-bold text-white hover:bg-ink-800 disabled:opacity-50"
              >
                ➤
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              AI answers can be wrong. Anything about your own money or orders — raise a ticket.
            </p>
          </section>

          {/* --- Tickets ------------------------------------------------- */}
          <section className="rounded-2xl border border-gray-100 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-bold text-ink-900">Your tickets</h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs outline-none"
              >
                <option value="ALL">All statuses</option>
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <ul className="divide-y divide-gray-50">
              {tickets?.rows.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    onClick={() => setOpenTicketId(ticket.id)}
                    className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-cream-50"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-900">{ticket.subject}</p>
                      <p className="text-[11px] text-gray-400">
                        <span className="font-mono">{ticket.reference}</span> ·{' '}
                        {ticket.categoryLabel} · {ticket.messageCount} message(s) ·{' '}
                        {new Date(ticket.lastMessageAt).toLocaleDateString('en-IN')}
                      </p>
                      {ticket.lastMessage && (
                        <p className="mt-0.5 truncate text-xs text-gray-500">{ticket.lastMessage}</p>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${TICKET_STATUS_STYLES[ticket.status]}`}
                    >
                      {ticket.statusLabel}
                    </span>
                  </button>
                </li>
              ))}
              {tickets && tickets.rows.length === 0 && (
                <li className="px-4 py-10 text-center text-sm text-gray-500">
                  No tickets here. Ask the assistant first — most questions are covered in the
                  handbook.
                </li>
              )}
              {!tickets && <li className="px-4 py-10 text-center text-gray-400">Loading…</li>}
            </ul>
          </section>

          {/* --- Knowledge base ------------------------------------------ */}
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Seller handbook</h2>
            <input
              value={kbQuery}
              onChange={(e) => setKbQuery(e.target.value)}
              placeholder="Search the handbook…"
              className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                onClick={() => setTopic('ALL')}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  topic === 'ALL' ? 'bg-ink-900 text-white' : 'bg-cream-100 text-gray-600'
                }`}
              >
                All topics
              </button>
              {HELP_TOPICS.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setTopic(h.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    topic === h.id ? 'bg-ink-900 text-white' : 'bg-cream-100 text-gray-600'
                  }`}
                >
                  {h.icon} {h.title}
                </button>
              ))}
            </div>

            <ul className="mt-3 divide-y divide-gray-50">
              {articles.map((article) => (
                <li key={article.id}>
                  <button
                    onClick={() =>
                      setOpenArticle(openArticle?.id === article.id ? null : article)
                    }
                    className="w-full py-2.5 text-left"
                  >
                    <p className="text-sm font-semibold text-ink-900">
                      {article.title}
                      {article.popular && (
                        <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">
                          Popular
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">{article.summary}</p>
                  </button>
                  {openArticle?.id === article.id && (
                    <p className="whitespace-pre-line pb-3 text-xs leading-relaxed text-gray-700">
                      {article.body}
                    </p>
                  )}
                </li>
              ))}
              {articles.length === 0 && (
                <li className="py-6 text-center text-xs text-gray-400">
                  Nothing matches — try the assistant or raise a ticket.
                </li>
              )}
            </ul>
          </section>
        </div>

        {/* --- Sidebar --------------------------------------------------- */}
        <div className="space-y-4">
          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-sm font-bold text-ink-900">Account health</h2>
              {summary && (
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${HEALTH_BADGE[summary.health.overall]}`}
                >
                  {summary.health.overall === 'GOOD'
                    ? 'Good'
                    : summary.health.overall === 'WATCH'
                      ? 'Needs attention'
                      : 'At risk'}
                </span>
              )}
            </div>
            {summary ? (
              <>
                <p className="mt-1 text-[11px] text-gray-500">{summary.health.summary}</p>
                <ul className="mt-3 space-y-2.5">
                  {summary.health.metrics.map((m) => (
                    <li key={m.key}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-700">{m.label}</span>
                        <span className={`font-semibold ${HEALTH_STYLES[m.rating]}`}>
                          {m.value}%{' '}
                          <span className="font-normal text-gray-400">(target ≤{m.target}%)</span>
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream-100">
                        <div
                          className={`h-full rounded-full ${
                            m.rating === 'GOOD'
                              ? 'bg-green-500'
                              : m.rating === 'WATCH'
                                ? 'bg-yellow-500'
                                : 'bg-red-500'
                          }`}
                          style={{ width: `${Math.min(100, (m.value / (m.target * 2)) * 100)}%` }}
                        />
                      </div>
                      <p className="mt-0.5 text-[11px] text-gray-400">{m.detail}</p>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[11px] text-gray-400">
                  Measured over your last {summary.health.sampleSize} order line(s), 90 days.
                </p>
              </>
            ) : (
              <div className="mt-3 h-32 animate-pulse rounded-xl bg-gray-100" />
            )}
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Policy centre</h2>
            <ul className="mt-2 divide-y divide-gray-50">
              {SELLER_POLICIES.map((policy) => (
                <li key={policy.id} className="py-2">
                  <p className="text-xs font-semibold text-ink-900">{policy.title}</p>
                  <p className="text-[11px] leading-relaxed text-gray-500">{policy.summary}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-white p-4">
            <h2 className="text-sm font-bold text-ink-900">Popular help topics</h2>
            <ul className="mt-2 space-y-1">
              {HELP_TOPICS.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => {
                      setTopic(h.id);
                      setKbQuery('');
                    }}
                    className="flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-cream-50"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cream-100">
                      {h.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-ink-900">{h.title}</span>
                      <span className="block text-[11px] text-gray-500">{h.blurb}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-gray-100 bg-cream-50 p-4">
            <h2 className="text-sm font-bold text-ink-900">Still need help?</h2>
            <p className="mt-1 text-[11px] text-gray-600">
              Raise a ticket and the support team picks it up. You will get a notification the
              moment they reply.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-3 w-full rounded-lg bg-ink-900 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-ink-800"
            >
              Raise a ticket
            </button>
            <Link
              href="/seller/payouts"
              className="mt-2 block text-center text-[11px] font-semibold text-brand-600 hover:underline"
            >
              Payout question? Check your payouts first →
            </Link>
          </section>
        </div>
      </div>

      {openTicketId && (
        <TicketDrawer
          ticketId={openTicketId}
          onClose={() => setOpenTicketId(null)}
          onChanged={() => {
            void loadSummary();
            void loadTickets();
          }}
        />
      )}
    </div>
  );
}
