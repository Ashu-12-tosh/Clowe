import { z } from 'zod';
import type { AddressInfo, OrderListRow } from './checkout';
import type { ProductListItem } from './catalog';

// ---------------------------------------------------------------------------
// Saved payment methods
// ---------------------------------------------------------------------------

export const PAYMENT_METHOD_KINDS = ['CARD', 'UPI', 'WALLET'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface SavedPaymentMethodInfo {
  id: string;
  kind: PaymentMethodKind;
  /** Visa / Mastercard / RuPay, the UPI app, or the wallet provider. */
  brand: string;
  /** Last 4 digits for cards, the VPA for UPI and wallets. */
  label: string;
  /** Name printed on the card, when the shopper added it. */
  holderName: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  isDefault: boolean;
  /** True once the card's expiry month has passed. */
  isExpired: boolean;
}

/**
 * Only display fields are accepted — a real integration tokenises the card at
 * the gateway, so the app never sees (or stores) a PAN or CVV.
 */
/** `name@bank` — the shape every UPI handle follows. */
export const UPI_ID_PATTERN = /^[a-z0-9.\-_]{2,64}@[a-z]{2,32}$/i;

export const savedPaymentMethodSchema = z
  .object({
    kind: z.enum(PAYMENT_METHOD_KINDS).default('CARD'),
    brand: z.string().trim().min(2, 'Pick a provider').max(30),
    label: z.string().trim().min(3, 'Enter the last 4 digits or UPI id').max(40),
    holderName: z.string().trim().max(60).nullable().optional(),
    expiryMonth: z.number().int().min(1).max(12).nullable().optional(),
    expiryYear: z.number().int().min(2024).max(2100).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'CARD') {
      if (!/^\d{4}$/.test(val.label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['label'],
          message: 'Enter the last 4 digits of the card',
        });
      }
      if (!val.expiryMonth || !val.expiryYear) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expiryMonth'],
          message: 'Enter the card expiry',
        });
      }
      return;
    }
    // UPI and wallets are both identified by a VPA.
    if (!UPI_ID_PATTERN.test(val.label)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['label'],
        message: 'Enter a UPI ID in the form name@bank',
      });
    }
  });
export type SavedPaymentMethodInput = z.infer<typeof savedPaymentMethodSchema>;

// ---------------------------------------------------------------------------
// Returns & refunds
// ---------------------------------------------------------------------------

export const RETURN_FILTERS = [
  'ALL',
  'REQUESTED',
  'APPROVED',
  'RECEIVED',
  'REFUNDED',
  'REJECTED',
] as const;
export type ReturnFilter = (typeof RETURN_FILTERS)[number];

export const RETURN_FILTER_LABELS: Record<ReturnFilter, string> = {
  ALL: 'All',
  REQUESTED: 'Return Requested',
  APPROVED: 'Pickup Scheduled',
  RECEIVED: 'Under Review',
  REFUNDED: 'Refunded',
  REJECTED: 'Rejected',
};

/** One return request across all of a shopper's orders. */
export interface MyReturnRow {
  id: string;
  /** Short human-facing id, e.g. RT-4F2A9C. */
  requestId: string;
  orderId: string;
  orderNumber: string;
  orderedAt: string;
  productTitle: string;
  productSlug: string;
  imageUrl: string | null;
  size: string;
  color: string;
  variantLabel: string;
  quantity: number;
  pricePaise: number;
  status: string;
  reason: string;
  /** Free-text the shopper added, when they did. */
  details: string | null;
  rejectionReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  receivedAt: string | null;
  rejectedAt: string | null;
  /** Courier AWB for the pickup leg, once the item shipped back. */
  awbNumber: string | null;
  courierName: string | null;
  refund: { status: string; amountPaise: number; processedAt: string | null } | null;
}

export interface MyReturnsResponse {
  items: MyReturnRow[];
  summary: {
    counts: Record<ReturnFilter, number>;
    /** Money actually refunded so far. */
    refundedPaise: number;
    /** Refunds initiated but not yet processed. */
    pendingRefundPaise: number;
  };
  /** Days after delivery a return can still be raised. */
  returnWindowDays: number;
}

// ---------------------------------------------------------------------------
// Account dashboard
// ---------------------------------------------------------------------------

/** Everything the account overview renders, in one round trip. */
export interface AccountOverview {
  profile: {
    name: string | null;
    phone: string;
    email: string | null;
    avatarUrl: string | null;
    isPremium: boolean;
    premiumSince: string | null;
    memberSince: string;
  };
  stats: {
    orders: number;
    wishlist: number;
    /** Clowe Wallet = shopping credits, in paise. */
    walletPaise: number;
    walletCredits: number;
    coupons: number;
    returns: number;
  };
  recentOrders: OrderListRow[];
  defaultAddress: AddressInfo | null;
  addressCount: number;
  paymentMethods: SavedPaymentMethodInfo[];
  recentlyViewed: ProductListItem[];
}
