/**
 * Said wherever a buyer decides on an item that cannot be cancelled once the
 * order is confirmed — the product page, cart, checkout and the order — as
 * the Cancellation Policy (2.1) requires: marked before the order is placed.
 */
export default function NonCancellable({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 ${className}`}
      data-non-cancellable
      title="This item cannot be cancelled once your order is confirmed"
    >
      Non-cancellable
    </span>
  );
}
