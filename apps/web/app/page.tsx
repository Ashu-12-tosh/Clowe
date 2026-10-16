import type { HomePayload } from '@clowe/shared';
import { serverApi } from '@/lib/serverApi';
import HomeClient from './HomeClient';

// The home payload is the same for every visitor (the API caches it for a
// minute), so it is fetched with the page and the first paint is complete.
export default async function HomePage() {
  return <HomeClient initial={await serverApi<HomePayload>('/api/home')} />;
}
