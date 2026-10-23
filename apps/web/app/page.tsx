import type { Metadata } from 'next';
import type { HomePayload } from '@clowe/shared';
import JsonLd from '@/components/JsonLd';
import { serverApi } from '@/lib/serverApi';
import { serverPublicSettings } from '@/lib/serverSettings';
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo';
import HomeClient from './HomeClient';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

// The home payload is the same for every visitor (the API caches it for a
// minute), so it is fetched with the page and the first paint is complete.
// The site's name, search box and organisation are described for search
// engines here (WebSite + Organization).
export default async function HomePage() {
  const [home, settings] = await Promise.all([serverApi<HomePayload>('/api/home'), serverPublicSettings()]);
  return (
    <>
      <JsonLd data={[websiteJsonLd(), organizationJsonLd(settings)]} />
      <HomeClient initial={home} />
    </>
  );
}
