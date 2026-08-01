import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CONTENT_PAGES, getContentPage, renderMarkdown } from '@/lib/contentPages';

interface Props {
  params: { slug: string };
}

export function generateStaticParams() {
  return CONTENT_PAGES.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }: Props): Metadata {
  const page = CONTENT_PAGES.find((p) => p.slug === params.slug);
  if (!page) return {};
  return { title: page.title, description: page.description };
}

export default function ContentPage({ params }: Props) {
  const page = getContentPage(params.slug);
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
