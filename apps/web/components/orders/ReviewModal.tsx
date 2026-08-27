'use client';

import { useState } from 'react';
import { reviewCreateSchema, type OrderDetailItem } from '@clowe/shared';
import { api, ApiRequestError } from '@/lib/api';

interface Props {
  item: OrderDetailItem;
  onClose: () => void;
  onDone: () => void;
}

/** Rate + review a delivered item. Reviews are keyed per product per shopper. */
export default function ReviewModal({ item, onClose, onDone }: Props) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const parsed = reviewCreateSchema.safeParse({
      rating,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (!parsed.success) {
      setError(rating === 0 ? 'Pick a star rating' : parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError('');
    try {
      // The review route is nested under the product id.
      await api(`/api/products/${item.productId}/reviews`, {
        body: parsed.data,
        auth: true,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save your review');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl bg-white p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Write a review"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="t-sub-heading text-ink-900">Write a review</h2>
            <p className="t-caption mt-0.5 line-clamp-1 text-gray-500">{item.title}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-xl leading-none text-gray-400 hover:bg-gray-100"
          >
            ×
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => setRating(star)}
              onMouseEnter={() => setHover(star)}
              onMouseLeave={() => setHover(0)}
              aria-label={`${star} star${star === 1 ? '' : 's'}`}
              className={`text-3xl leading-none transition ${
                star <= (hover || rating) ? 'text-brand-500' : 'text-gray-300'
              }`}
            >
              ★
            </button>
          ))}
          {rating > 0 && (
            <span className="t-caption ml-2 text-gray-500">
              {['Poor', 'Fair', 'Good', 'Very good', 'Excellent'][rating - 1]}
            </span>
          )}
        </div>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 1000))}
          rows={4}
          placeholder="What did you like or dislike? (optional)"
          aria-label="Your review"
          className="mt-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-600"
        />
        <p className="t-caption mt-1 text-right text-gray-400">{comment.length}/1000</p>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="t-btn flex-1 rounded-lg bg-brand-600 py-3 text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Submit review'}
          </button>
          <button
            onClick={onClose}
            className="t-btn rounded-lg border border-gray-300 px-5 py-3 text-gray-600"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
