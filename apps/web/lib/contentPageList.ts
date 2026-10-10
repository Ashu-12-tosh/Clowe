/**
 * The content pages under /pages/<slug>: their slugs and titles. Kept apart
 * from contentPages.ts, which reads the markdown from disk, so the middleware
 * (edge runtime, no file system) can tell a real slug from a missing one and
 * answer the missing one with a 404 before anything renders.
 */
export interface ContentPageMeta {
  slug: string;
  title: string;
  description: string;
}

export const CONTENT_PAGES: ContentPageMeta[] = [
  { slug: 'about', title: 'About Clowe', description: 'Who we are and why we built fashion you can try on yourself.' },
  { slug: 'careers', title: 'Careers', description: 'Join the team building AI-powered fashion commerce.' },
  { slug: 'press', title: 'Press Releases', description: 'Clowe announcements and media resources.' },
  { slug: 'science', title: 'Clowe Science', description: 'The AI technology behind virtual try-on and recommendations.' },
  { slug: 'accelerator', title: 'Clowe Accelerator', description: 'A growth program for ambitious sellers on Clowe.' },
  { slug: 'brand-protection', title: 'Protect and Build Your Brand', description: 'Brand verification, takedowns and counterfeit protection on Clowe.' },
  { slug: 'supply', title: 'Supply to Clowe', description: 'Manufacture or wholesale clothing? Partner with Clowe.' },
  { slug: 'advertise', title: 'Advertise Your Products', description: 'Promoted placements for sellers — clearly labeled, admin-reviewed.' },
  { slug: 'recalls', title: 'Recalls and Product Safety Alerts', description: 'Product recalls and safety notices on Clowe.' },
  { slug: 'purchase-protection', title: '100% Purchase Protection', description: 'Refunds, returns and payment protection on every Clowe order.' },
  { slug: 'app', title: 'Clowe App', description: 'The Clowe mobile app — coming soon.' },
  { slug: 'help', title: 'Help Centre', description: 'Quick answers about orders, returns, accounts and selling.' },
  // Marketplace footer pages
  { slug: 'blog', title: 'Clowe Blog', description: 'Stories, launches and shopping guides from Clowe.' },
  { slug: 'affiliate', title: 'Affiliate Program', description: 'Earn by recommending Clowe products.' },
  { slug: 'faq', title: 'FAQ', description: 'Frequently asked questions about shopping on Clowe.' },
  { slug: 'shipping-info', title: 'Shipping Info', description: 'Delivery timelines, charges and coverage.' },
  { slug: 'returns-refunds', title: 'Returns & Refunds', description: 'How returns and refunds work on Clowe.' },
  { slug: 'cancellation', title: 'Cancellation', description: 'Cancelling an order before it ships.' },
  { slug: 'privacy-policy', title: 'Privacy Policy', description: 'How Clowe handles your data.' },
  { slug: 'terms-conditions', title: 'Terms & Conditions', description: 'The terms that govern using Clowe.' },
  { slug: 'shipping-policy', title: 'Shipping Policy', description: 'Our shipping commitments in detail.' },
  { slug: 'return-policy', title: 'Return Policy', description: 'Eligibility windows and conditions for returns.' },
  { slug: 'payment-policy', title: 'Payment Policy', description: 'Accepted payment methods and how refunds are paid.' },
  { slug: 'cookie-policy', title: 'Cookie Policy', description: 'How Clowe uses cookies and local storage.' },
];

/** True for a slug that has a page. */
export function isContentPageSlug(slug: string): boolean {
  return CONTENT_PAGES.some((p) => p.slug === slug);
}
