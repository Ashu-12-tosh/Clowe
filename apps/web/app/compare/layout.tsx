import type { Metadata } from 'next';

// The page is a client component; its title and description are set here.
export const metadata: Metadata = {
  title: 'Compare products',
  description:
    'Compare products on Clowe side by side: price including GST, key details and delivery to your PIN code for the items you shortlisted, all in one simple table.',
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
