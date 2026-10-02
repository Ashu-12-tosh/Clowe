import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fillReturnWindow, type PublicSettings } from '@clowe/shared';
import { CONTENT_PAGES, getContentPage, renderMarkdown } from '@/lib/contentPages';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * The platform return window, for the policy and help pages to quote. Null
 * when the API cannot be reached: the page then says "the window shown on
 * the product page" rather than guess a number.
 */
async function returnWindowDays(): Promise<number | null> {
  try {
    const res = await fetch(`${API_URL}/api/settings/public`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Partial<PublicSettings> };
    return json.data?.returnWindowDays ?? null;
  } catch {
    return null;
  }
}

interface Props {
  params: Promise<{ slug: string }>;
}

// No generateStaticParams: every page renders per request so its scripts carry
// that request's CSP nonce, and since Next 15 a page with static params is
// prerendered whatever the root layout says. Unknown slugs still 404 below.

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = CONTENT_PAGES.find((p) => p.slug === slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default async function ContentPage({ params }: Props) {
  const { slug } = await params;
  const page = getContentPage(slug);
  if (!page) notFound();

  // The markdown's own "# heading" renders as the page title.
  const html = renderMarkdown(fillReturnWindow(page.markdown, await returnWindowDays()));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {/* Breadcrumb */}
      <nav className="text-xs text-gray-400" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-brand-600 hover:underline">
          Home
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-600">{page.title}</span>
      </nav>

      <article
        className="mt-4 rounded-3xl border border-gray-100 bg-white p-6 sm:p-10"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <p className="mt-6 text-center text-xs text-gray-400">
        Questions? Use the support chat — we&apos;re happy to help.
      </p>
    </main>
  );
}
