import type { Metadata } from 'next';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import SupportChat from '@/components/SupportChat';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Clowe — Fashion, tried on by you',
    template: '%s | Clowe',
  },
  description:
    'Multi-vendor clothing marketplace with AI virtual try-on. Shop t-shirts, dresses, jeans and more — and see them on yourself before you buy.',
  keywords: ['clothing', 'fashion', 'online shopping', 'AI try-on', 'virtual try-on', 'India'],
  openGraph: {
    title: 'Clowe — Fashion, tried on by you',
    description: 'Shop clothing with AI virtual try-on. See it on yourself before you buy.',
    type: 'website',
    siteName: 'Clowe',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <Header />
        {children}
        <Footer />
        <SupportChat />
      </body>
    </html>
  );
}
