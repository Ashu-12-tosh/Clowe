import type { Metadata } from 'next';

// The listing is a client component; its title and description are set here.
// A product page below sets its own.
export const metadata: Metadata = {
  title: 'Shop all products',
  description:
    'Shop all products on Clowe: fashion, mobiles, electronics, home and kitchen, beauty and more from verified Indian sellers. Prices include GST, free delivery.',
};

export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
