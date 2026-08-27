import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller promotions & discounts
//
// A promotion discounts the seller's own lines at checkout. The money comes
// out of the seller's payout, so every number here is theirs to manage.
// ---------------------------------------------------------------------------

export const PROMOTION_SCOPES = ['STORE', 'PRODUCT', 'CATEGORY'] as const;
export type PromotionScopeValue = (typeof PROMOTION_SCOPES)[number];

export const PROMOTION_SCOPE_LABELS: Record<PromotionScopeValue, string> = {
  STORE: 'Whole store',
  PRODUCT: 'Selected products',
  CATEGORY: 'Selected categories',
};

export const PROMOTION_KINDS = ['PERCENT', 'FLAT'] as const;
export type PromotionKindValue = (typeof PROMOTION_KINDS)[number];

export const PROMOTION_KIND_LABELS: Record<PromotionKindValue, string> = {
  PERCENT: '% off',
  FLAT: 'Flat ₹ off',
};

/** Derived from the seller's setting plus the clock — never stored. */
export const PROMOTION_STATUSES = ['RUNNING', 'SCHEDULED', 'PAUSED', 'EXPIRED', 'DRAFT'] as const;
export type PromotionStatusValue = (typeof PROMOTION_STATUSES)[number];

export const PROMOTION_STATUS_LABELS: Record<PromotionStatusValue, string> = {
  RUNNING: 'Running',
  SCHEDULED: 'Scheduled',
  PAUSED: 'Paused',
  EXPIRED: 'Expired',
  DRAFT: 'Draft',
};

export const PROMOTION_TABS = ['ALL', 'RUNNING', 'SCHEDULED', 'EXPIRED', 'DRAFT'] as const;
export type PromotionTab = (typeof PROMOTION_TABS)[number];

export const PROMOTION_TAB_LABELS: Record<PromotionTab, string> = {
  ALL: 'All promotions',
  RUNNING: 'Running',
  SCHEDULED: 'Scheduled',
  EXPIRED: 'Expired',
  DRAFT: 'Drafts',
};

export interface SellerPromotionRow {
  id: string;
  name: string;
  description: string | null;
  code: string | null;
  scope: PromotionScopeValue;
  scopeLabel: string;
  kind: PromotionKindValue;
  value: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  startAt: string;
  endAt: string;
  usageLimit: number | null;
  perUserLimit: number | null;
  usedCount: number;
  /** Total taken off shopper carts so far. */
  discountGivenPaise: number;
  /** Gross value of the orders this promotion appeared on. */
  salesGeneratedPaise: number;
  orderCount: number;
  /** salesGenerated ÷ discountGiven — how much sale each rupee bought. */
  roi: number | null;
  status: PromotionStatusValue;
  isFeatured: boolean;
  productIds: string[];
  categoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SellerPromotionPage {
  rows: SellerPromotionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SellerPromotionSummary {
  kpis: {
    active: number;
    newThisMonth: number;
    redemptions: number;
    redemptionsChangePercent: number | null;
    discountGivenPaise: number;
    discountChangePercent: number | null;
    salesFromPromotionsPaise: number;
    salesChangePercent: number | null;
    /** Sales generated per rupee of discount, across all promotions. */
    roi: number | null;
  };
  /** Sales split by promotion scope, for the performance donut. */
  performance: { key: string; label: string; amountPaise: number; share: number }[];
  topPromotions: {
    id: string;
    name: string;
    code: string | null;
    salesPaise: number;
    orderCount: number;
  }[];
  counts: Record<PromotionTab, number>;
}

export interface SellerPromotionDetail extends SellerPromotionRow {
  redemptions: {
    id: string;
    orderNumber: string;
    customerName: string | null;
    grossPaise: number;
    discountPaise: number;
    createdAt: string;
  }[];
}

const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');

export const promotionUpsertSchema = z
  .object({
    name: z.string().trim().min(3, 'Give the promotion a name').max(60),
    description: z.string().trim().max(200).optional(),
    /** Blank = applies automatically, no code needed. */
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4,16}$/, 'Codes use 4–16 letters or numbers')
      .optional()
      .or(z.literal('')),
    scope: z.enum(PROMOTION_SCOPES),
    kind: z.enum(PROMOTION_KINDS),
    /** Percent (1–90) or flat paise off. */
    value: z.number().int().min(1),
    maxDiscountPaise: z.number().int().min(0).nullable().optional(),
    minOrderPaise: z.number().int().min(0).default(0),
    startAt: isoDate,
    endAt: isoDate,
    usageLimit: z.number().int().min(1).nullable().optional(),
    perUserLimit: z.number().int().min(1).nullable().optional(),
    productIds: z.array(z.string()).max(200).default([]),
    categoryIds: z.array(z.string()).max(50).default([]),
    isFeatured: z.boolean().default(false),
    /** DRAFT keeps it private; ACTIVE lets it run in its window. */
    state: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'PERCENT' && value.value > 90) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'Percentage discounts are capped at 90%',
      });
    }
    if (new Date(value.endAt) <= new Date(value.startAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endAt'],
        message: 'The end date must be after the start date',
      });
    }
    if (value.scope === 'PRODUCT' && value.productIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productIds'],
        message: 'Pick at least one product',
      });
    }
    if (value.scope === 'CATEGORY' && value.categoryIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categoryIds'],
        message: 'Pick at least one category',
      });
    }
  });
export type PromotionUpsertInput = z.infer<typeof promotionUpsertSchema>;

export const promotionStateSchema = z.object({
  state: z.enum(['DRAFT', 'ACTIVE', 'PAUSED']),
});
