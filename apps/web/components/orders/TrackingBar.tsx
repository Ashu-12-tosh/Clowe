'use client';

import { useId, useState } from 'react';
import type { OrderTrackingSummary, ParcelTracking, ReturnTracking, TrackException, TrackStep, TrackTone } from '@clowe/shared';

// ---------------------------------------------------------------------------
// The tracking bar, as every order page shows it: per parcel, a plain-words
// headline, Ordered → Packed → Shipped → Out for delivery → Delivered (each
// done step with its date and time, the current one highlighted, the rest
// grey), anything gone wrong in its own box, and "See all updates" with
// Delhivery's scans. Vertical on phones, across on wider screens. States are
// spelled out in text (and for screen readers), never by colour alone.
// ---------------------------------------------------------------------------

const TONE: Record<TrackTone, { text: string; chip: string; box: string; icon: string }> = {
  info: { text: 'text-blue-800', chip: 'bg-blue-50 text-blue-800 ring-blue-200', box: 'border-blue-200 bg-blue-50 text-blue-900', icon: '🚚' },
  success: { text: 'text-green-800', chip: 'bg-green-50 text-green-800 ring-green-200', box: 'border-green-200 bg-green-50 text-green-900', icon: '✓' },
  warning: { text: 'text-amber-800', chip: 'bg-amber-50 text-amber-900 ring-amber-300', box: 'border-amber-300 bg-amber-50 text-amber-900', icon: '⚠' },
  danger: { text: 'text-red-700', chip: 'bg-red-50 text-red-700 ring-red-200', box: 'border-red-200 bg-red-50 text-red-800', icon: '!' },
  muted: { text: 'text-gray-700', chip: 'bg-gray-100 text-gray-700 ring-gray-200', box: 'border-gray-200 bg-gray-50 text-gray-800', icon: '⊘' },
};

const IST = 'Asia/Kolkata';
function stepWhen(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: IST }),
    time: d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: IST }).toUpperCase(),
  };
}
function scanWhen(iso: string): string {
  const { day, time } = stepWhen(iso);
  return `${day}, ${time}`;
}

/** A status chip for lists: words first, colour second. */
export function TrackingChip({ summary, className = '' }: { summary: Pick<OrderTrackingSummary, 'chip' | 'tone'>; className?: string }) {
  const tone = TONE[summary.tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset ${tone.chip} ${className}`} data-tracking-chip>
      <span aria-hidden>{tone.icon}</span>
      {summary.chip}
    </span>
  );
}

const STATE_WORDS: Record<TrackStep['state'], string> = { done: 'done', current: 'current step', upcoming: 'not yet' };

function Steps({ steps, tone }: { steps: TrackStep[]; tone: TrackTone }) {
  const stopped = tone === 'danger' || tone === 'muted';
  return (
    <ol className="mt-3 flex flex-col gap-0 sm:flex-row sm:items-start" data-track-steps>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const reached = step.state !== 'upcoming';
        const nextReached = !last && steps[i + 1]!.state !== 'upcoming';
        const when = step.at ? stepWhen(step.at) : null;
        return (
          <li
            key={step.key}
            aria-current={step.state === 'current' ? 'step' : undefined}
            data-step={step.key}
            data-state={step.state}
            className="relative flex min-w-0 gap-3 pb-4 last:pb-0 sm:flex-1 sm:flex-col sm:items-center sm:gap-1.5 sm:pb-0 sm:text-center"
          >
            {/* The line to the next step: down on phones, across on wider screens. */}
            {!last && (
              <span
                aria-hidden
                className={`absolute left-[0.6875rem] top-6 h-[calc(100%-1.5rem)] w-0.5 sm:left-[calc(50%+0.875rem)] sm:top-[0.6875rem] sm:h-0.5 sm:w-[calc(100%-1.75rem)] ${
                  nextReached ? (stopped ? 'bg-gray-400' : 'bg-green-600') : 'bg-gray-200'
                }`}
              />
            )}
            <span
              aria-hidden
              className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold ${
                step.state === 'current'
                  ? 'border-brand-600 bg-brand-600 text-white ring-4 ring-brand-100'
                  : reached
                    ? stopped
                      ? 'border-gray-500 bg-gray-500 text-white'
                      : 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-300 bg-white text-gray-300'
              }`}
            >
              {step.state === 'current' ? '●' : reached ? '✓' : ''}
            </span>
            <span className="min-w-0 sm:px-1">
              <span className={`block text-xs font-bold leading-tight ${step.state === 'current' ? 'text-brand-700' : reached ? 'text-ink-900' : 'text-gray-400'}`}>
                {step.label}
                <span className="sr-only"> — {STATE_WORDS[step.state]}</span>
              </span>
              {when && (
                <span className="block text-[11px] leading-tight text-gray-500">
                  {when.day}
                  <span className="sm:block"> {when.time}</span>
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ExceptionBox({ exception, tone }: { exception: TrackException; tone: TrackTone }) {
  const t = TONE[tone === 'info' || tone === 'success' ? 'warning' : tone];
  return (
    <div role="status" className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${t.box}`} data-track-exception={exception.kind}>
      <p className="font-bold">
        <span aria-hidden>{t.icon} </span>
        {exception.title}
      </p>
      <p className="mt-0.5">{exception.detail}</p>
      {exception.next && <p className="mt-1 font-semibold">{exception.next}</p>}
    </div>
  );
}

function Updates({ scans, label }: { scans: ParcelTracking['scans']; label: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (scans.length === 0) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-bold text-brand-700 hover:underline"
        data-see-updates
      >
        {open ? 'Hide updates' : `See all updates (${scans.length})`}
      </button>
      {open && (
        <ol id={id} aria-label={label} className="mt-2 space-y-2.5 border-l-2 border-gray-200 pl-3" data-scan-list>
          {scans.map((s, i) => (
            <li key={`${s.at}-${i}`} className="relative text-xs">
              <span aria-hidden className={`absolute -left-[1.1rem] top-1 h-2 w-2 rounded-full ${i === 0 ? 'bg-brand-600' : 'bg-gray-300'}`} />
              <p className={`break-words ${i === 0 ? 'font-bold text-ink-900' : 'text-gray-700'}`}>{s.description}</p>
              <p className="text-[11px] text-gray-500">
                {scanWhen(s.at)}
                {s.location && <> · {s.location}</>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Headline({ headline, chip, tone }: { headline: string; chip: string; tone: TrackTone }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <p className={`text-base font-bold leading-snug sm:text-lg ${TONE[tone].text}`} data-track-headline>
        {headline}
      </p>
      <TrackingChip summary={{ chip, tone }} />
    </div>
  );
}

export function ReturnTrackingCard({ ret }: { ret: ReturnTracking }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-cream-50/50 p-3 sm:p-4" data-return-tracking={ret.returnId}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
        Return {ret.rmaNumber} · <span className="normal-case">{ret.itemTitle}</span>
      </p>
      <div className="mt-1">
        <Headline headline={ret.headline} chip={ret.chip} tone={ret.tone} />
      </div>
      <Steps steps={ret.steps} tone={ret.tone} />
      {ret.exception && <ExceptionBox exception={ret.exception} tone={ret.tone} />}
      <Updates scans={ret.scans} label={`Return pickup updates for ${ret.itemTitle}`} />
    </div>
  );
}

/**
 * One parcel. `onRefresh` shows "Refresh" (the buyer's pages); without it the
 * card is read-only (seller and admin pages).
 */
export function ParcelTrackingCard({
  parcel,
  index,
  count,
  onRefresh,
  refreshing = false,
  note,
}: {
  parcel: ParcelTracking;
  index: number;
  count: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** A line under Refresh (e.g. "Checked a moment ago"). */
  note?: string;
}) {
  const [copied, setCopied] = useState(false);
  const titles = parcel.items.map((i) => (i.quantity > 1 ? `${i.title} × ${i.quantity}` : i.title));
  async function copyAwb() {
    if (!parcel.awbNumber) return;
    try {
      await navigator.clipboard.writeText(parcel.awbNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the number is on screen.
    }
  }
  return (
    <section
      aria-label={count > 1 ? `Parcel ${index + 1} of ${count}` : 'Your parcel'}
      className="min-w-0 rounded-2xl border border-gray-100 bg-white p-4 sm:p-5"
      data-parcel-tracking={parcel.key}
      data-tone={parcel.tone}
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
        {count > 1 ? `Parcel ${index + 1} of ${count} · ` : ''}Sold by <span className="normal-case">{parcel.shopName}</span>
      </p>
      <p className="mt-0.5 line-clamp-2 break-words text-xs text-gray-600">{titles.join(', ')}</p>
      <div className="mt-2">
        <Headline headline={parcel.headline} chip={parcel.chip} tone={parcel.tone} />
      </div>
      <Steps steps={parcel.steps} tone={parcel.tone} />
      {parcel.exception && <ExceptionBox exception={parcel.exception} tone={parcel.tone} />}

      {(parcel.awbNumber || parcel.lastUpdatedAt || onRefresh) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-gray-100 pt-3 text-xs text-gray-600">
          {parcel.awbNumber ? (
            <p className="min-w-0 break-all">
              Courier: <span className="font-semibold text-ink-900">{parcel.courierName ?? 'Delhivery'}</span>
              <span className="mx-1.5 text-gray-300">·</span>
              AWB <span className="font-mono font-semibold text-ink-900" data-awb>{parcel.awbNumber}</span>
              <button type="button" onClick={() => void copyAwb()} className="ml-1.5 text-gray-400 hover:text-brand-600" aria-label="Copy AWB number">
                {copied ? '✓' : '⧉'}
              </button>
            </p>
          ) : (
            <p>Courier details appear once the seller books the parcel.</p>
          )}
          {(parcel.lastUpdatedAt || (onRefresh && parcel.canRefresh)) && (
            <div className="flex items-center gap-2">
              {parcel.lastUpdatedAt && (
                <span data-last-updated>
                  Last updated {scanWhen(parcel.lastUpdatedAt)}
                </span>
              )}
              {onRefresh && parcel.canRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={refreshing}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 font-bold text-ink-900 transition hover:border-brand-600 disabled:opacity-50"
                  data-refresh
                >
                  {refreshing ? 'Checking…' : '↻ Refresh'}
                </button>
              )}
            </div>
          )}
          {note && (
            <p className="w-full text-[11px] text-gray-500" role="status" data-refresh-note>
              {note}
            </p>
          )}
        </div>
      )}

      <Updates scans={parcel.scans} label={`Courier updates for parcel ${index + 1}`} />
      {parcel.returns.map((r) => (
        <ReturnTrackingCard key={r.returnId} ret={r} />
      ))}
    </section>
  );
}

/** All of an order's parcels, one card each. */
export function OrderTracking({
  parcels,
  onRefresh,
  refreshing,
  note,
}: {
  parcels: ParcelTracking[];
  onRefresh?: () => void;
  refreshing?: boolean;
  note?: string;
}) {
  if (parcels.length === 0) return null;
  return (
    <div className="space-y-3" data-order-tracking>
      {parcels.map((p, i) => (
        <ParcelTrackingCard key={p.key} parcel={p} index={i} count={parcels.length} onRefresh={onRefresh} refreshing={refreshing} note={i === 0 ? note : undefined} />
      ))}
    </div>
  );
}

/** What the buyer's "Refresh" says back. */
export function refreshNote(r: { asked: number; cached: number; nextRefreshAt: string | null }): string {
  if (r.asked > 0) return 'Checked with Delhivery just now.';
  if (r.cached > 0 && r.nextRefreshAt) {
    const mins = Math.max(1, Math.ceil((new Date(r.nextRefreshAt).getTime() - Date.now()) / 60_000));
    return `Already up to date — checked with Delhivery in the last few minutes. Try again in ${mins} min.`;
  }
  return 'Up to date.';
}
