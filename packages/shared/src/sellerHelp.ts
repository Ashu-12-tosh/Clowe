// ---------------------------------------------------------------------------
// Seller handbook.
//
// One source of truth for the help centre: the UI renders these articles and
// the AI assistant is grounded in the same text, so an answer can never
// contradict the documentation.
// ---------------------------------------------------------------------------

export const HELP_TOPICS = [
  {
    id: 'account',
    icon: '🛡',
    title: 'Account & verification',
    blurb: 'Registration, KYC documents and shop status',
  },
  {
    id: 'listing',
    icon: '👕',
    title: 'Products & inventory',
    blurb: 'Adding listings, variants, stock and visibility',
  },
  { id: 'orders', icon: '📦', title: 'Orders & shipping', blurb: 'Packing, dispatch, labels and SLAs' },
  { id: 'returns', icon: '↩', title: 'Returns & refunds', blurb: 'Windows, decisions and who pays' },
  { id: 'payouts', icon: '₹', title: 'Payouts & fees', blurb: 'Settlement cycle, commission and TDS' },
  {
    id: 'growth',
    icon: '📣',
    title: 'Promotions & growth',
    blurb: 'Discounts, ads and AI Try-On',
  },
] as const;

export type HelpTopicId = (typeof HELP_TOPICS)[number]['id'];

export interface HelpArticle {
  id: string;
  topic: HelpTopicId;
  title: string;
  summary: string;
  /** Full text, also used as grounding for the AI assistant. */
  body: string;
  tags: string[];
  popular?: boolean;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'add-product',
    topic: 'listing',
    title: 'How to add a new product',
    summary: 'Step by step through the listing wizard, from basics to publishing.',
    popular: true,
    tags: ['product', 'listing', 'add', 'publish', 'draft'],
    body: `Open Products → Add New Product. The wizard has seven steps: Basic info, Category & attributes, Images & video, Variants, Inventory & pricing, Shipping & SEO, and Review.

You can Save as Draft at any point — a draft stays private and does not need admin approval, so you can finish it later. Publishing runs full validation: a title of at least 3 characters, a description of at least 20 characters, at least one image and at least one variant.

Every option combination (colour × size, storage × RAM…) is its own variant with its own price, MRP, SKU and stock. Leave the SKU blank and Clowe generates one. New and edited listings go to the admin for approval before they appear on the storefront.`,
  },
  {
    id: 'listing-visibility',
    topic: 'listing',
    title: 'Why is my product not visible on the storefront?',
    summary: 'The four reasons a listing stays hidden, and how to fix each one.',
    popular: true,
    tags: ['visible', 'hidden', 'not showing', 'approval', 'rejected'],
    body: `A listing only appears on the storefront when all of these are true:

1. Admin approval — the status is Approved, not Draft, In review or Rejected. A rejected listing shows the reason on your Products page.
2. Show on storefront is ticked — this is your own switch in step 7 of the wizard, and in the row menu on the Products page. Unticking it hides an approved listing without archiving it.
3. Stock is above zero — an out-of-stock variant cannot be bought. Update stock from the Inventory page.
4. Your shop is active — if the admin has suspended or banned your account, every listing is hidden until the account is reinstated.`,
  },
  {
    id: 'inventory-stock',
    topic: 'listing',
    title: 'Updating stock and low-stock alerts',
    summary: 'Inline edits, bulk updates and what "reserved" means.',
    tags: ['stock', 'inventory', 'low stock', 'reserved', 'bulk'],
    body: `Stock lives on the variant, so Inventory lists one row per variant. Edit a number inline and press Enter, or tick several rows and use Set to / Add / Remove for a bulk change. A relative adjustment never takes a variant below zero.

Low stock alert is per product — a variant at or below that number is flagged as Low stock. Reserved means units on paid orders you have not shipped yet: they are still counted in stock but already spoken for.`,
  },
  {
    id: 'order-flow',
    topic: 'orders',
    title: 'Order fulfilment: confirm → pack → ship → deliver',
    summary: 'The four stages, what each one does, and the dispatch SLA.',
    popular: true,
    tags: ['order', 'pack', 'ship', 'dispatch', 'awb', 'courier'],
    body: `A paid order arrives as New. From Orders you can mark items Packed, then Ship, then Delivered. Packing is optional — you can ship straight from a new order.

Shipping books a shipment with the courier and records an AWB and tracking link. You may pick the courier before shipping, or let Clowe assign one. Each line moves independently, so a multi-item order can be part shipped.

Dispatch SLA: ship within 2 working days of the order. Late dispatch counts against your account health.

Print labels from the row action or in bulk from the selection bar, and generate a GST invoice per order.`,
  },
  {
    id: 'cod-collection',
    topic: 'orders',
    title: 'How Cash on Delivery is settled',
    summary: 'When COD money is marked collected and how it reaches you.',
    tags: ['cod', 'cash on delivery', 'payment', 'collect'],
    body: `On a COD order the courier collects the cash at the door, so the payment stays pending until then. When you mark the last live line of that order Delivered, Clowe marks the payment Paid.

From that point the money follows the normal payout path: it clears after the return window and is included in your next payout, net of commission, gateway/collection charges and TDS.`,
  },
  {
    id: 'returns-policy',
    topic: 'returns',
    title: 'Return & refund policy for sellers',
    summary: 'The window, your decision SLA, and when the refund goes out.',
    popular: true,
    tags: ['return', 'refund', 'window', 'reject', 'damaged'],
    body: `Customers can request a return within the return window (7 days from delivery by default). You then approve or decline it — decline needs a written reason the customer sees.

Decide within 48 hours. Requests older than that are flagged as overdue on your Returns page, and the admin can override a rejection on the customer's behalf.

After an approved return comes back, mark it Received. If the item is in good condition, the refund is raised automatically for the amount the customer paid. If it arrives damaged, flag it as damaged — no automatic refund is issued and support reviews the case.

Return shipping is arranged by the marketplace; you do not pay pickup charges.`,
  },
  {
    id: 'payout-cycle',
    topic: 'payouts',
    title: 'How payouts work on Clowe',
    summary: 'Earn on delivery, clear after the return window, request a transfer.',
    popular: true,
    tags: ['payout', 'settlement', 'money', 'bank', 'clearing'],
    body: `You earn on delivery, not on order. Delivered earnings are held for the clearing period (the return window, 7 days by default) so a refund never chases money that has already left.

Once cleared, the amount appears as Amount payable on the Payouts page. Request a payout and it transfers to your default payout method, subject to the minimum payout amount.

Every payout is net of: marketplace commission, payment gateway/collection charges, TDS under section 194-O, and any unrecovered ad spend. The exact rates in force are shown on your Payouts page, and each payout can be opened to see the individual order lines it settled.`,
  },
  {
    id: 'payout-not-received',
    topic: 'payouts',
    title: 'My payout has not arrived — what should I check?',
    summary: 'The usual causes, in the order worth checking.',
    tags: ['payout', 'not received', 'missing', 'delay', 'utr'],
    body: `Check these in order:

1. Is the amount cleared? Delivered earnings sit in "In clearing" until the return window closes. The Payouts page shows the release date.
2. Is it above the minimum payout? Smaller balances roll over.
3. Is your payout method verified? An unverified bank account or UPI ID cannot receive money.
4. Did the payout already go out? Open Payouts history — a Paid payout shows a UTR you can quote to your bank. Banks can take up to 48 hours to reflect a credit.
5. Was it adjusted? Outstanding ad spend is recovered from the payout, so the transferred amount can be lower than the earnings.

If all of that checks out, raise a ticket under Payouts & payments with the payout reference.`,
  },
  {
    id: 'fees-tds',
    topic: 'payouts',
    title: 'Fees, commission and TDS explained',
    summary: 'What is deducted from a sale and why.',
    tags: ['commission', 'fees', 'tds', '194-O', 'gst', 'invoice'],
    body: `Three deductions apply to your delivered sales:

• Commission — the marketplace fee, a percentage of the line total.
• Payment gateway / collection charge — a percentage covering online payment or COD collection.
• TDS under section 194-O — withheld against your PAN and deposited with the payout that carried it. Download the TDS report from the Payouts page for your accountant.

GST on the sale itself is collected from the customer as part of the price. You issue the tax invoice for your own lines from the Orders page; the GST slab comes from the Tax class you set on the listing.`,
  },
  {
    id: 'promotions',
    topic: 'growth',
    title: 'How to create a promotion or offer',
    summary: 'Automatic vs coded discounts, caps and who pays for them.',
    popular: true,
    tags: ['promotion', 'discount', 'coupon', 'offer', 'sale'],
    body: `Marketing → Promotions → Create promotion. Choose what it applies to (your whole store, chosen products, or chosen categories), the discount (percent or flat), and the window.

Leave the code blank and the discount applies automatically at checkout. Add a code and it only applies when the shopper enters it. If several of your promotions could apply, the one that saves the shopper most wins — they never stack.

Use Max discount to cap a percentage offer, Minimum order to protect margin, and the usage limits to control spend.

The discount comes off your line price at checkout, so it is funded by you, not by the marketplace commission — you can see the effect in your payouts.`,
  },
  {
    id: 'ads',
    topic: 'growth',
    title: 'Advertising your products',
    summary: 'Sponsored placements, pricing and how you are charged.',
    tags: ['ads', 'sponsored', 'promote', 'banner'],
    body: `Advertise books a sponsored placement — either a home page banner or a sponsored slot in category listings — for 7, 15 or 30 days. Pricing per placement and duration is shown before you submit, and the admin approves the ad before it runs.

Ad spend is not charged upfront: it is recovered from your next payout. If a payout is too small to cover the full amount, only the part that fits is recovered and the rest waits for the following payout.`,
  },
  {
    id: 'tryon',
    topic: 'growth',
    title: 'AI Try-On for your listings',
    summary: 'Which products qualify and how to switch it off.',
    tags: ['try-on', 'ai', 'virtual', 'eligibility'],
    body: `AI Try-On lets shoppers see your item on their own photo. It shows on a product when the platform's minimum-price rule is met and you have left Enable AI Try-On ticked on the listing (step 7 of the wizard).

It is available in wearable categories such as apparel, footwear and eyewear. Untick it for anything where a virtual try-on would look wrong. Try-On runs cost you nothing — the marketplace pays the provider.`,
  },
  {
    id: 'kyc',
    topic: 'account',
    title: 'Getting your shop verified',
    summary: 'What KYC needs, and what the verified badge changes.',
    popular: true,
    tags: ['kyc', 'verification', 'gst', 'pan', 'documents', 'verified'],
    body: `Add your GSTIN, PAN, registered address and bank details in Store Settings. The admin reviews them and sets your KYC status: Pending docs, Under review, Verified or Rejected.

Verified shops carry the verified badge on their storefront. If your documents are rejected, the reason is sent to you — re-upload corrected documents and the review restarts.`,
  },
  {
    id: 'account-health',
    topic: 'account',
    title: 'Account health and what affects it',
    summary: 'The four metrics that decide whether your shop is in good standing.',
    tags: ['health', 'metrics', 'suspension', 'defect', 'late'],
    body: `Your account health is measured on four rates, all computed from your real orders:

• Order defect rate — returns raised for damage, wrong item or quality, as a share of delivered units.
• Late dispatch rate — orders shipped later than 2 working days after they were placed.
• Cancellation rate — units cancelled after the order was paid.
• Return rate — units returned as a share of delivered units.

Each has a target shown on the Support page. Crossing a target repeatedly can lead to a suspension: your listings are hidden until it is resolved. A suspended shop can be reinstated once the underlying issue is fixed — raise a ticket under Policy & compliance to appeal.`,
  },
  {
    id: 'suspension',
    topic: 'account',
    title: 'My shop was suspended — what now?',
    summary: 'What suspension does and how to get reinstated.',
    tags: ['suspended', 'banned', 'appeal', 'reinstate'],
    body: `Suspension hides every live listing immediately; existing orders still need to be fulfilled. The reason is sent to you by notification and WhatsApp and is shown to the admin on your shop record.

To appeal, raise a ticket under Policy & compliance explaining what has changed. Once the admin reinstates the shop, your approved listings become visible again exactly as they were.`,
  },
  {
    id: 'shipping-guidelines',
    topic: 'orders',
    title: 'Shipping & delivery guidelines',
    summary: 'Packing standards, labels and what the courier expects.',
    tags: ['shipping', 'packing', 'label', 'awb', 'pickup'],
    body: `Pack so the item survives handling: rigid or padded outer, garments in a sealed poly bag, fragile items cushioned on all sides.

Print the Clowe shipping label from the Orders page and fix it flat on the largest face — the AWB barcode must not be folded over an edge. On a COD shipment the label shows the exact amount to collect; never accept a different amount.

Do not put promotional inserts asking customers to buy outside Clowe — that is a policy breach.`,
  },
];

/** Policies a seller agrees to, shown in the Policy Center. */
export const SELLER_POLICIES = [
  {
    id: 'code-of-conduct',
    title: 'Seller code of conduct',
    summary:
      'Describe products honestly, ship on time, respond to customers and support, and never route buyers off the marketplace.',
  },
  {
    id: 'prohibited-products',
    title: 'Prohibited products policy',
    summary:
      'No counterfeits or replicas, no unlicensed branded goods, nothing illegal, hazardous or recalled, and no listings that misuse another brand or seller name.',
  },
  {
    id: 'return-refund',
    title: 'Return & refund policy',
    summary:
      'Honour the return window, decide within 48 hours with a written reason, and refund promptly once an approved return arrives in good condition.',
  },
  {
    id: 'shipping-policy',
    title: 'Shipping policy',
    summary:
      'Dispatch within 2 working days, pack to the stated standard, use the Clowe label, and keep tracking accurate.',
  },
  {
    id: 'ip-policy',
    title: 'Intellectual property policy',
    summary:
      'Only list goods you have the right to sell. Use your own photographs and copy — infringing listings are removed and repeat breaches end the account.',
  },
] as const;

/** Naive keyword scoring — good enough to pick grounding for the assistant. */
export function findHelpArticles(question: string, limit = 3): HelpArticle[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return [];

  return HELP_ARTICLES.map((article) => {
    const haystack = `${article.title} ${article.summary} ${article.tags.join(' ')} ${article.body}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (article.tags.some((t) => t.includes(word))) score += 3;
      if (article.title.toLowerCase().includes(word)) score += 2;
      if (haystack.includes(word)) score += 1;
    }
    return { article, score };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.article);
}
