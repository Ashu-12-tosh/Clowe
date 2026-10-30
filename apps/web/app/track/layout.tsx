import type { Metadata } from 'next';

// The page is a client component; its title and description are set here.
export const metadata: Metadata = {
  title: 'Track your order',
  description:
    'Track your Clowe order: enter your order number and the phone or email on it, and the code we send there, to see where each parcel is and when it will arrive.',
};

export default function TrackLayout({ children }: { children: React.ReactNode }) {
  return children;
}
