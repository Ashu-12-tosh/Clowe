import type { Metadata } from 'next';
import Link from 'next/link';
import { bpsToPercent, slabDescription, type ReferralFeeSlab } from '@clowe/shared';

export const metadata: Metadata = {
  title: 'Referral Fee Schedule',
  description:
    'Clowe referral fee schedule for sellers: the rate for every product category and price slab, charged on the whole selling price including GST, with examples.',
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface ScheduleTable {
  version: number;
  effectiveFrom: string;
  groups: { group: string; categories: { sheetCategory: string; slabs: ReferralFeeSlab[] }[] }[];
}

async function schedule(): Promise<ScheduleTable | null> {
  try {
    const res = await fetch(`${API_URL}/api/referral-fees`, { cache: 'no-store' });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: ScheduleTable | null }).data ?? null;
  } catch {
    return null;
  }
}

const GROUP_NAMES: Record<string, string> = {
  Media: 'Books, video games and toys',
  Consumables: 'Beauty, health, grocery, baby and pet',
  Softline: 'Fashion, footwear, bags and jewellery',
  'Other Hardline': 'Home, kitchen, furniture, sports and automotive',
  'CE/PC/Wireless': 'Electronics, computers, mobiles and office',
};

/**
 * The referral fee schedule in force, for sellers and anyone deciding to
 * sell: every category's price slabs and rates. The rate of the slab a
 * product's selling price (GST included) falls in applies to the whole price.
 */
export default async function ReferralFeeSchedulePage() {
  const table = await schedule();
  const from = table ? new Date(table.effectiveFrom).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }) : null;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <nav className="text-xs text-gray-400" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-brand-600 hover:underline">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <Link href="/pages/seller-fees" className="hover:text-brand-600 hover:underline">
          Seller Fees
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600">Referral Fee Schedule</span>
      </nav>

      <article className="mt-4 rounded-3xl border border-gray-100 bg-white p-5 sm:p-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink-900">Referral Fee Schedule</h1>
        {table ? (
          <>
            <p className="mt-2 text-sm text-gray-600">
              In force for orders placed from <span className="font-semibold">{from}</span> (version {table.version}). Orders placed earlier keep the fees they
              were placed under.
            </p>
            <div className="mt-4 space-y-2 rounded-xl bg-cream-50 p-4 text-sm text-gray-700">
              <p>
                The referral fee depends on the product&apos;s category and its <strong>selling price per unit, GST included</strong>. Find the slab the price
                falls in: that rate applies to the <strong>whole</strong> price, not just the part above the slab&apos;s start. A ₹1,500 item at 19% pays 19% of
                ₹1,500 = ₹285.
              </p>
              <p>
                The GT charge, the payment collection fee and the handling fee are added to it, with GST on all of Clowe&apos;s fees — see{' '}
                <Link href="/pages/seller-fees" className="font-semibold text-brand-600 hover:underline">
                  Seller Fees
                </Link>
                . The product form shows the exact fee for every price you try.
              </p>
            </div>

            {table.groups.map((g) => (
              <section key={g.group} className="mt-8" data-fee-group={g.group}>
                <h2 className="font-display text-xl font-bold text-ink-900">{GROUP_NAMES[g.group] ?? g.group}</h2>
                <div className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100">
                  {g.categories.map((c) => (
                    <div key={c.sheetCategory} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4">
                      <p className="font-semibold text-ink-900">{c.sheetCategory}</p>
                      <ul className="space-y-0.5 text-gray-700">
                        {c.slabs.map((s) => (
                          <li key={s.label} className="flex justify-between gap-3 tabular-nums">
                            <span>{slabDescription(s).replace(/^./, (ch) => ch.toUpperCase())}</span>
                            <span className="font-semibold text-ink-900">{bpsToPercent(s.rateBps)}%</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </>
        ) : (
          <p className="mt-3 text-sm text-gray-600">
            The schedule could not be loaded just now. The product form shows the referral fee for every price, and{' '}
            <Link href="/pages/seller-fees" className="font-semibold text-brand-600 hover:underline">
              Seller Fees
            </Link>{' '}
            lists the other fees.
          </p>
        )}
      </article>
    </main>
  );
}
