import type { Metadata } from 'next';
import Link from 'next/link';
import { DEFAULT_LEGAL_ENTITY, legalEntityType } from '@clowe/shared';
import { serverPublicSettings } from '@/lib/serverSettings';

export const metadata: Metadata = {
  title: 'Contact Us',
  description:
    'Contact Clowe: support emails for shoppers and sellers, phone numbers, our registered office in New Delhi and how to take a complaint to the Grievance Officer.',
};

/**
 * Contact Us: the support emails (shoppers, sellers, general), the phones, the
 * business details (legal name, entity type, LLPIN, registered address) and
 * the way to the Grievance Officer — all from the settings (admin → settings);
 * a field left empty there is not shown. The GSTIN stays in the legal documents.
 */
export default async function ContactPage() {
  const settings = await serverPublicSettings();
  const legal = { ...DEFAULT_LEGAL_ENTITY, ...(settings?.legalEntity ?? {}) };

  // The link scheme is fixed here, never taken from the stored value.
  const reach = [
    settings?.supportEmails?.customer?.trim() && { kind: 'email' as const, icon: '🛍', label: 'Shopping help', value: settings.supportEmails.customer },
    settings?.supportEmails?.vendor?.trim() && { kind: 'email' as const, icon: '🏪', label: 'Seller help', value: settings.supportEmails.vendor },
    legal.supportEmail.trim() && { kind: 'email' as const, icon: '✉️', label: 'General & grievances', value: legal.supportEmail },
    legal.supportPhone.trim() && { kind: 'phone' as const, icon: '📞', label: 'Phone & WhatsApp', value: legal.supportPhone },
    legal.supportPhoneAlt.trim() && { kind: 'phone' as const, icon: '📞', label: 'Phone', value: legal.supportPhoneAlt },
  ].filter((row): row is { kind: 'email' | 'phone'; icon: string; label: string; value: string } => Boolean(row));

  // A field left empty in the settings is left out, never shown blank.
  const businessDetails = [
    { label: 'Legal name', value: legal.name },
    { label: 'Entity type', value: legalEntityType(legal.name) },
    { label: 'LLPIN', value: legal.llpin },
    { label: 'Registered address', value: legal.registeredAddress },
    { label: 'Support email', value: legal.supportEmail },
    { label: 'Support phone', value: [legal.supportPhone, legal.supportPhoneAlt].filter((p) => p.trim()).join(', ') },
  ].filter((row) => row.value.trim());

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <nav className="text-xs text-gray-400" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-brand-600 hover:underline">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600">Contact Us</span>
      </nav>

      <article className="mt-4 rounded-3xl border border-gray-100 bg-white p-5 sm:p-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink-900">Contact Us</h1>
        <p className="mt-3 leading-relaxed text-gray-700">
          cloweshop.com is operated by <strong>{legal.name}</strong>. We&apos;re here to help with orders,
          returns, payments and selling on Clowe.
        </p>

        {reach.length > 0 && (
          <section className="mt-8 grid gap-4 sm:grid-cols-2">
            {reach.map((row) => (
              <a
                key={row.label}
                href={row.kind === 'email' ? `mailto:${row.value}` : `tel:${row.value.replace(/[^\d+]/g, '')}`}
                // An email takes the full width: half a column is narrower than the
                // longest address, which then ran out of its card on a computer.
                className={`flex min-w-0 items-center gap-4 rounded-2xl border border-gray-100 bg-cream-100 p-4 transition hover:border-brand-600 sm:p-5 ${row.kind === 'email' ? 'sm:col-span-2' : ''}`}
                data-contact-card={row.kind}
              >
                <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-xl sm:flex">
                  {row.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold uppercase tracking-wide text-gray-500">{row.label}</span>
                  {/* One line on a phone too: an email never breaks at its hyphen. */}
                  <span className="block whitespace-nowrap text-sm font-semibold text-ink-900 sm:text-base">{row.value}</span>
                </span>
              </a>
            ))}
          </section>
        )}

        {/* Who runs the site — what a payment gateway checks for, as plain text. */}
        <section className="mt-8 rounded-2xl border border-gray-100 p-5 sm:p-6" data-business-details>
          <h2 className="font-display text-xl font-bold text-ink-900">Business details</h2>
          <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
            {businessDetails.map((row) => (
              <div key={row.label} className="contents">
                <dt className="font-semibold text-gray-500">{row.label}</dt>
                <dd className="text-ink-900">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-8">
          <h2 className="font-display text-xl font-bold text-ink-900">Grievance Officer</h2>
          <p className="mt-3 leading-relaxed text-gray-700">
            Complaint not resolved? Escalate it to our Nodal Officer and Grievance Officer — their details, and how
            quickly we respond, are in our{' '}
            <Link href="/pages/grievance-redressal" className="font-semibold text-brand-600 hover:underline">
              Customer Support and Grievance Policy
            </Link>
            .
          </p>
        </section>

      </article>
    </main>
  );
}
