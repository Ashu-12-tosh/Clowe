import type { Metadata } from 'next';

// The page is a client component; its title and description are set here.
export const metadata: Metadata = {
  title: 'Track your order',
  description:
    'Track your Clowe order without logging in: enter your order number and the phone number used on it to see its status and the courier carrying your parcel.',
};

export default function TrackLayout({ children }: { children: React.ReactNode }) {
  return children;
}
