'use client';

import { CardIcon, CartIcon, CheckIcon, MapPinIcon } from '@/components/cart/CartIcons';

export type CheckoutStep = 'cart' | 'address' | 'payment' | 'review';

const STEPS: { key: CheckoutStep; label: string; Icon: typeof CartIcon }[] = [
  { key: 'cart', label: 'Cart', Icon: CartIcon },
  { key: 'address', label: 'Address', Icon: MapPinIcon },
  { key: 'payment', label: 'Payment', Icon: CardIcon },
  { key: 'review', label: 'Review', Icon: CheckIcon },
];

/** Cart → Address → Payment → Review progress rail above the checkout form. */
export default function CheckoutStepper({ current }: { current: CheckoutStep }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);

  return (
    <ol className="mt-4 flex items-start">
      {STEPS.map((step, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={step.key} className="flex flex-1 flex-col items-center last:flex-none">
            <div className="flex w-full items-center">
              {/* left connector */}
              <span
                className={`h-px flex-1 border-t border-dashed ${
                  i === 0 ? 'border-transparent' : done || active ? 'border-brand-600' : 'border-gray-300'
                }`}
              />
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                  active
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : done
                      ? 'border-green-600 bg-white text-green-600'
                      : 'border-gray-300 bg-white text-gray-400'
                }`}
              >
                {done ? <CheckIcon className="h-4 w-4" /> : <step.Icon className="h-4 w-4" />}
              </span>
              <span
                className={`h-px flex-1 border-t border-dashed ${
                  i === STEPS.length - 1
                    ? 'border-transparent'
                    : done
                      ? 'border-brand-600'
                      : 'border-gray-300'
                }`}
              />
            </div>
            <span
              className={`mt-1.5 text-xs ${
                active ? 'font-bold text-brand-600' : done ? 'font-medium text-ink-900' : 'text-gray-400'
              }`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
