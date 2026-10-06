import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { fillLegalEntity, fillReturnWindow } from '@clowe/shared';
import { CONTENT_PAGES, getContentPage, renderMarkdown } from '@/lib/contentPages';
import { serverPublicSettings } from '@/lib/serverSettings';

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
  // Contact Us lives at /contact; this is where people (and gateways) guess it.
  if (slug === 'contact') permanentRedirect('/contact');
  const page = getContentPage(slug);
  if (!page) notFound();

  // The return window and the legal entity come from settings. Without the
  // API, the window reads "the window shown on the product page" and only the
  // registered name is filled in — the other legal lines drop out.
  const settings = await serverPublicSettings();
  const markdown = fillLegalEntity(
    fillReturnWindow(page.markdown, settings?.returnWindowDays ?? null),
    settings?.legalEntity,
  );
  // The markdown's own "# heading" renders as the page title.
  const html = renderMarkdown(markdown);

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
