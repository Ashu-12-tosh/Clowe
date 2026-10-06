import type { Metadata } from 'next';
import Link from 'next/link';
import { DEFAULT_LEGAL_ENTITY, legalDisplayName } from '@clowe/shared';
import { serverPublicSettings } from '@/lib/serverSettings';

export const metadata: Metadata = {
  title: 'Contact Us',
  description: 'How to reach Clowe: the business behind the site, its registered address, and support email and phone.',
};

/**
 * Contact Us. Everything about the business comes from the legal entity
 * settings (admin → settings), so nothing here is hard-coded; a field left
 * empty there is simply not shown.
 */
export default async function ContactPage() {
  const settings = await serverPublicSettings();
  const legal = { ...DEFAULT_LEGAL_ENTITY, ...(settings?.legalEntity ?? {}) };

  const business = [
    { label: 'Legal name', value: legal.name },
    { label: 'Registered address', value: legal.registeredAddress },
    { label: 'LLPIN', value: legal.llpin },
    { label: 'GSTIN', value: legal.gstin },
  ].filter((row) => row.value.trim());

  // The link scheme is fixed here, never taken from the stored value.
  const reach = [
    legal.supportEmail.trim() && { kind: 'email' as const, icon: '✉️', label: 'Email', value: legal.supportEmail },
    legal.supportPhone.trim() && { kind: 'phone' as const, icon: '📞', label: 'Phone', value: legal.supportPhone },
  ].filter((row): row is { kind: 'email' | 'phone'; icon: string; label: string; value: string } => Boolean(row));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <nav className="text-xs text-gray-400" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-brand-600 hover:underline">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600">Contact Us</span>
      </nav>

      <article className="mt-4 rounded-3xl border border-gray-100 bg-white p-6 sm:p-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink-900">Contact Us</h1>
        <p className="mt-3 leading-relaxed text-gray-700">
          cloweshop.com is owned and operated by <strong>{legal.name}</strong>. We&apos;re here to help
          with orders, returns, payments and selling on Clowe.
        </p>

        {reach.length > 0 && (
          <section className="mt-8 grid gap-4 sm:grid-cols-2">
            {reach.map((row) => (
              <a
                key={row.label}
                href={row.kind === 'email' ? `mailto:${row.value}` : `tel:${row.value.replace(/[^\d+]/g, '')}`}
                className="flex items-center gap-4 rounded-2xl border border-gray-100 bg-cream-100 p-5 transition hover:border-brand-600"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-xl">
                  {row.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold uppercase tracking-wide text-gray-500">{row.label}</span>
                  <span className="block break-words font-semibold text-ink-900">{row.value}</span>
                </span>
              </a>
            ))}
          </section>
        )}

        <section className="mt-8">
          <h2 className="font-display text-xl font-bold text-ink-900">The business</h2>
          <dl className="mt-3 divide-y divide-gray-100 rounded-2xl border border-gray-100">
            {business.map((row) => (
              <div key={row.label} className="grid gap-1 px-5 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
                <dt className="text-sm font-semibold text-gray-500">{row.label}</dt>
                <dd className="whitespace-pre-line text-sm text-ink-900">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-8">
          <h2 className="font-display text-xl font-bold text-ink-900">Other ways to get help</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-6 text-gray-700">
            <li>
              <Link href="/track" className="font-semibold text-brand-600 hover:underline">
                Track an order
              </Link>{' '}
              with your order number and phone.
            </li>
            <li>
              <Link href="/pages/help" className="font-semibold text-brand-600 hover:underline">
                Help Centre
              </Link>{' '}
              for returns, refunds, payments and delivery.
            </li>
            <li>
              Signed in? Raise a{' '}
              <Link href="/complaints" className="font-semibold text-brand-600 hover:underline">
                complaint
              </Link>{' '}
              about an order and we&apos;ll follow it up.
            </li>
          </ul>
        </section>

        <p className="mt-8 text-sm text-gray-500">
          Policies: <Link href="/pages/terms-conditions" className="hover:underline">Terms</Link> ·{' '}
          <Link href="/pages/privacy-policy" className="hover:underline">Privacy</Link> ·{' '}
          <Link href="/pages/returns-refunds" className="hover:underline">Refunds &amp; Cancellation</Link> ·{' '}
          <Link href="/pages/shipping-policy" className="hover:underline">Shipping</Link>
        </p>
      </article>

      <p className="mt-6 text-center text-xs text-gray-400">
        © {new Date().getFullYear()} {legalDisplayName(legal.name)}
      </p>
    </main>
  );
}
