'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { invoiceMonthLabel, type SellerInvoiceListRow } from '@clowe/shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import PromotionCreditsCard from '@/components/seller/PromotionCreditsCard';

interface WalletView {
  walletPaise: number;
  adCreditPaise: number;
  settlementPaise: number;
}

/**
 * Billing with Clowe (owner's Batch 2): the Seller Wallet and its top-up,
 * advertising credit, and Clowe's monthly tax invoices to download.
 */
export default function SellerBillingPage() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [invoices, setInvoices] = useState<SellerInvoiceListRow[] | null>(null);

  useEffect(() => {
    api<WalletView>('/api/seller/billing/wallet', { auth: true }).then(setWallet).catch(() => {});
    api<SellerInvoiceListRow[]>('/api/seller/billing/invoices', { auth: true }).then(setInvoices).catch(() => setInvoices([]));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Billing &amp; Wallet</h1>
        <p className="mt-1 text-sm text-gray-500">
          Clowe&apos;s charges are exclusive of GST; GST is added and shown on your monthly tax invoice from Clowe.
        </p>
      </div>
      <PromotionCreditsCard />
      <section className="rounded-2xl border border-gray-100 bg-white p-4" data-ad-credit>
        <h2 className="text-sm font-bold text-ink-900">Advertising credit</h2>
        <p className="text-[11px] text-gray-400">Welcome and plan credit. Spent first on advertising; not money, so no GST on what it pays for.</p>
        <p className="mt-2 font-display text-2xl font-bold text-ink-900">{wallet ? formatPaise(wallet.adCreditPaise) : '—'}</p>
      </section>
      <section className="rounded-2xl border border-gray-100 bg-white p-4" data-seller-invoices>
        <h2 className="text-sm font-bold text-ink-900">Tax invoices from Clowe</h2>
        <p className="text-[11px] text-gray-400">One a month: every fee, plan, advertising, sponsorship and try-on charge, with GST.</p>
        {invoices === null ? (
          <p className="mt-3 text-sm text-gray-500">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No Clowe charges yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {invoices.map((i) => (
              <li key={i.month} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-semibold text-ink-900">{invoiceMonthLabel(i.month)}</span>{' '}
                  <span className="text-xs text-gray-500">{i.draft ? '(month so far — issued when it ends)' : i.number}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold">{formatPaise(i.totalPaise)}</span>
                  <Link href={`/seller/billing/invoices/${i.month}`} className="text-xs font-semibold text-brand-600 hover:underline">
                    {i.draft ? 'View' : 'View / download'}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
