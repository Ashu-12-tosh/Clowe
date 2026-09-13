import { ORDER_STATUS_LABELS } from '@clowe/shared';

export const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: 'bg-blue-100 text-blue-700',
  PACKED: 'bg-indigo-100 text-indigo-700',
  SHIPPED: 'bg-purple-100 text-purple-700',
  DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-700',
  RETURNED: 'bg-red-100 text-red-700',
  PLACED: 'bg-yellow-100 text-yellow-700',
};

/** Status chip for a seller order or one of its lines. */
export function StatusPill({ status, mixed }: { status: string; mixed?: boolean }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600'
      }`}
    >
      {ORDER_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')}
      {mixed && <span title="Your items are in different stages"> +</span>}
    </span>
  );
}
