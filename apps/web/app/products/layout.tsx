import type { Metadata } from 'next';

// The listing is a client component; its title and description are set here.
// A product page below sets its own.
export const metadata: Metadata = {
  title: 'Shop all products',
  description: 'Browse products from approved sellers on Clowe — fashion, electronics, home, beauty, books and more.',
};

export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
