import type { Metadata } from 'next';
import type { PublicStore } from '@clowe/shared';
import { metaFetch } from '@/lib/pageMetadata';
import { DESCRIPTION_FILL, seoDescription } from '@/lib/seo';

// A seller's storefront is a client component; its title and description are set here.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const store = await metaFetch<PublicStore>(`/api/stores/${encodeURIComponent(slug)}`);
  if (!store) return {};
  const place = [store.city, store.state].filter(Boolean).join(', ');
  return {
    title: store.shopName,
    description: seoDescription({
      // "Approved", not "verified": the Verified Seller badge waits for PAN, GSTIN and bank checks.
      lead: `Shop ${store.shopName}${place ? `, an approved seller from ${place},` : ''} on Clowe`,
      body: store.tagline || store.description,
      fill: DESCRIPTION_FILL,
    }),
    alternates: { canonical: `/store/${store.slug}` },
  };
}

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return children;
}
