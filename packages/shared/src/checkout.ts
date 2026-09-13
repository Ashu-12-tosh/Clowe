import { z } from 'zod';
import { phoneSchema } from './auth';

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export const cartItemAddSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().min(1).max(10).default(1),
});
export type CartItemAddInput = z.infer<typeof cartItemAddSchema>;

// Quantity and tick state are both optional so the cart page can PATCH either
// one on its own.
export const cartItemUpdateSchema = z
  .object({
    quantity: z.number().int().min(1).max(10).optional(),
    selected: z.boolean().optional(),
  })
  .refine((v) => v.quantity !== undefined || v.selected !== undefined, {
    message: 'Nothing to update',
  });

/** Tick / untick every line at once. */
export const cartSelectAllSchema = z.object({ selected: z.boolean() });

/** Remove several lines in one request ("Delete Selected"). */
export const cartBulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Pick at least one item').max(100),
});

export const couponApplySchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, 'Enter a coupon code')
    .max(24)
    .transform((c) => c.toUpperCase()),
});
export type CouponApplyInput = z.infer<typeof couponApplySchema>;

export interface CartLine {
  id: string; // cart item id
  variantId: string;
  productId: string;
  slug: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  size: string;
  color: string;
  /** Human variant label ("Black · L"); "" for single-SKU products. */
  label: string;
  pricePaise: number;
  mrpPaise: number | null;
  stock: number; // current stock, so the UI can warn
  quantity: number;
  /** Unticked lines stay in the cart but are left out of totals and checkout. */
  selected: boolean;
  /** Top-level category, so the cart can flag Try-On eligible lines. */
  rootCategorySlug: string;
  /** Category allows AI Try-On and the seller has it on. */
  tryOnEligible: boolean;
  /** Seller promotion applied to this line, if any. */
  promotion: { id: string; name: string; code: string | null } | null;
  /** What the promotion takes off this line's total (already in the totals). */
  promoDiscountPaise: number;
}

export interface AppliedCoupon {
  code: string;
  description: string | null;
  discountPaise: number;
}

export const COUPON_KINDS = ['STANDARD', 'BANK', 'PREMIUM'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export const COUPON_KIND_LABELS: Record<CouponKind, string> = {
  STANDARD: '',
  BANK: 'Bank Offer',
  PREMIUM: 'Premium Exclusive',
};

/** A coupon offered in the "Add Coupon" panel (not yet applied). */
export interface CouponOffer {
  code: string;
  description: string | null;
  type: 'PERCENT' | 'FLAT';
  /** Percentage for PERCENT coupons, paise off for FLAT ones. */
  value: number;
  minSubtotalPaise: number;
  maxDiscountPaise: number | null;
  expiresAt: string | null;
  kind: CouponKind;
}

export const MY_COUPON_STATUSES = ['AVAILABLE', 'USED', 'EXPIRED', 'LOCKED'] as const;
export type MyCouponStatus = (typeof MY_COUPON_STATUSES)[number];

/** A coupon as it appears in the shopper's own coupon wallet. */
export interface MyCoupon extends CouponOffer {
  status: MyCouponStatus;
  /** How many times this shopper has already redeemed it. */
  timesUsed: number;
  /** When they last used it. */
  lastUsedAt: string | null;
  /** Why it can't be used right now (LOCKED only). */
  lockedReason: string | null;
}

export interface MyCouponsResponse {
  coupons: MyCoupon[];
  summary: {
    total: number;
    available: number;
    used: number;
    expired: number;
    /** Everything this shopper has saved with coupons so far. */
    totalSavingsPaise: number;
  };
}

export interface CartView {
  lines: CartLine[];
  /** Ticked lines only — what the totals below are built from. */
  selectedCount: number;
  /** Sum of MRP (falling back to price) across ticked lines. */
  mrpSubtotalPaise: number;
  /** Sum of selling price across ticked lines. */
  subtotalPaise: number;
  /** mrpSubtotalPaise − subtotalPaise, i.e. the catalogue discount. */
  discountPaise: number;
  shippingPaise: number;
  coupon: AppliedCoupon | null;
  couponDiscountPaise: number;
  /** Seller-funded promotion discounts across the ticked lines. */
  promoDiscountPaise: number;
  /** One entry per promotion applied, for the "offers applied" list. */
  promotions: { id: string; name: string; code: string | null; discountPaise: number }[];
  totalPaise: number;
  /** discountPaise + promoDiscountPaise + couponDiscountPaise — "you saved". */
  savingsPaise: number;
  /** Orders at/above this subtotal ship free. */
  freeShippingThresholdPaise: number;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const ADDRESS_LABELS = ['HOME', 'OFFICE', 'OTHER'] as const;
export type AddressLabel = (typeof ADDRESS_LABELS)[number];

export const ADDRESS_LABEL_TEXT: Record<AddressLabel, string> = {
  HOME: 'Home',
  OFFICE: 'Office',
  OTHER: 'Other',
};

export const addressUpsertSchema = z.object({
  label: z.enum(ADDRESS_LABELS).default('HOME'),
  name: z.string().trim().min(2).max(60),
  phone: phoneSchema,
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(120).optional(),
  landmark: z.string().trim().max(80).optional(),
  city: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
  isDefault: z.boolean().optional(),
});
export type AddressUpsertInput = z.infer<typeof addressUpsertSchema>;

export interface AddressInfo {
  id: string;
  label: AddressLabel;
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Checkout & payments
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Delivery speeds
// ---------------------------------------------------------------------------

export const DELIVERY_METHODS = ['STANDARD', 'EXPRESS', 'SAME_DAY'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** One row of the "Delivery Options" step, priced for the current cart. */
export interface DeliveryOption {
  method: DeliveryMethod;
  label: string;
  /** Human ETA, e.g. "Delivered by 27 May – 29 May". */
  etaLabel: string;
  pricePaise: number;
  /** Struck-through list price when the option is discounted (or free). */
  strikePaise: number | null;
  /** Same-day is cut off in the afternoon; unavailable options say why. */
  available: boolean;
  unavailableReason: string | null;
  etaFrom: string; // ISO
  etaTo: string; // ISO
}

export const PAYMENT_METHODS = ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'COD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_META: Record<
  PaymentMethod,
  { label: string; blurb: string; icon: string }
> = {
  UPI: { label: 'UPI', blurb: 'Instant payment', icon: '📱' },
  CARD: { label: 'Credit / Debit Card', blurb: 'Visa, Mastercard, RuPay & more', icon: '💳' },
  NETBANKING: { label: 'Net Banking', blurb: 'All major banks supported', icon: '🏦' },
  WALLET: { label: 'Wallets', blurb: 'Paytm, Amazon Pay, PhonePe & more', icon: '👛' },
  EMI: { label: 'EMI', blurb: 'Easy EMIs on cards', icon: '📅' },
  COD: { label: 'Cash on Delivery', blurb: 'Pay when you receive', icon: '💵' },
};

/** Minimum order value before EMI is offered. */
export const EMI_MIN_PAISE = 300000;
/** COD is only offered up to this order value. */
export const COD_MAX_PAISE = 2000000;

export const checkoutSchema = z.object({
  addressId: z.string().min(1, 'Pick a delivery address'),
  paymentMethod: z.enum(PAYMENT_METHODS).default('UPI'),
  /** Defaults to the delivery address when omitted. */
  billingAddressId: z.string().optional(),
  /** Redeem the user's shopping credits as a discount (their choice). */
  useCredits: z.boolean().optional(),
  deliveryMethod: z.enum(DELIVERY_METHODS).default('STANDARD'),
  isGift: z.boolean().optional(),
  giftMessage: z.string().trim().max(200).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ---------------------------------------------------------------------------
// Shopping credits — earn 1 credit per ₹20 paid; 1 credit = 50 paise (10 = ₹5)
// ---------------------------------------------------------------------------

export const CREDIT_VALUE_PAISE = 50;
export const CREDIT_EARN_PAISE_PER_CREDIT = 2000; // ₹20 spent → 1 credit
/** Credits the referrer earns when their referred friend places a first order. */
export const REFERRAL_REWARD_CREDITS = 100;

export const creditsToPaise = (credits: number): number => credits * CREDIT_VALUE_PAISE;
export const creditsEarnedFor = (paidPaise: number): number =>
  Math.floor(paidPaise / CREDIT_EARN_PAISE_PER_CREDIT);

/** Earned credits lapse this many months after they land. */
export const CREDIT_EXPIRY_MONTHS = 12;

export const CREDIT_REASONS = [
  'EARN_PURCHASE',
  'EARN_REFERRAL',
  'EARN_TOPUP',
  'REDEEM_CHECKOUT',
  'REFUND_CREDITS',
  'EXPIRED',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export const CREDIT_REASON_LABELS: Record<CreditReason, string> = {
  EARN_PURCHASE: 'Order reward',
  EARN_REFERRAL: 'Referral bonus',
  EARN_TOPUP: 'Credits purchased',
  REDEEM_CHECKOUT: 'Used on an order',
  REFUND_CREDITS: 'Credits returned',
  EXPIRED: 'Credits expired',
};

export interface CreditLedgerEntry {
  id: string;
  delta: number; // credits, signed
  reason: string;
  orderNumber: string | null;
  /** When this earned batch lapses (null for spends). */
  expiresAt: string | null;
  createdAt: string;
}

/** A top-up bundle the shopper can buy. */
export interface CreditPackage {
  id: string;
  credits: number;
  /** Extra credits thrown in — the reason to buy the bigger bundle. */
  bonusCredits: number;
  pricePaise: number;
}

/**
 * Top-ups are priced at face value: you pay exactly what the base credits are
 * worth, and the bonus is the discount.
 */
export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: 'starter', credits: 200, bonusCredits: 0, pricePaise: 200 * CREDIT_VALUE_PAISE },
  { id: 'saver', credits: 500, bonusCredits: 50, pricePaise: 500 * CREDIT_VALUE_PAISE },
  { id: 'pro', credits: 1000, bonusCredits: 150, pricePaise: 1000 * CREDIT_VALUE_PAISE },
];

export interface CreditsInfo {
  balance: number; // credits
  valuePaise: number; // balance × CREDIT_VALUE_PAISE
  creditValuePaise: number; // per-credit value
  earnPaisePerCredit: number; // ₹20 → 1 credit
  /** Lifetime totals across the ledger. */
  totalEarned: number;
  totalUsed: number;
  /** Unspent credits lapsing within 30 / 90 days (FIFO across earned batches). */
  expiringIn30Days: number;
  expiringIn90Days: number;
  /** The soonest batch to lapse, if any. */
  nextExpiryAt: string | null;
  expiryMonths: number;
  ledger: CreditLedgerEntry[];
  /** Total ledger rows, for paging. */
  ledgerTotal: number;
}

/** Result of starting a top-up — mirrors the order checkout shape. */
export interface CreditPurchaseResult {
  purchaseId: string;
  credits: number;
  bonusCredits: number;
  amountPaise: number;
  payment: {
    provider: 'mock' | 'razorpay';
    providerOrderId: string;
    keyId?: string;
  };
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  amountPaise: number;
  /** COD orders are confirmed straight away — there is nothing to pay now. */
  method: PaymentMethod;
  requiresPayment: boolean;
  payment: {
    provider: 'mock' | 'razorpay' | 'cod';
    providerOrderId: string;
    /** Razorpay public key id — needed by checkout.js on the frontend. */
    keyId?: string;
  };
}

export const paymentVerifySchema = z.object({
  orderId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
export type PaymentVerifyInput = z.infer<typeof paymentVerifySchema>;

export const mockPaySchema = z.object({
  orderId: z.string().min(1),
  outcome: z.enum(['success', 'failure']),
});

// ---------------------------------------------------------------------------
// Orders (customer view)
// ---------------------------------------------------------------------------

export const ORDER_FILTERS = [
  'ALL',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

export const ORDER_FILTER_LABELS: Record<OrderFilter, string> = {
  ALL: 'All Orders',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
};

export interface OrderListRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  itemCount: number;
  previewImageUrl: string | null;
  /** Up to four thumbnails for the card's image strip. */
  previewImages: string[];
  /** Total distinct products, so the card can show "+N". */
  productCount: number;
  paymentProvider: string | null;
  deliveredAt: string | null;
  etaFrom: string | null;
  etaTo: string | null;
  /** True while every item can still be re-added to the cart. */
  canBuyAgain: boolean;
  createdAt: string;
}

export interface OrderListResponse {
  items: OrderListRow[];
  total: number;
  summary: {
    counts: Record<OrderFilter, number>;
    /** Everything saved across all orders (catalogue + coupons + credits). */
    totalSavedPaise: number;
    /** When the first order was placed - drives the year list in the "placed in" filter. */
    firstOrderAt: string | null;
  };
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export const RETURN_REASONS = [
  'SIZE_FIT',
  'DAMAGED',
  'DEFECTIVE',
  'WRONG_ITEM',
  'MISSING_PARTS',
  'NOT_AS_DESCRIBED',
  'QUALITY',
  'CHANGED_MIND',
  'OTHER',
] as const;
export type ReturnReasonValue = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReasonValue, string> = {
  SIZE_FIT: 'Size / fit issue',
  DAMAGED: 'Arrived damaged',
  DEFECTIVE: 'Defective / not working',
  WRONG_ITEM: 'Wrong item received',
  MISSING_PARTS: 'Missing parts or accessories',
  NOT_AS_DESCRIBED: 'Not as described',
  QUALITY: 'Quality not as expected',
  CHANGED_MIND: 'No longer needed',
  OTHER: 'Other',
};

/** Reasons where photo proof is mandatory. */
export const RETURN_REASONS_NEED_PHOTOS: ReturnReasonValue[] = [
  'DAMAGED',
  'DEFECTIVE',
  'WRONG_ITEM',
  'MISSING_PARTS',
];

/** Reasons that only make sense for wearables - offered when the item has a size. */
export const RETURN_REASONS_WEARABLE: ReturnReasonValue[] = ['SIZE_FIT'];

/** Reasons to offer for one item: wearable-only ones are hidden when there is no size. */
export function returnReasonsFor(hasSize: boolean): ReturnReasonValue[] {
  return RETURN_REASONS.filter((r) => hasSize || !RETURN_REASONS_WEARABLE.includes(r));
}

/** Customer's view of a return (status timeline + refund). */
export interface ReturnInfo {
  id: string;
  status: string; // REQUESTED | APPROVED | REJECTED | RECEIVED | REFUNDED
  reason: ReturnReasonValue;
  details: string | null;
  photos: string[];
  rejectionReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  receivedAt: string | null;
  refund: { status: string; amountPaise: number; processedAt: string | null } | null;
}

export interface OrderDetailItem {
  id: string;
  productId: string;
  productSlug: string;
  title: string;
  size: string;
  color: string;
  /** Human variant label ("Black · L"); "" for single-SKU products. */
  variantLabel: string;
  quantity: number;
  pricePaise: number;
  status: string;
  imageUrl: string | null;
  shopName: string;
  returnStatus: string | null;
  returnInfo: ReturnInfo | null;
  /** True while the item is DELIVERED and inside the return window. */
  canReturn: boolean;
  courierName: string | null;
  awbNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  /** True once this item can be reviewed (delivered, not yet reviewed). */
  canReview: boolean;
  /** Variant to re-add for "Buy again"; null if it is no longer sellable. */
  variantId: string | null;
  imageUrlLarge?: string | null;
}

export interface OrderDetailView {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  shipTo: {
    name: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    pincode: string;
  };
  items: OrderDetailItem[];
  subtotalPaise: number;
  shippingPaise: number;
  discountPaise: number;
  creditsUsed: number;
  couponCode: string | null;
  couponDiscountPaise: number;
  totalPaise: number;
  deliveryMethod: DeliveryMethod;
  paymentMethod: PaymentMethod;
  etaFrom: string | null;
  etaTo: string | null;
  isGift: boolean;
  giftMessage: string | null;
  /** Credits this order earned, once it was paid for. */
  earnedCredits: number;
  /** Milestones for the order timeline (null until they happen). */
  timeline: {
    placedAt: string;
    confirmedAt: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
  };
  payment: {
    provider: string;
    status: string;
    /** Gateway reference shown on the receipt. */
    transactionId: string | null;
    paidAt: string | null;
  } | null;
  /** True while payment is still pending (mock/razorpay not completed). */
  awaitingPayment: boolean;
  canCancel: boolean;
  /** Days after delivery during which a return can be requested. */
  returnWindowDays: number;
}

export const returnRequestSchema = z
  .object({
    reason: z.enum(RETURN_REASONS),
    details: z.string().trim().max(300).optional(),
    photos: z.array(z.string().min(1)).max(3, 'Up to 3 photos').optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reason === 'OTHER' && (!val.details || val.details.length < 5)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['details'],
        message: 'Please describe the issue (min 5 characters)',
      });
    }
    if (RETURN_REASONS_NEED_PHOTOS.includes(val.reason) && (!val.photos || val.photos.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['photos'],
        message: 'Please add at least one photo of the item',
      });
    }
  });
export type ReturnRequestInput = z.infer<typeof returnRequestSchema>;

/** Seller decision on a return request. */
export const sellerReturnActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('reject'),
    rejectionReason: z.string().trim().min(5, 'Give the customer a reason (min 5 chars)').max(300),
  }),
  z.object({ action: z.literal('received'), condition: z.enum(['OK', 'DAMAGED']) }),
]);
export type SellerReturnActionInput = z.infer<typeof sellerReturnActionSchema>;
