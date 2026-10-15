'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  INBOX_STATUSES,
  INBOX_STATUSES_FOR,
  INBOX_STATUS_LABELS,
  type InboxKind,
  type InboxPage,
  type InboxRow,
  type InboxStatus,
  type InboxThread,
} from '@clowe/shared';
import { api, ApiRequestError, uploadImages } from '@/lib/api';
import Spinner from '@/components/Spinner';
import { ExternalLink } from '@/components/ExternalLink';

/** How often a visible tab asks for new messages. */
const LIST_POLL_MS = 5_000;
const THREAD_POLL_MS = 4_000;
const MAX_ATTACHMENTS = 5;

type StatusFilter = 'ACTIVE' | 'ALL' | InboxStatus;
type KindFilter = 'ALL' | InboxKind;

const STATUS_STYLE: Record<InboxStatus, string> = {
  OPEN: 'bg-amber-100 text-amber-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  PENDING_CUSTOMER: 'bg-purple-100 text-purple-800',
  RESOLVED: 'bg-green-100 text-green-800',
  CLOSED: 'bg-gray-100 text-gray-600',
};

/** "14:05" today, "Mon" this week, "12 Oct" before. */
function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Run `fn` every `ms` while the tab is visible, and at once when it becomes visible again. */
function usePoll(fn: () => void, ms: number, enabled = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === 'visible') saved.current();
    };
    const timer = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms, enabled]);
}

const keyOf = (r: { kind: InboxKind; id: string }) => `${r.kind}:${r.id}`;

/**
 * The support inbox, WhatsApp Web style: every seller ticket and customer
 * complaint as a conversation on the left, the open one on the right, both
 * kept current without reloading. On a phone the list comes first and a
 * conversation opens full screen with a back button.
 */
export default function AdminSupportInboxPage() {
  const [status, setStatus] = useState<StatusFilter>('ACTIVE');
  const [kind, setKind] = useState<KindFilter>('ALL');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<InboxPage | null>(null);
  const [listError, setListError] = useState('');
  const [open, setOpen] = useState<{ kind: InboxKind; id: string } | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadError, setThreadError] = useState('');
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [actionError, setActionError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ status, kind });
    if (q.trim()) params.set('q', q.trim());
    try {
      setPage(await api<InboxPage>(`/api/admin/support-inbox?${params.toString()}`, { auth: true }));
      setListError('');
    } catch (err) {
      setListError(err instanceof ApiRequestError ? err.message : 'Could not load the inbox');
    }
  }, [status, kind, q]);

  const loadThread = useCallback(async () => {
    if (!open) return;
    try {
      const t = await api<InboxThread>(`/api/admin/support-inbox/${open.kind.toLowerCase()}/${open.id}`, { auth: true });
      setThread((prev) => (prev && prev.row.id === t.row.id && prev.messages.length === t.messages.length && prev.row.status === t.row.status ? prev : t));
      setThreadError('');
    } catch (err) {
      setThreadError(err instanceof ApiRequestError ? err.message : 'Could not load the conversation');
    }
  }, [open]);

  // The list follows the filters (search waits for a pause in typing).
  useEffect(() => {
    const t = setTimeout(() => void loadList(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadList, q]);
  usePoll(() => void loadList(), LIST_POLL_MS);

  // Opening a conversation loads it (and marks it read); it then stays current.
  useEffect(() => {
    setThread(null);
    setReply('');
    setAttachments([]);
    setInternal(false);
    setActionError('');
    lastCount.current = 0;
    if (open) void loadThread().then(() => void loadList());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(() => void loadThread(), THREAD_POLL_MS, open !== null);

  // New messages scroll into view.
  useEffect(() => {
    const n = thread?.messages.length ?? 0;
    if (n > lastCount.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    lastCount.current = n;
  }, [thread]);

  // A deep link (?t=SELLER:id) opens that conversation.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('t');
    const [k, id] = t?.split(':') ?? [];
    if ((k === 'SELLER' || k === 'CUSTOMER') && id) setOpen({ kind: k, id });
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set('t', keyOf(open));
    else url.searchParams.delete('t');
    window.history.replaceState(null, '', url.toString());
  }, [open]);

  /** The endpoint of the open conversation's own kind. */
  const base = open ? (open.kind === 'SELLER' ? `/api/admin/support/${open.id}` : `/api/admin/support-desk/${open.id}`) : '';

  async function send() {
    if (!open || (!reply.trim() && attachments.length === 0) || sending) return;
    setSending(true);
    setActionError('');
    try {
      await api(`${base}/reply`, {
        method: 'POST',
        body: {
          body: reply.trim() || '(attachment)',
          attachments,
          ...(open.kind === 'CUSTOMER' ? { isInternal: internal } : {}),
        },
        auth: true,
        success: open.kind === 'CUSTOMER' && internal ? 'Internal note added' : 'Reply sent',
      });
      setReply('');
      setAttachments([]);
      await Promise.all([loadThread(), loadList()]);
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not send');
    } finally {
      setSending(false);
    }
  }

  async function changeStatus(next: InboxStatus) {
    if (!open || changingStatus) return;
    setActionError('');
    setChangingStatus(true);
    try {
      await api(base, { method: 'PATCH', body: { status: next }, auth: true, success: `Status: ${INBOX_STATUS_LABELS[next]}` });
      await Promise.all([loadThread(), loadList()]);
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not change the status');
    } finally {
      setChangingStatus(false);
    }
  }

  async function attach(files: FileList | null) {
    const list = files ? [...files].slice(0, MAX_ATTACHMENTS - attachments.length) : [];
    if (list.length === 0) return;
    setUploading(true);
    setActionError('');
    try {
      const urls = await uploadImages(list);
      setAttachments((prev) => [...prev, ...urls].slice(0, MAX_ATTACHMENTS));
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  const rows = page?.rows ?? null;
  const row = thread?.row ?? rows?.find((r) => open && keyOf(r) === keyOf(open)) ?? null;

  return (
    // The shell's header and padding take ~8.5rem; the inbox fills the rest.
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[28rem] overflow-hidden rounded-2xl border border-gray-100 bg-white">
      {/* --- Conversations ------------------------------------------------ */}
      <section
        data-inbox-list
        className={`flex w-full min-w-0 flex-col border-r border-gray-100 lg:w-[22rem] lg:shrink-0 ${open ? 'hidden lg:flex' : 'flex'}`}
      >
        <div className="space-y-2 border-b border-gray-100 p-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="font-display text-lg font-bold text-ink-900">
              Support inbox
              {page && page.unreadTotal > 0 && (
                <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 align-middle text-[11px] font-bold text-white">
                  {page.unreadTotal}
                </span>
              )}
            </h1>
            <Link href="/admin/support/queue" className="text-[11px] font-semibold text-brand-600 hover:underline">
              Queue &amp; reports →
            </Link>
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, ticket, order, subject"
            className="w-full rounded-full border border-gray-300 bg-cream-50 px-3.5 py-1.5 text-sm outline-none focus:border-brand-600"
          />
          <div className="flex gap-2">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              aria-label="Status"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs outline-none"
            >
              <option value="ACTIVE">Needs attention</option>
              {INBOX_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {INBOX_STATUS_LABELS[s]}
                </option>
              ))}
              <option value="ALL">Everything</option>
            </select>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as KindFilter)}
              aria-label="From"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs outline-none"
            >
              <option value="ALL">Sellers &amp; customers</option>
              <option value="SELLER">Sellers</option>
              <option value="CUSTOMER">Customers</option>
            </select>
          </div>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {listError && <li className="p-3 text-xs text-red-600">{listError}</li>}
          {rows === null && !listError && <li className="p-3 text-xs text-gray-400">Loading…</li>}
          {rows?.length === 0 && <li className="p-6 text-center text-xs text-gray-400">No conversations match.</li>}
          {rows?.map((r) => {
            const active = open !== null && keyOf(r) === keyOf(open);
            return (
              <li key={keyOf(r)}>
                <button
                  type="button"
                  data-inbox-row
                  onClick={() => setOpen({ kind: r.kind, id: r.id })}
                  className={`flex w-full gap-3 border-b border-gray-50 px-3 py-2.5 text-left hover:bg-cream-50 ${active ? 'bg-cream-100' : ''}`}
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                      r.kind === 'SELLER' ? 'bg-ink-900 text-brand-400' : 'bg-brand-100 text-brand-800'
                    }`}
                    aria-hidden
                  >
                    {r.name.trim()[0]?.toUpperCase() ?? '?'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-sm ${r.unread ? 'font-bold text-ink-900' : 'font-semibold text-ink-900'}`} title={r.name}>
                        {r.name}
                      </span>
                      <span className={`shrink-0 text-[11px] ${r.unread ? 'font-semibold text-brand-700' : 'text-gray-400'}`}>
                        {when(r.lastMessageAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-gray-500" title={r.lastMessage}>
                        {r.lastFrom === 'US' && <span className="text-gray-400">You: </span>}
                        {r.lastMessage || r.subject}
                      </span>
                      {r.unread > 0 && (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-bold text-white">
                          {r.unread}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span className="font-semibold uppercase tracking-wide text-gray-400">
                        {r.kind === 'SELLER' ? 'Seller' : 'Customer'} · {r.reference}
                      </span>
                      <span className={`rounded-full px-1.5 py-0.5 font-semibold ${STATUS_STYLE[r.status]}`}>
                        {INBOX_STATUS_LABELS[r.status]}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* --- Conversation ------------------------------------------------- */}
      <section
        data-inbox-chat
        className={`min-w-0 flex-1 flex-col bg-cream-50 ${
          open ? 'fixed inset-0 z-50 flex lg:static lg:z-auto' : 'hidden lg:flex'
        }`}
      >
        {!open && (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-gray-400">
            Pick a conversation on the left.
          </div>
        )}

        {open && (
          <>
            <header className="flex items-center gap-2 border-b border-gray-100 bg-white px-3 py-2.5">
              <button
                type="button"
                data-inbox-back
                onClick={() => setOpen(null)}
                className="rounded-full px-2 py-1 text-lg leading-none text-gray-600 hover:bg-gray-100 lg:hidden"
                aria-label="Back to conversations"
              >
                ←
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-ink-900" title={row?.name}>
                  {row?.name ?? '…'}
                </p>
                <p className="truncate text-[11px] text-gray-500" title={row?.subject}>
                  {row ? `${row.kind === 'SELLER' ? 'Seller' : 'Customer'} · ${row.reference} · ${row.subject}` : ''}
                  {thread?.orderNumber ? ` · Order ${thread.orderNumber}` : ''}
                </p>
              </div>
              {row && (
                <select
                  value={row.status}
                  onChange={(e) => void changeStatus(e.target.value as InboxStatus)}
                  disabled={changingStatus}
                  aria-busy={changingStatus}
                  aria-label="Status"
                  className="max-w-[9.5rem] rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs outline-none"
                >
                  {INBOX_STATUSES_FOR[row.kind].map((s) => (
                    <option key={s} value={s}>
                      {INBOX_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              )}
            </header>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4">
              {threadError && <p className="text-xs text-red-600">{threadError}</p>}
              {!thread && !threadError && <p className="text-xs text-gray-400">Loading…</p>}
              {thread?.messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.from === 'US' ? 'justify-end' : m.from === 'SYSTEM' ? 'justify-center' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                      m.from === 'SYSTEM'
                        ? 'bg-gray-100 text-xs text-gray-500'
                        : m.internal
                          ? 'border border-dashed border-amber-300 bg-amber-50 text-ink-900'
                          : m.from === 'US'
                            ? 'bg-[#dcf8c6] text-ink-900'
                            : 'bg-white text-ink-900'
                    }`}
                  >
                    {m.from !== 'SYSTEM' && (
                      <p className="text-[11px] font-semibold text-gray-500">
                        {m.authorName ?? ''}
                        {m.internal && ' · internal note'}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    {m.attachments.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {m.attachments.map((url) => (
                          <ExternalLink key={url} href={url}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="Attachment" className="h-16 w-16 rounded-lg border border-gray-200 object-cover" />
                          </ExternalLink>
                        ))}
                      </div>
                    )}
                    <p className="mt-0.5 text-right text-[10px] text-gray-400">{when(m.createdAt)}</p>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            <footer className="border-t border-gray-100 bg-white p-2.5">
              {actionError && <p className="mb-1.5 text-xs text-red-600">{actionError}</p>}
              {attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {attachments.map((url) => (
                    <span key={url} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" className="h-12 w-12 rounded-lg border border-gray-200 object-cover" />
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((u) => u !== url))}
                        aria-label="Remove attachment"
                        className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full bg-ink-900 text-[10px] leading-none text-white"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <label
                  className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-lg text-gray-500 hover:bg-gray-100 ${
                    uploading || attachments.length >= MAX_ATTACHMENTS ? 'pointer-events-none opacity-40' : ''
                  }`}
                  title="Attach images"
                >
                  {uploading ? '…' : '📎'}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void attach(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  maxLength={4000}
                  placeholder={internal ? 'Internal note — only admins see it' : 'Type a reply'}
                  className={`max-h-32 min-h-9 flex-1 resize-y rounded-2xl border px-3.5 py-2 text-sm outline-none focus:border-brand-600 ${
                    internal ? 'border-amber-300 bg-amber-50' : 'border-gray-300'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || (!reply.trim() && attachments.length === 0)}
                  aria-busy={sending}
                  data-action="send-reply"
                  className="h-9 shrink-0 rounded-full bg-brand-600 px-4 text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {sending ? <><Spinner className="mr-1" />Sending…</> : 'Send'}
                </button>
              </div>
              {open.kind === 'CUSTOMER' && (
                <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  Internal note (the customer doesn&apos;t see it)
                </label>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
