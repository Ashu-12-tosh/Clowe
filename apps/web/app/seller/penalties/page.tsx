'use client';

import Link from 'next/link';
import { PenaltiesPanel } from '@/components/seller/payouts/PenaltiesPanel';

/** Both penalty types, with order, date, amount, reason and whether each was waived. */
export default function SellerPenaltiesPage() {
  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">Penalties</h1>
        <p className="mt-1 text-sm text-gray-500">
          What a late dispatch or a cancelled order has cost you, and why. Penalties come off your settlement
          balance; see them in context on{' '}
          <Link href="/seller/payouts" className="font-semibold text-brand-600 hover:underline">
            Payouts
          </Link>
          .
        </p>
      </div>
      <PenaltiesPanel />
    </div>
  );
}
