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
  { slug: 'brand-protection', title: 'Protect and Build Your Brand', description: 'Brand verification, takedowns and counterfeit protection on Clowe.' },
  { slug: 'supply', title: 'Supply to Clowe', description: 'Manufacture or wholesale clothing? Partner with Clowe.' },
  { slug: 'advertise', title: 'Advertise Your Products', description: 'Promoted placements for sellers — clearly labeled, admin-reviewed.' },
  { slug: 'app', title: 'Clowe App', description: 'The Clowe mobile app — coming soon.' },
  { slug: 'help', title: 'Help Centre', description: 'Quick answers about orders, returns, accounts and selling.' },
  // Marketplace footer pages
  { slug: 'blog', title: 'Clowe Blog', description: 'Stories, launches and shopping guides from Clowe.' },
  { slug: 'faq', title: 'FAQ', description: 'Frequently asked questions about shopping on Clowe.' },
  { slug: 'cancellation', title: 'Cancellation Policy', description: 'When an order can be cancelled, by whom, and how the refund is made.' },
  { slug: 'privacy-policy', title: 'Privacy Policy', description: 'How Clowe handles your data.' },
  { slug: 'terms-conditions', title: 'Terms and Conditions of Use', description: 'The terms that govern using cloweshop.com.' },
  { slug: 'customer-terms-of-sale', title: 'Customer Terms of Sale', description: 'The terms of every purchase on Clowe.' },
  { slug: 'shipping-policy', title: 'Shipping and Delivery Policy', description: 'Where we deliver, how long it takes, charges and tracking.' },
  { slug: 'return-policy', title: 'Return, Exchange and Refund Policy', description: 'What can be returned or exchanged, by when, and how refunds are made.' },
  { slug: 'payment-policy', title: 'Payment Policy', description: 'Accepted payment methods and how refunds are paid.' },
  { slug: 'cookie-policy', title: 'Cookie Policy', description: 'How Clowe uses cookies and local storage.' },
  { slug: 'seller-terms', title: 'Vendor Terms and Seller Agreement', description: 'The agreement every seller on Clowe accepts.' },
  { slug: 'seller-fees', title: 'Seller Fees', description: 'What it costs to sell on Clowe: commission, fixed fees, courier charges and tax deducted by law.' },
  { slug: 'grievance-redressal', title: 'Customer Support and Grievance Policy', description: 'How to reach support, escalate a complaint, and contact our Grievance Officer.' },
];

/** True for a slug that has a page. */
export function isContentPageSlug(slug: string): boolean {
  return CONTENT_PAGES.some((p) => p.slug === slug);
}
