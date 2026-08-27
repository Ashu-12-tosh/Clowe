import type { Metadata } from 'next';
import { Cormorant_Garamond, Inter } from 'next/font/google';
import AppShell from '@/components/AppShell';
import SupportChat from '@/components/SupportChat';
import './globals.css';

// Inter carries ~90% of the UI; Cormorant Garamond is reserved for brand
// moments (logo, hero campaigns, editorial banners).
const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});
const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

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
    <html lang="en" className={`${inter.variable} ${cormorant.variable}`}>
      <body className="min-h-screen bg-cream-50 font-sans text-ink-900 antialiased">
        <AppShell>{children}</AppShell>
        <SupportChat />
      </body>
    </html>
  );
}
