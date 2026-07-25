'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReviewItem, ReviewSummaryView } from '@clowe/shared';
import { api, ApiRequestError, getStoredUser } from '@/lib/api';

function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <span className={onChange ? 'cursor-pointer select-none' : 'select-none'}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          onClick={onChange ? () => onChange(n) : undefined}
          className={`text-lg ${n <= value ? 'text-brand-400' : 'text-gray-300'}`}
        >
          ★
        </span>
      ))}
    </span>
  );
}

export default function ReviewsSection({ productId }: { productId: string }) {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  const [summary, setSummary] = useState<ReviewSummaryView | null>(null);
  const [writing, setWriting] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<ReviewItem[]>(`/api/products/${productId}/reviews`, { auth: !!getStoredUser() })
      .then(setReviews)
      .catch(() => setReviews([]));
    api<ReviewSummaryView>(`/api/ai/review-summary/${productId}`)
      .then(setSummary)
      .catch(() => {});
  }, [productId]);
  useEffect(load, [load]);

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api(`/api/products/${productId}/reviews`, {
        body: { rating, comment: comment.trim() || undefined },
        auth: true,
      });
      setWriting(false);
      setComment('');
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save review');
    } finally {
      setBusy(false);
    }
  }

  const mine = reviews?.find((r) => r.isMine);

  // Star breakdown (5→1) computed from the loaded reviews — visual only.
  const breakdown = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: reviews?.filter((r) => r.rating === star).length ?? 0,
  }));
  const totalReviews = reviews?.length ?? 0;

  return (
    <section className="mt-10 border-t border-gray-200 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          Reviews{' '}
          {summary && summary.ratingCount > 0 && (
            <span className="text-sm font-normal text-gray-500">
              · ★ {summary.ratingAvg?.toFixed(1)} ({summary.ratingCount})
            </span>
          )}
        </h2>
        {getStoredUser() && !writing && (
          <button
            onClick={() => {
              if (mine) {
                setRating(mine.rating);
                setComment(mine.comment ?? '');
              }
              setWriting(true);
            }}
            className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {mine ? 'Edit my review' : 'Write a review'}
          </button>
        )}
      </div>

      {/* Rating breakdown (reference-style: big average + per-star bars) */}
      {summary && summary.ratingCount > 0 && summary.ratingAvg != null && totalReviews > 0 && (
        <div className="mt-4 flex items-center gap-6 rounded-2xl border border-gray-100 bg-white p-4">
          <div className="text-center">
            <p className="text-4xl font-bold text-ink-900">{summary.ratingAvg.toFixed(1)}</p>
            <Stars value={Math.round(summary.ratingAvg)} />
            <p className="mt-0.5 text-xs text-gray-500">{summary.ratingCount} reviews</p>
          </div>
          <div className="flex-1 space-y-1.5">
            {breakdown.map(({ star, count }) => (
              <div key={star} className="flex items-center gap-2 text-xs text-gray-500">
                <span className="w-6">{star} ★</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${totalReviews ? (count / totalReviews) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-5 text-right">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI summary */}
      {summary?.summary && (
        <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-brand-600">
            ✨ AI summary of reviews
            {summary.provider === 'mock' && (
              <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] text-yellow-700">
                MOCK
              </span>
            )}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-700">{summary.summary}</p>
        </div>
      )}

      {/* Write form */}
      {writing && (
        <form onSubmit={(e) => void submitReview(e)} className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Your rating:</span>
            <Stars value={rating} onChange={setRating} />
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="What did you think of the fabric, fit, colour…? (optional)"
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
          />
          <div className="mt-3 flex gap-2">
            <button
              disabled={busy}
              className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Submit review'}
            </button>
            <button
              type="button"
              onClick={() => setWriting(false)}
              className="rounded-lg border border-gray-300 px-5 py-2 text-sm text-gray-600"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* List */}
      {reviews === null && <p className="mt-4 text-sm text-gray-500">Loading reviews…</p>}
      {reviews && reviews.length === 0 && (
        <p className="mt-4 text-sm text-gray-600">
          No reviews yet — be the first to review this product.
        </p>
      )}
      <div className="mt-4 space-y-4">
        {reviews?.map((r) => (
          <div key={r.id} className="rounded-xl border border-gray-100 bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">
                {r.userName}
                {r.isMine && <span className="ml-2 text-xs font-normal text-brand-600">(you)</span>}
              </p>
              <Stars value={r.rating} />
            </div>
            {r.comment && <p className="mt-1.5 text-sm text-gray-600">{r.comment}</p>}
            <p className="mt-1.5 text-xs text-gray-400">
              {new Date(r.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
