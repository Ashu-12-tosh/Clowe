import type { Metadata } from 'next';

// The page is a client component; its title and description are set here.
export const metadata: Metadata = {
  title: 'AI search',
  description:
    'Search Clowe in your own words with AI: describe what you want, your budget or the occasion, and get matching products from our catalogue in a few seconds.',
};

export default function AiSearchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
