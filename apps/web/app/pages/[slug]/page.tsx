import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CONTENT_PAGES, getContentPage, renderMarkdown } from '@/lib/contentPages';

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
  const html = renderMarkdown(page.markdown);

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
