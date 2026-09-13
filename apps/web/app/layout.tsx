import type { Metadata } from 'next';
import localFont from 'next/font/local';
import AppShell from '@/components/AppShell';
import SupportChat from '@/components/SupportChat';
import './globals.css';

// Inter carries ~90% of the UI; Cormorant Garamond is reserved for brand
// moments (logo, hero campaigns, editorial banners).
// Both are self-hosted variable fonts (SIL OFL 1.1, see ./fonts). Using
// next/font/local instead of next/font/google means dev compiles and builds
// never wait on a Google Fonts download, and visitors make no third-party
// font requests.
const inter = localFont({
  src: './fonts/inter-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-sans',
  display: 'swap',
});
const cormorant = localFont({
  src: './fonts/cormorant-garamond-latin-wght-normal.woff2',
  weight: '300 700',
  variable: '--font-display',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4300'),
  title: {
    default: 'Clowe — Everything you need, one marketplace',
    template: '%s | Clowe',
  },
  description:
    'Multi-vendor online marketplace for electronics, mobiles, fashion, home & kitchen, beauty, books, groceries and more — with AI virtual try-on on fashion.',
  keywords: ['online shopping', 'marketplace', 'electronics', 'mobiles', 'fashion', 'home', 'beauty', 'books', 'AI try-on', 'India'],
  openGraph: {
    title: 'Clowe — Everything you need, one marketplace',
    description: 'Electronics, fashion, home, beauty, books and more from trusted sellers - with AI try-on on fashion.',
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
