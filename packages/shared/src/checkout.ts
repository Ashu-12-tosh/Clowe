import { z } from 'zod';
import { phoneSchema } from './auth';
import { assetRefSchema } from './assets';
import { codRefundAccountSchema } from './codRefund';
import { gstNumberField } from './taxIds';
import { isPoBoxAddress, PO_BOX_MESSAGE } from './deliveryZone';

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
  /** False: this item cannot be returned (its category says so) — shown before buying. */
  returnable: boolean;
  /** True: cannot be cancelled once confirmed — shown before buying. */
  nonCancellable: boolean;
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
  /** Always 0: delivery is free on every order. */
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
  /**
   * Credits the buyer's own unpaid order for these items has reserved: they are
   * this cart's to use (the order is handed back or replaced at checkout), so
   * they count with the balance when working out the total.
   */
  heldCredits: number;
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
}).superRefine((a, ctx) => {
  // Shipping Policy 2.3: no delivery to a post office box.
  if (isPoBoxAddress(a.line1, a.line2)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['line1'], message: PO_BOX_MESSAGE });
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
// The COD range is PlatformSettings.codMinOrderPaise..codMaxOrderPaise, not a constant here.

/**
 * Why Cash on Delivery is not offered for this order by the platform's own
 * rules (Payment Policy 6.1, Shipping Policy 2.2), or null: COD must be
 * switched on for Clowe (PlatformSettings.codEnabled), the order total within
 * the COD range, and the PIN code not a prepaid-only one. The courier's own
 * serviceability is checked separately.
 */
export const COD_OFF_MESSAGE = 'Cash on Delivery is not available yet — please pay online';

export function codPlatformRefusal(input: {
  totalPaise: number;
  pincode: string;
  codEnabled: boolean;
  codMinOrderPaise: number;
  codMaxOrderPaise: number;
  prepaidOnlyPincodes: readonly string[];
}): string | null {
  const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;
  if (!input.codEnabled) return COD_OFF_MESSAGE;
  if (input.totalPaise < input.codMinOrderPaise) {
    return `Cash on Delivery is available on orders from ${rupees(input.codMinOrderPaise)} — please pay online`;
  }
  if (input.totalPaise > input.codMaxOrderPaise) {
    return `Cash on Delivery is available up to ${rupees(input.codMaxOrderPaise)} — please pay online`;
  }
  if (input.prepaidOnlyPincodes.includes(input.pincode)) {
    return `Deliveries to ${input.pincode} are prepaid only — please pay online`;
  }
  return null;
}

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
  /** Optional GSTIN for a business purchase, printed on the invoice. Only at checkout. */
  buyerGstin: gstNumberField.optional(),
  /**
   * The browser's key for this checkout attempt. A retry, a refresh or a second
   * request with the same key gets the same order back, never a second one.
   */
  checkoutKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid checkout key')
    .optional(),
  /**
   * The amount to pay the shopper was shown. When prices, the coupon or the
   * credits changed since, the order is refused with PRICE_CHANGED and the new
   * total, so nobody is charged a number they did not see.
   */
  expectedTotalPaise: z.number().int().nonnegative().optional(),
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
  'REVERSE_PURCHASE',
  'EXPIRED',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export const CREDIT_REASON_LABELS: Record<CreditReason, string> = {
  EARN_PURCHASE: 'Order reward',
  EARN_REFERRAL: 'Referral bonus',
  EARN_TOPUP: 'Credits purchased',
  REDEEM_CHECKOUT: 'Used on an order',
  REFUND_CREDITS: 'Credits returned',
  REVERSE_PURCHASE: 'Order reward reversed (cancelled or returned)',
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
/**
 * What the browser needs to open a gateway's checkout: Razorpay's public key,
 * or Cashfree's payment session and which of its environments to open.
 */
export interface GatewayCheckout {
  provider: 'mock' | 'razorpay' | 'cashfree';
  providerOrderId: string;
  /** Razorpay public key id — needed by checkout.js on the frontend. */
  keyId?: string;
  /** Cashfree: the session the checkout opens. */
  paymentSessionId?: string;
  /** Cashfree: sandbox or production checkout. */
  mode?: 'sandbox' | 'production';
}

/** The three things paid through the gateway. */
export const GATEWAY_PAYMENT_KINDS = ['ORDER', 'CREDITS', 'PROMOTION'] as const;
export type GatewayPaymentKind = (typeof GATEWAY_PAYMENT_KINDS)[number];

/** POST /api/payments/confirm — ask whether a gateway payment went through. */
export const paymentConfirmSchema = z.object({
  kind: z.enum(GATEWAY_PAYMENT_KINDS),
  id: z.string().min(1).max(64),
});

/**
 * PAID: done. PENDING: the bank has not answered yet — ask again shortly.
 * RETRY: that attempt failed, but the same payment can be tried again.
 * FAILED: it cannot be paid any more (expired, or cancelled).
 */
export interface PaymentConfirmResult {
  outcome: 'PAID' | 'PENDING' | 'RETRY' | 'FAILED';
  message: string | null;
  /** To reopen the checkout after RETRY, or to finish paying an order not paid yet. */
  checkout: GatewayCheckout | null;
  /** A payment attempt is with the bank right now: wait, do not pay again. */
  attemptPending?: boolean;
}

export interface CreditPurchaseResult {
  purchaseId: string;
  credits: number;
  bonusCredits: number;
  amountPaise: number;
  payment: GatewayCheckout;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  amountPaise: number;
  /** COD orders are confirmed straight away — there is nothing to pay now. */
  method: PaymentMethod;
  requiresPayment: boolean;
  payment: Omit<GatewayCheckout, 'provider'> & { provider: GatewayCheckout['provider'] | 'cod' };
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
  /** The parcel needing the buyer's eye: a status chip and a plain-words headline. */
  tracking: import('./tracking').OrderTrackingSummary | null;
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
  'COUNTERFEIT',
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
  COUNTERFEIT: 'Spurious or counterfeit',
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
  /** arn: the bank's reference for the credit, once the gateway has one. */
  refund: { status: string; amountPaise: number; processedAt: string | null; arn?: string | null } | null;
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
  /** False for an item from a non-returnable category (fixed when it was sold). */
  returnable: boolean;
  /** Sold as non-cancellable: no cancelling it once confirmed. */
  nonCancellable: boolean;
  /**
   * Under the Return Policy's claims (delivered since they took effect): the
   * claim window, the reasons this item can be claimed for, and whether an
   * exchange can be asked for. Null: the earlier return rules apply.
   */
  claim: {
    windowEndsAt: string;
    latentUntil: string;
    reasons: import('./returnClaims').ClaimReason[];
    exchangeAllowed: boolean;
  } | null;
  /** Why a seller or admin cancelled this line, as the buyer was told. */
  cancelReason: string | null;
  canReturn: boolean;
  /** The courier's scans for this line's parcel, newest first. */
  scans: import('./growth').TrackingScanView[];
  /** The line's parcel once booked: the estimate from dispatch, attempts, lost in transit. */
  parcel: {
    shipmentId: string;
    etaFrom: string | null;
    etaTo: string | null;
    deliveryAttempts: number;
    lost: boolean;
    lostChoice: import('./deliveryZone').LostParcelChoice | null;
    /** Delhivery's own date once booked; etaFrom/etaTo then carry it too. */
    courierPromisedAt: string | null;
  } | null;
  /** The day this line's seller promised at checkout (dispatch + Delhivery's TAT + a day). */
  deliveryPromise: { label: string; deliveryBy: string; deliveryByLatest: string | null } | null;
  /** The free replacement sent for this line, if any. */
  replacedBy: { orderId: string; orderNumber: string } | null;
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
  /** Shipped and not yet delivered: the buyer may ask support to stop the parcel (Cancellation Policy 1.2). */
  canRequestIntercept: boolean;
  /** The buyer's open request to stop a parcel, if any. */
  interceptRequest: { complaintId: string; status: string } | null;
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
  /** One promised date per seller on the order, as checkout showed them. */
  sellerPromises: { sellerId: string; shopName: string; label: string; deliveryBy: string; deliveryByLatest: string | null }[];
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
  /** Hours after delivery to claim a damaged, wrong or defective item (no change-of-mind returns). */
  claimWindowHours: number;
  /** One tracking bar per parcel (a multi-seller order has several). */
  tracking: import('./tracking').ParcelTracking[];
}

export const returnRequestSchema = z
  .object({
    reason: z.enum(RETURN_REASONS),
    details: z.string().trim().max(300).optional(),
    /** References from POST /api/uploads/private (purpose RETURN_PHOTO). */
    photos: z.array(assetRefSchema).max(3, 'Up to 3 photos').optional(),
    /** Cash on Delivery orders only, and required there: where the refund is sent. */
    codRefundAccount: codRefundAccountSchema.optional(),
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
  z.object({
    action: z.literal('received'),
    condition: z.enum(['OK', 'DAMAGED']),
    /** What the quality check found; required when a claim fails it (the buyer is told). */
    note: z.string().trim().max(300).optional(),
  }),
]);
export type SellerReturnActionInput = z.infer<typeof sellerReturnActionSchema>;

/** GET /api/cart/cod-availability — whether the courier collects cash at this address. */
export interface CodAvailability {
  available: boolean;
  /** Why not, in words for the shopper; null when available. */
  reason: string | null;
}
