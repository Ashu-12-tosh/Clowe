/**
 * All FAQ content for the support bot lives here — edit answers, keywords,
 * and follow-up chips without touching bot logic (lib/support/engine.ts).
 *
 * `followUps` are chip ids shown after the answer: any FaqEntry id, or the
 * special ids 'menu', 'complaint', 'helped', 'order-status', 'return-cancel'.
 */

export const FAQ_CATEGORIES = ['ORDERS', 'RETURNS', 'PAYMENTS', 'OFFERS', 'ACCOUNT'] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export const FAQ_CATEGORY_META: Record<
  FaqCategory,
  { title: string; blurb: string; icon: string }
> = {
  ORDERS: { title: 'Orders & Delivery', blurb: 'Track, cancel, return and more', icon: '📦' },
  RETURNS: { title: 'Returns & Refunds', blurb: 'Return, refund status and policies', icon: '↩' },
  PAYMENTS: { title: 'Payments & Wallet', blurb: 'Payment methods, failures, wallet & credits', icon: '💳' },
  OFFERS: { title: 'Offers & Coupons', blurb: 'Coupons, offers and promotions', icon: '🏷' },
  ACCOUNT: { title: 'Account & Security', blurb: 'Profile, login, security and privacy', icon: '👤' },
};

export interface FaqEntry {
  id: string;
  /** Which Help Center card this article sits under. */
  category: FaqCategory;
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
    category: 'ORDERS',
    label: 'How to change my address',
    keywords: ['address', 'pata', 'delivery address', 'change address', 'new address', 'shift'],
    answer:
      'Changing your delivery address is easy:\n\n1. Go to Checkout (or your Account page)\n2. Tap "+ Add new address"\n3. Fill in the new address and save — it becomes available at checkout\n\nNote: for an order that is already placed, the address cannot be changed once the seller ships it. If it has not shipped yet, cancel the order and re-order with the new address.',
    links: [{ label: 'Open my account', href: '/account' }],
    followUps: ['helped', 'menu', 'complaint'],
  },
  {
    id: 'phone-change',
    category: 'ACCOUNT',
    label: 'How to change my phone number',
    keywords: ['phone', 'number', 'mobile', 'change number', 'naya number'],
    answer:
      'You can change it yourself:\n\n1. Open Account Settings → Login & Security\n2. Enter your new 10-digit number and tap Send OTP\n3. Enter the OTP we send to the new number to confirm\n\nYour orders, wishlist and credits all stay with the account.',
    links: [{ label: 'Open Account Settings', href: '/account/settings' }],
    followUps: ['helped', 'menu', 'complaint'],
  },
  {
    id: 'payment-refund',
    category: 'PAYMENTS',
    label: 'Payment & refund questions',
    keywords: ['payment', 'refund', 'paisa', 'money', 'upi', 'card', 'paid', 'charged', 'debit'],
    answer:
      'Payments on Clowe are processed securely via Razorpay (UPI, cards, netbanking).\n\n• Payment failed but money deducted? It is auto-refunded by your bank, usually within 5–7 business days. /* TODO: confirm real refund timeline */\n• Refund for a cancelled order: initiated immediately, reflects in 5–7 business days. /* TODO: confirm */\n• Refund for a returned item: processed after the seller receives the item back.\n\nCash on Delivery (COD) is not available yet. /* TODO: update when COD launches */',
    followUps: ['helped', 'complaint', 'menu'],
  },
  {
    id: 'tryon',
    category: 'ACCOUNT',
    label: 'How does AI Try-On work?',
    keywords: ['try on', 'tryon', 'try-on', 'virtual', 'photo', 'ai photo', 'dekh'],
    answer:
      'AI Try-On ✨ lets you see clothes on yourself before buying:\n\n1. Upload one full-body photo (Account → My Try-On Photo)\n2. Open any product and tap "Try On Me"\n3. Our AI generates a preview of you wearing it!\n\nPhoto tips: front-facing, full body, good lighting, plain background, no sunglasses. You get 10 try-ons per day. /* TODO: confirm daily limit if changed */',
    links: [{ label: 'Set my try-on photo', href: '/account' }],
    followUps: ['helped', 'menu'],
  },
  {
    id: 'seller',
    category: 'ACCOUNT',
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
    category: 'ORDERS',
    label: 'Shipping & delivery times',
    keywords: ['shipping', 'delivery', 'kitne din', 'deliver', 'courier', 'kab aayega', 'time'],
    answer:
      'Shipping on Clowe:\n\n• FREE shipping on orders of ₹999 or more; ₹49 below that /* TODO: confirm threshold */\n• Sellers usually ship within 1–2 days /* TODO: confirm */\n• Delivery takes 3–7 days depending on your pincode /* TODO: confirm */\n\nOnce shipped, you get the courier name + AWB number and can track without login on the Track page.',
    links: [{ label: 'Track my order', href: '/track' }],
    followUps: ['order-status', 'helped', 'menu'],
  },
  {
    id: 'returns-policy',
    category: 'RETURNS',
    label: 'Return policy & window',
    keywords: ['return policy', 'wapas', 'exchange', 'return window', 'galat size', 'size'],
    answer:
      'Returns are simple:\n\n• Request a return within 7 days of delivery /* TODO: confirm return window */\n• Go to Orders → open the order → "Request return" on the delivered item\n• Refund is processed after the seller receives the item back\n\nItems should be unused with tags intact. Size guide is available on each product page under details.',
    links: [{ label: 'My orders', href: '/orders' }],
    followUps: ['return-cancel', 'helped', 'menu'],
  },
  {
    id: 'order-tracking',
    category: 'ORDERS',
    label: 'How can I track my order?',
    keywords: ['track', 'where is my order', 'status', 'kahan hai', 'shipment', 'awb'],
    answer:
      'Every order has a live status:\n\n1. Open Orders and tap the order you want\n2. The tracker shows Placed → Confirmed → Shipped → Delivered\n3. Once a seller ships, the courier name and AWB number appear on that item\n\nYou can also use the public tracking page with your order number.',
    links: [
      { label: 'My orders', href: '/orders' },
      { label: 'Track by order number', href: '/track' },
    ],
    followUps: ['helped', 'menu', 'complaint'],
  },
  {
    id: 'order-cancel',
    category: 'ORDERS',
    label: 'How do I cancel my order?',
    keywords: ['cancel', 'cancellation', 'band karo', 'stop order'],
    answer:
      'You can cancel while nothing has shipped:\n\n1. Open Orders → the order you want to cancel\n2. Tap "Cancel order"\n\nStock goes back immediately, any Clowe Credits you redeemed are returned to your wallet, and a paid order is marked for refund. Once an item ships, use a return instead.',
    links: [{ label: 'My orders', href: '/orders' }],
    followUps: ['returns-policy', 'helped', 'menu'],
  },
  {
    id: 'coupons',
    category: 'OFFERS',
    label: 'How do I use a coupon?',
    keywords: ['coupon', 'promo', 'code', 'discount', 'offer', 'kupan'],
    answer:
      'Coupons are applied in the cart:\n\n1. Open your cart and tap "Add Coupon"\n2. Type a code, or pick one from the list of live offers\n3. The discount shows in the order summary right away\n\nEach coupon has its own minimum order value and cap — the list tells you how much more you need if you are short.',
    links: [
      { label: 'My coupons', href: '/account/coupons' },
      { label: 'Go to cart', href: '/cart' },
    ],
    followUps: ['clowe-credits', 'helped', 'menu'],
  },
  {
    id: 'clowe-credits',
    category: 'PAYMENTS',
    label: 'How can I use Clowe Credits?',
    keywords: ['credits', 'wallet', 'points', 'clowe credits', 'balance'],
    answer:
      'Credits work like a wallet balance:\n\n• You earn 1 credit for every ₹20 you actually pay\n• Referrals earn 100 credits, and you can also buy credits outright\n• At checkout, tick "Use my Clowe Credits" to knock the value straight off your total\n\nCredits are valid for 12 months, and the oldest ones are always spent first.',
    links: [{ label: 'Clowe Credits', href: '/account/credits' }],
    followUps: ['coupons', 'helped', 'menu'],
  },
  {
    id: 'wrong-item',
    category: 'RETURNS',
    label: 'I received a wrong or damaged product',
    keywords: ['wrong item', 'damaged', 'broken', 'defective', 'galat product', 'toota'],
    answer:
      'Sorry about that — start a return straight away:\n\n1. Open Orders → the order → "Request return" on that item\n2. Pick "Damaged / defective" or "Wrong item received"\n3. Add at least one photo — it is required for these two reasons and speeds up approval\n\nOnce the seller receives the item back, your refund is processed.',
    links: [{ label: 'My orders', href: '/orders' }],
    followUps: ['returns-policy', 'complaint', 'menu'],
  },
  {
    id: 'account-security',
    category: 'ACCOUNT',
    label: 'How do I keep my account secure?',
    keywords: ['security', 'password', 'pin', 'login', 'sessions', 'hack', 'safe'],
    answer:
      'Clowe logs you in with an OTP on your mobile number — there is no password to leak.\n\n• Set a 4-digit quick-login PIN so you can sign in without waiting for an OTP\n• Check Active Sessions and sign out any device you do not recognise\n• Keep at least one alert channel on so you hear about account activity\n\nAccount Settings → Login & Security has all three.',
    links: [{ label: 'Login & Security', href: '/account/settings' }],
    followUps: ['helped', 'menu', 'complaint'],
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
