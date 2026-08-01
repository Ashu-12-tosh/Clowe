/**
 * All FAQ content for the support bot lives here — edit answers, keywords,
 * and follow-up chips without touching bot logic (lib/support/engine.ts).
 *
 * `followUps` are chip ids shown after the answer: any FaqEntry id, or the
 * special ids 'menu', 'complaint', 'helped', 'order-status', 'return-cancel'.
 */

export interface FaqEntry {
  id: string;
  /** Chip label shown in menus. */
  label: string;
  /** Keywords for typed-text matching (lowercase). */
  keywords: string[];
  /** Bot answer (use \n\n for paragraphs). */
  answer: string;
  /** Optional deep links rendered as buttons under the answer. */
  links?: { label: string; href: string }[];
  followUps: string[];
}

export const FAQ_ENTRIES: FaqEntry[] = [
  {
    id: 'address-change',
    label: 'How to change my address',
    keywords: ['address', 'pata', 'delivery address', 'change address', 'new address', 'shift'],
    answer:
      'Changing your delivery address is easy:\n\n1. Go to Checkout (or your Account page)\n2. Tap "+ Add new address"\n3. Fill in the new address and save — it becomes available at checkout\n\nNote: for an order that is already placed, the address cannot be changed once the seller ships it. If it has not shipped yet, cancel the order and re-order with the new address.',
    links: [{ label: 'Open my account', href: '/account' }],
    followUps: ['helped', 'menu', 'complaint'],
  },
  {
    id: 'phone-change',
    label: 'How to change my phone number',
    keywords: ['phone', 'number', 'mobile', 'change number', 'naya number'],
    answer:
      'Your phone number is your login ID, so it cannot be changed from the app yet.\n\nIf you have a new number, please raise a complaint with category "Account issue" and our team will help migrate your account — your orders, wishlist, and credits stay safe.',
    followUps: ['complaint', 'menu'],
  },
  {
    id: 'payment-refund',
    label: 'Payment & refund questions',
    keywords: ['payment', 'refund', 'paisa', 'money', 'upi', 'card', 'paid', 'charged', 'debit'],
    answer:
      'Payments on Clowe are processed securely via Razorpay (UPI, cards, netbanking).\n\n• Payment failed but money deducted? It is auto-refunded by your bank, usually within 5–7 business days. /* TODO: confirm real refund timeline */\n• Refund for a cancelled order: initiated immediately, reflects in 5–7 business days. /* TODO: confirm */\n• Refund for a returned item: processed after the seller receives the item back.\n\nCash on Delivery (COD) is not available yet. /* TODO: update when COD launches */',
    followUps: ['helped', 'complaint', 'menu'],
  },
  {
    id: 'tryon',
    label: 'How does AI Try-On work?',
    keywords: ['try on', 'tryon', 'try-on', 'virtual', 'photo', 'ai photo', 'dekh'],
    answer:
      'AI Try-On ✨ lets you see clothes on yourself before buying:\n\n1. Upload one full-body photo (Account → My Try-On Photo)\n2. Open any product and tap "Try On Me"\n3. Our AI generates a preview of you wearing it!\n\nPhoto tips: front-facing, full body, good lighting, plain background, no sunglasses. You get 10 try-ons per day. /* TODO: confirm daily limit if changed */',
    links: [{ label: 'Set my try-on photo', href: '/account' }],
    followUps: ['helped', 'menu'],
  },
  {
    id: 'seller',
    label: 'How to become a seller',
    keywords: ['seller', 'sell', 'shop', 'business', 'bechna', 'register shop', 'dukan'],
    answer:
      'Selling on Clowe is free:\n\n1. Open "Sell on Clowe" and tap Register\n2. Fill your shop name + KYC details, verify your phone via OTP\n3. Our team reviews your application (usually within a day) /* TODO: confirm review SLA */\n4. Once approved, list products — our AI even writes descriptions for you!',
    links: [
      { label: 'Why sell on Clowe', href: '/sell' },
      { label: 'Register now', href: '/seller/register' },
    ],
    followUps: ['helped', 'menu'],
  },
  {
    id: 'shipping',
    label: 'Shipping & delivery times',
    keywords: ['shipping', 'delivery', 'kitne din', 'deliver', 'courier', 'kab aayega', 'time'],
    answer:
      'Shipping on Clowe:\n\n• FREE shipping on orders of ₹999 or more; ₹49 below that /* TODO: confirm threshold */\n• Sellers usually ship within 1–2 days /* TODO: confirm */\n• Delivery takes 3–7 days depending on your pincode /* TODO: confirm */\n\nOnce shipped, you get the courier name + AWB number and can track without login on the Track page.',
    links: [{ label: 'Track my order', href: '/track' }],
    followUps: ['order-status', 'helped', 'menu'],
  },
  {
    id: 'returns-policy',
    label: 'Return policy & window',
    keywords: ['return policy', 'wapas', 'exchange', 'return window', 'galat size', 'size'],
    answer:
      'Returns are simple:\n\n• Request a return within 7 days of delivery /* TODO: confirm return window */\n• Go to Orders → open the order → "Request return" on the delivered item\n• Refund is processed after the seller receives the item back\n\nItems should be unused with tags intact. Size guide is available on each product page under details.',
    links: [{ label: 'My orders', href: '/orders' }],
    followUps: ['return-cancel', 'helped', 'menu'],
  },
];

/** Main menu — order matters. Special ids are handled by the engine. */
export const MAIN_MENU: { id: string; label: string }[] = [
  { id: 'order-status', label: '📦 Where is my order?' },
  { id: 'return-cancel', label: '↩️ Return / Cancel an order' },
  { id: 'address-change', label: '🏠 Change my address' },
  { id: 'phone-change', label: '📱 Change my phone number' },
  { id: 'payment-refund', label: '💳 Payment & refunds' },
  { id: 'tryon', label: '✨ How does AI Try-On work?' },
  { id: 'seller', label: '🏪 How to become a seller' },
  { id: 'complaint', label: '📢 Raise a complaint' },
  { id: 'else', label: '💬 Talk about something else' },
];

export const GREETING =
  'Hi! 👋 I\'m the Clowe assistant. Choose a topic below — or type your question.';

export const FALLBACK_MESSAGE =
  "I didn't get that. Please choose an option below or raise a complaint.";
