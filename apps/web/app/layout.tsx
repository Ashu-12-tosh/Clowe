import type { Metadata } from 'next';
import localFont from 'next/font/local';
import CookieConsent from '@/components/CookieConsent';
import AppShell from '@/components/AppShell';
import SupportChat from '@/components/SupportChat';
import Toaster from '@/components/Toaster';
import { serverPublicSettings } from '@/lib/serverSettings';
import { HOME_DESCRIPTION } from '@/lib/seo';
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

// Every page renders per request: the Content-Security-Policy nonce
// (middleware.ts) is fresh each time, and a page built ahead of time would
// carry inline scripts without it.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Clowe — Everything you need, one marketplace',
    template: '%s | Clowe',
  },
  description: HOME_DESCRIPTION,
  keywords: ['online shopping', 'marketplace', 'electronics', 'mobiles', 'fashion', 'home', 'beauty', 'books', 'AI try-on', 'India'],
  openGraph: {
    title: 'Clowe — Everything you need, one marketplace',
    description: HOME_DESCRIPTION,
    type: 'website',
    siteName: 'Clowe',
    locale: 'en_IN',
    // The Clowe Shop wordmark, gold on near-black, 1200x630.
    images: [{ url: '/brand/og-image.png', width: 1200, height: 630, alt: 'Clowe Shop' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Clowe — Everything you need, one marketplace',
    description: HOME_DESCRIPTION,
    images: ['/brand/og-image.png'],
  },
  robots: { index: true, follow: true },
  // The round Clowe mark everywhere a browser or search engine looks for one.
  // Declared here (the files live in public/) so each link states its real
  // sizes: Google wants a square favicon of 48 px or a multiple of it.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/brand/icon.svg', type: 'image/svg+xml' },
      { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The legal entity goes into the first HTML, so the footer's registered name
  // and address are there for every visitor and crawler, with or without JS.
  const legal = (await serverPublicSettings())?.legalEntity ?? null;
  return (
    <html lang="en" className={`${inter.variable} ${cormorant.variable}`}>
      <body className="min-h-screen bg-cream-50 font-sans text-ink-900 antialiased">
        <AppShell legal={legal}>{children}</AppShell>
        <SupportChat />
        <Toaster />
        <CookieConsent />
      </body>
    </html>
  );
}
