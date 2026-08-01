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

export const cartItemUpdateSchema = z.object({
  quantity: z.number().int().min(1).max(10),
});

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
  pricePaise: number;
  mrpPaise: number | null;
  stock: number; // current stock, so the UI can warn
  quantity: number;
}

export interface CartView {
  lines: CartLine[];
  subtotalPaise: number;
  shippingPaise: number;
  totalPaise: number;
  /** Orders at/above this subtotal ship free. */
  freeShippingThresholdPaise: number;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const addressUpsertSchema = z.object({
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

export const checkoutSchema = z.object({
  addressId: z.string().min(1, 'Pick a delivery address'),
  /** Redeem the user's shopping credits as a discount (their choice). */
  useCredits: z.boolean().optional(),
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

export interface CreditLedgerEntry {
  id: string;
  delta: number; // credits, signed
  reason: string; // EARN_PURCHASE | REDEEM_CHECKOUT | REFUND_CREDITS
  orderNumber: string | null;
  createdAt: string;
}

export interface CreditsInfo {
  balance: number; // credits
  valuePaise: number; // balance × CREDIT_VALUE_PAISE
  creditValuePaise: number; // per-credit value (50)
  earnPaisePerCredit: number; // ₹20 → 1 credit
  ledger: CreditLedgerEntry[];
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  amountPaise: number;
  payment: {
    provider: 'mock' | 'razorpay';
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

export interface OrderListRow {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  itemCount: number;
  previewImageUrl: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export const RETURN_REASONS = ['SIZE_FIT', 'DAMAGED', 'WRONG_ITEM', 'QUALITY', 'OTHER'] as const;
export type ReturnReasonValue = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReasonValue, string> = {
  SIZE_FIT: 'Size / fit issue',
  DAMAGED: 'Damaged / defective',
  WRONG_ITEM: 'Wrong item received',
  QUALITY: 'Quality not as expected',
  OTHER: 'Other',
};

/** Reasons where photo proof is mandatory. */
export const RETURN_REASONS_NEED_PHOTOS: ReturnReasonValue[] = ['DAMAGED', 'WRONG_ITEM'];

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
  productSlug: string;
  title: string;
  size: string;
  color: string;
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
  totalPaise: number;
  payment: { provider: string; status: string } | null;
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
