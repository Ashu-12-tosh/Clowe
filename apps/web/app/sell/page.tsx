import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Sell on Clowe',
  description:
    'Grow your clothing business on Clowe — AI try-on for your products, free AI listing tools, easy shipping, and secure payouts.',
};

const BENEFITS = [
  {
    icon: '🛍',
    title: 'Growing customer base',
    text: 'Reach fashion shoppers across India. Your products appear in search, filters, and AI-powered voice search from day one.',
  },
  {
    icon: '✨',
    title: 'Customers try YOUR clothes with AI',
    text: 'Clowe’s exclusive "Try On Me" lets buyers see your products on their own photo — more confidence, more sales, fewer returns.',
  },
  {
    icon: '🤖',
    title: 'Free AI listing tools',
    text: 'No copywriter needed — enter a title and our AI writes a professional product description for you in one click.',
  },
  {
    icon: '💰',
    title: 'Secure & fast payments',
    text: 'Payments are collected securely via Razorpay (UPI, cards, netbanking) and tracked transparently in your dashboard.',
  },
  {
    icon: '🚚',
    title: 'Effortless shipping',
    text: 'One click on "Mark shipped" books your courier automatically — AWB number and tracking are generated for you.',
  },
  {
    icon: '📊',
    title: 'Powerful seller dashboard',
    text: 'Live sales stats, revenue, low-stock alerts, order management, and per-item shipping — all in one clean panel.',
  },
  {
    icon: '🛡',
    title: 'Trusted, verified marketplace',
    text: 'Every seller and every listing is reviewed and approved — shoppers trust Clowe, and that trust sells your products.',
  },
  {
    icon: '🎁',
    title: 'Built-in growth engine',
    text: 'Referral rewards, wishlists, reviews with AI summaries, and notifications bring customers back to your listings.',
  },
];

const STEPS = [
  { step: '1', title: 'Register your shop', text: '2-minute application — shop name and basic KYC details.' },
  { step: '2', title: 'Get approved', text: 'Our team reviews and approves your shop, usually within a day.' },
  { step: '3', title: 'List your products', text: 'Add photos and variants; let AI write the descriptions.' },
  { step: '4', title: 'Ship & get paid', text: 'Ship with auto-booked couriers and watch revenue grow in your dashboard.' },
];

export default function SellLandingPage() {
  return (
    <main>
      {/* Page top bar: title + Register (top right) */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <p className="text-lg font-bold text-brand-900">
            Sell on <span className="text-brand-600">Clowe</span>
          </p>
          <div className="flex items-center gap-3">
            <Link
              href="/seller/login"
              className="rounded-lg border border-brand-600 px-5 py-2.5 text-sm font-semibold text-brand-600 hover:bg-brand-100"
            >
              Seller Login
            </Link>
            <Link
              href="/seller/register"
              className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white shadow hover:bg-brand-700"
            >
              Register →
            </Link>
          </div>
        </div>
      </div>

      {/* Hero */}
      <section className="bg-gradient-to-r from-purple-600 to-brand-600 text-white">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Grow your clothing business on Clowe
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg opacity-90">
            India&apos;s AI-powered fashion marketplace — where customers don&apos;t just see your
            products, they <span className="font-semibold">try them on virtually</span> before
            buying.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/seller/register"
              className="rounded-lg bg-white px-8 py-3 text-sm font-bold text-brand-600 shadow-lg hover:bg-gray-100"
            >
              Start selling today
            </Link>
            <span className="text-sm opacity-80">Free to register · No listing fees</span>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-center text-2xl font-bold">Why sellers choose Clowe</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {BENEFITS.map((benefit) => (
            <div key={benefit.title} className="rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-brand-600 hover:shadow-md">
              <span className="text-3xl">{benefit.icon}</span>
              <h3 className="mt-3 text-sm font-bold">{benefit.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600">{benefit.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-white py-14">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-2xl font-bold">Start selling in 4 easy steps</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.step} className="text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-lg font-bold text-brand-600">
                  {s.step}
                </span>
                <h3 className="mt-3 text-sm font-bold">{s.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="mx-auto max-w-6xl px-4 py-14 text-center">
        <h2 className="text-2xl font-bold">Ready to grow with Clowe?</h2>
        <p className="mt-2 text-sm text-gray-600">
          Join sellers already using AI try-on to sell more clothes with fewer returns.
        </p>
        <Link
          href="/seller/register"
          className="mt-6 inline-block rounded-lg bg-brand-600 px-10 py-3 text-sm font-bold text-white shadow hover:bg-brand-700"
        >
          Register your shop →
        </Link>
      </section>
    </main>
  );
}
