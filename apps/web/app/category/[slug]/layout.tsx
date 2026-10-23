import type { Metadata } from 'next';
import type { CategoryDetail } from '@clowe/shared';
import { metaFetch } from '@/lib/pageMetadata';
import { DESCRIPTION_FILL, seoDescription } from '@/lib/seo';
import { serverApi } from '@/lib/serverApi';
import { InitialCategoryProvider } from './InitialCategory';

// The page is a client component; its title and description are set here.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const category = await metaFetch<CategoryDetail>(`/api/categories/${encodeURIComponent(slug)}`);
  if (!category) return {};
  const description = seoDescription({
    lead: `Shop ${category.name} on Clowe from verified Indian sellers`,
    body: category.description,
    fill: DESCRIPTION_FILL,
  });
  return {
    title: category.name,
    description,
    alternates: { canonical: `/category/${category.slug}` },
    openGraph: { title: `${category.name} | Clowe`, description, url: `/category/${category.slug}` },
  };
}

export default async function CategoryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const category = await serverApi<CategoryDetail>(`/api/categories/${encodeURIComponent(slug)}`);
  return <InitialCategoryProvider value={category}>{children}</InitialCategoryProvider>;
}
