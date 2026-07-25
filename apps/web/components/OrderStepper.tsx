'use client';

const STEPS = ['CONFIRMED', 'SHIPPED', 'DELIVERED'] as const;
const STEP_LABELS: Record<string, string> = {
  CONFIRMED: 'Confirmed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
};

function stepIndex(status: string): number {
  if (status === 'DELIVERED' || status === 'RETURN_REQUESTED' || status === 'RETURNED') return 2;
  if (status === 'SHIPPED') return 1;
  if (status === 'CONFIRMED') return 0;
  return -1; // PLACED / CANCELLED
}

/** Horizontal order-status stepper — gold for completed/active steps. */
export default function OrderStepper({ status }: { status: string }) {
  const current = stepIndex(status);
  return (
    <div className="mt-3 flex items-center">
      {STEPS.map((step, i) => (
        <div key={step} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                i <= current ? 'bg-brand-600 text-white' : 'bg-gray-200 text-gray-400'
              }`}
            >
              {i <= current ? '✓' : i + 1}
            </span>
            <span
              className={`mt-1 text-[10px] ${i <= current ? 'font-semibold text-brand-700' : 'text-gray-500'}`}
            >
              {STEP_LABELS[step]}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`mx-1 mb-4 h-0.5 flex-1 ${i < current ? 'bg-brand-600' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  );
}
