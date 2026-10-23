import type { Metadata } from 'next';
import type { ProductDetail } from '@clowe/shared';
import JsonLd from '@/components/JsonLd';
import { metaFetch } from '@/lib/pageMetadata';
import { DESCRIPTION_FILL, DESCRIPTION_MAX, productJsonLd, seoDescription } from '@/lib/seo';

const productFor = (slug: string) => metaFetch<ProductDetail>(`/api/products/${encodeURIComponent(slug)}`);

// The page is a client component; its title and description are set here.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await productFor(slug);
  if (!product) return {};
  // The seller's own snippet when it is a full one; otherwise the product, as
  // much of its own pitch as fits, and who sells it.
  const own = product.metaDescription?.replace(/\s+/g, ' ').trim() ?? '';
  const description =
    own.length >= 120 && own.length <= DESCRIPTION_MAX
      ? own
      : seoDescription({
          lead: product.title,
          body: product.shortDescription || product.description,
          keep: [`Sold by ${product.seller.shopName} on Clowe, with free delivery`],
          fill: DESCRIPTION_FILL,
        });
  // A shared link previews with the product's own first photo.
  const image = product.images[0]?.url;
  return {
    title: product.metaTitle?.trim() || product.title,
    description,
    alternates: { canonical: `/products/${product.slug}` },
    // Clowe's own test listing: reachable by its link, kept out of search engines.
    ...(product.testOnly ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      title: product.title,
      description,
      siteName: 'Clowe',
      type: 'website',
      url: `/products/${product.slug}`,
      ...(image ? { images: [{ url: image, alt: product.title }] } : {}),
    },
  };
}

// Product + Offer for search results (price, stock, seller). The same cached
// read as the metadata above, so it costs no second request.
export default async function ProductLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await productFor(slug);
  const data = product ? productJsonLd(product) : null;
  return (
    <>
      {data && <JsonLd data={data} />}
      {children}
    </>
  );
}
