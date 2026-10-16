import type { Metadata } from 'next';
import type { CategoryDetail } from '@clowe/shared';
import { metaDescription, metaFetch } from '@/lib/pageMetadata';
import { serverApi } from '@/lib/serverApi';
import { InitialCategoryProvider } from './InitialCategory';

// The page is a client component; its title and description are set here.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const category = await metaFetch<CategoryDetail>(`/api/categories/${encodeURIComponent(slug)}`);
  if (!category) return {};
  return {
    title: category.name,
    description: metaDescription(category.description, `Shop ${category.name} from approved sellers on Clowe.`),
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
