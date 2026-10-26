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
  { slug: 'about', title: 'About Clowe', description: 'Clowe is an Indian online marketplace run by CLOWE PARTNERS LLP: fashion, mobiles, electronics and home goods from verified sellers, with AI try-on for clothes.' },
  { slug: 'careers', title: 'Careers', description: 'Careers at Clowe: help build an Indian online marketplace with verified sellers, AI try-on for fashion and free delivery. Find out how to reach us about roles.' },
  { slug: 'press', title: 'Press Releases', description: 'Clowe press releases and media resources: news about our Indian online marketplace, verified sellers and AI try-on for fashion, and contacts for journalists.' },
  { slug: 'science', title: 'Clowe Science', description: 'The technology behind Clowe: how AI virtual try-on shows clothes on your own photo, and how search and recommendations help you find products you will love.' },
  { slug: 'brand-protection', title: 'Protect and Build Your Brand', description: 'Protect your brand on Clowe: brand authorisation for listings, takedowns of counterfeit or copied products, and how to report a listing that misuses your brand.' },
  { slug: 'supply', title: 'Supply to Clowe', description: 'Supply to Clowe: manufacturers and wholesalers of clothing and other goods can work with sellers on our Indian online marketplace. Find out how to reach us.' },
  { slug: 'advertise', title: 'Advertise Your Products', description: 'Advertise on Clowe: sellers can promote their own products in clearly labelled sponsored placements, each reviewed by our team. See placements and how to start.' },
  { slug: 'help', title: 'Help Centre', description: 'Clowe Help Centre: quick answers on placing and tracking orders, cancellations, returns, refunds, payments, your account and selling, and how to reach support.' },
  // Marketplace footer pages
  { slug: 'faq', title: 'FAQ', description: 'Answers to common questions about shopping on Clowe: orders, delivery times, tracking, cancellations, returns and refunds, payments, AI try-on and your account.' },
  { slug: 'cancellation', title: 'Cancellation Policy', description: 'Clowe cancellation policy: when you or a seller can cancel an order before it ships, what happens once it is dispatched, and how and when your refund is made.' },
  { slug: 'privacy-policy', title: 'Privacy Policy', description: 'Clowe privacy policy: the personal data we collect when you shop or sell, why we use it, who we share it with, how long we keep it and how to use your rights.' },
  { slug: 'terms-conditions', title: 'Terms and Conditions of Use', description: 'Terms and conditions for using cloweshop.com: your account, acceptable use, listings by independent sellers, intellectual property, liability and disputes.' },
  { slug: 'customer-terms-of-sale', title: 'Customer Terms of Sale', description: 'Customer terms of sale on Clowe: who sells to you, prices including GST, payment, delivery, cancellations, returns and refunds, and your rights as a buyer.' },
  { slug: 'shipping-policy', title: 'Shipping and Delivery Policy', description: 'Clowe shipping and delivery policy: free delivery on every order, where we deliver in India, typical delivery times, dispatch by sellers and parcel tracking.' },
  { slug: 'return-policy', title: 'Return, Exchange and Refund Policy', description: 'Clowe return, exchange and refund policy: what qualifies, the 48-hour window to report a damaged, defective or wrong item, free pickup and how refunds are paid.' },
  { slug: 'payment-policy', title: 'Payment Policy', description: 'Clowe payment policy: pay securely by UPI, card or net banking through certified payment gateways, prices include GST, and how failed payments and refunds work.' },
  { slug: 'cookie-policy', title: 'Cookie Policy', description: 'Clowe cookie policy: the cookies and local storage cloweshop.com uses, which are strictly necessary and which are optional, and how to change your choice.' },
  { slug: 'seller-terms', title: 'Vendor Terms and Seller Agreement', description: 'Vendor terms and seller agreement for Clowe: registration, listings, orders and dispatch, fees, payouts, returns, KYC and what every seller agrees to.' },
  { slug: 'seller-fees', title: 'Seller Fees', description: 'Selling on Clowe: the referral fee by category and price, fixed fees, courier charges, GST on our fees and tax deducted by law (TDS, TCS), with worked examples.' },
  { slug: 'delivery-charges', title: 'Delivery Charges Explained', description: 'What sellers pay Delhivery on Clowe: forward, RTO and return pickup charges, volumetric weight, example rates, and where to see each charge. Buyers never pay.' },
  { slug: 'grievance-redressal', title: 'Customer Support and Grievance Policy', description: 'Clowe support and grievance policy: how to contact support, escalate a complaint and reach our Grievance Officer, and the time limits we follow to resolve it.' },
];

/** True for a slug that has a page. */
/** Pages under /pages/ built from data rather than markdown (their own route). */
export const DATA_PAGE_SLUGS = ['referral-fee-schedule'];

export function isContentPageSlug(slug: string): boolean {
  return CONTENT_PAGES.some((p) => p.slug === slug) || DATA_PAGE_SLUGS.includes(slug);
}
