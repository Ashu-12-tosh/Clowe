import type { Metadata } from 'next';
import type { ProductDetail } from '@clowe/shared';
import { metaDescription, metaFetch } from '@/lib/pageMetadata';

// The page is a client component; its title and description are set here.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await metaFetch<ProductDetail>(`/api/products/${encodeURIComponent(slug)}`);
  if (!product) return {};
  return {
    title: product.title,
    description: metaDescription(
      product.shortDescription ?? product.description,
      `${product.title} — sold by an approved seller on Clowe.`,
    ),
  };
}

export default function ProductLayout({ children }: { children: React.ReactNode }) {
  return children;
}
