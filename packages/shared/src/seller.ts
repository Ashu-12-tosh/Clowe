import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller registration (KYC-lite)
// ---------------------------------------------------------------------------

export const sellerRegisterSchema = z.object({
  shopName: z.string().trim().min(3).max(60),
  /** Optional seller-to-seller referral code (SLR-XXXXXX). */
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^SLR-[A-Z0-9]{6}$/, 'Referral code looks like SLR-XXXXXX')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  description: z.string().trim().max(500).optional(),
  gstNumber: z.string().trim().max(20).optional(),
  panNumber: z.string().trim().max(12).optional(),
  bankAccountName: z.string().trim().max(80).optional(),
  bankAccountNo: z.string().trim().max(24).optional(),
  bankIfsc: z.string().trim().max(11).optional(),
  addressLine1: z.string().trim().max(120).optional(),
  city: z.string().trim().max(60).optional(),
  state: z.string().trim().max(60).optional(),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Pincode must be 6 digits')
    .optional(),
});
export type SellerRegisterInput = z.infer<typeof sellerRegisterSchema>;

export type SellerStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'BANNED';
export type ProductStatusValue = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';

export interface SellerProfileInfo {
  id: string;
  shopName: string;
  description: string | null;
  status: SellerStatusValue;
  rejectionReason: string | null;
  city: string | null;
  state: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Seller product create / edit
// ---------------------------------------------------------------------------

export const sellerVariantInputSchema = z.object({
  /** Present when editing an existing variant; absent for new ones. */
  id: z.string().optional(),
  size: z.string().trim().min(1).max(12),
  color: z.string().trim().min(1).max(30),
  pricePaise: z.number().int().min(100, 'Price must be at least ₹1'),
  mrpPaise: z.number().int().min(100).nullable().optional(),
  stock: z.number().int().min(0),
  /** Seller's own code; generated when left blank. */
  sku: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9._-]*$/, 'SKU can use letters, numbers, dot, dash and underscore')
    .optional(),
});
export type SellerVariantInput = z.infer<typeof sellerVariantInputSchema>;

/** Shipping speed templates a seller can attach to a listing. */
export const SHIPPING_TEMPLATES = ['STANDARD', 'EXPRESS', 'HEAVY'] as const;
export type ShippingTemplateValue = (typeof SHIPPING_TEMPLATES)[number];

export const SHIPPING_TEMPLATE_LABELS: Record<ShippingTemplateValue, string> = {
  STANDARD: 'Standard (3–5 days)',
  EXPRESS: 'Express (1–2 days)',
  HEAVY: 'Heavy / bulky (5–8 days)',
};

/** GST slabs a seller may pick; null means "use the apparel slab rule". */
export const TAX_RATES = [0, 5, 12, 18, 28] as const;

/** One row of the spec sheet. */
export const productAttributeSchema = z.object({
  name: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(120),
});
export type ProductAttribute = z.infer<typeof productAttributeSchema>;

/**
 * Attribute names to offer per top-level category, so a seller starts from a
 * sensible spec sheet instead of a blank box. Keyed by root category slug;
 * ATTRIBUTE_SUGGESTIONS.default applies when nothing matches.
 */
export const ATTRIBUTE_SUGGESTIONS: Record<string, string[]> = {
  default: ['Material', 'Colour family', 'Country of origin', 'Warranty'],
  electronics: ['Power output', 'Connector type', 'Compatible devices', 'Warranty', 'In the box'],
  fashion: ['Fabric', 'Fit', 'Pattern', 'Sleeve length', 'Occasion', 'Wash care'],
  men: ['Fabric', 'Fit', 'Pattern', 'Sleeve length', 'Occasion', 'Wash care'],
  women: ['Fabric', 'Fit', 'Pattern', 'Sleeve length', 'Occasion', 'Wash care'],
  kids: ['Fabric', 'Fit', 'Age group', 'Wash care'],
  footwear: ['Upper material', 'Sole material', 'Closure', 'Occasion'],
  beauty: ['Skin type', 'Formulation', 'Net quantity', 'Shelf life'],
  home: ['Material', 'Dimensions', 'Care instructions', 'Set contents'],
};

/** Draft = private work in progress; Pending = submitted for admin review. */
export const PRODUCT_SAVE_MODES = ['DRAFT', 'SUBMIT'] as const;
export type ProductSaveMode = (typeof PRODUCT_SAVE_MODES)[number];

export const sellerProductUpsertSchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    categoryId: z.string().min(1, 'Pick a category'),
    brand: z.string().trim().max(40).optional(),
    brandId: z.string().optional(),
    shortDescription: z.string().trim().max(200).optional(),
    description: z.string().trim().max(5000),
    imageUrls: z.array(z.string().url()).max(8),
    videoUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
    attributes: z.array(productAttributeSchema).max(20).optional(),
    highlights: z.array(z.string().trim().min(3).max(120)).max(8).optional(),
    variants: z.array(sellerVariantInputSchema).max(60),
    taxRatePercent: z.number().int().min(0).max(28).nullable().optional(),
    weightGrams: z.number().int().min(0).max(200000).nullable().optional(),
    lengthMm: z.number().int().min(0).max(300000).nullable().optional(),
    widthMm: z.number().int().min(0).max(300000).nullable().optional(),
    heightMm: z.number().int().min(0).max(300000).nullable().optional(),
    shippingTemplate: z.enum(SHIPPING_TEMPLATES).optional(),
    metaTitle: z.string().trim().max(70).optional(),
    metaDescription: z.string().trim().max(160).optional(),
    tags: z.array(z.string().trim().min(2).max(30)).max(15).optional(),
    isVisible: z.boolean().optional(),
    tryOnEnabled: z.boolean().optional(),
    lowStockAlert: z.number().int().min(0).max(1000).optional(),
    allowBackorders: z.boolean().optional(),
    /** DRAFT keeps it private; SUBMIT sends it for admin approval. */
    mode: z.enum(PRODUCT_SAVE_MODES).default('SUBMIT'),
  })
  // A draft may be half-finished; anything submitted for review must be whole.
  .superRefine((value, ctx) => {
    if (value.mode !== 'SUBMIT') return;
    if (value.description.trim().length < 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['description'],
        message: 'Description must be at least 20 characters',
      });
    }
    if (value.imageUrls.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageUrls'],
        message: 'Add at least one image',
      });
    }
    if (value.variants.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variants'],
        message: 'Add at least one variant',
      });
    }
  });
export type SellerProductUpsertInput = z.infer<typeof sellerProductUpsertSchema>;

export interface SellerProductDetail {
  id: string;
  title: string;
  slug: string;
  categoryId: string;
  brand: string | null;
  brandId: string | null;
  shortDescription: string | null;
  description: string;
  status: ProductStatusValue;
  rejectionReason: string | null;
  imageUrls: string[];
  videoUrl: string | null;
  attributes: ProductAttribute[];
  highlights: string[];
  taxRatePercent: number | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  shippingTemplate: ShippingTemplateValue | null;
  metaTitle: string | null;
  metaDescription: string | null;
  tags: string[];
  isVisible: boolean;
  tryOnEnabled: boolean;
  lowStockAlert: number;
  allowBackorders: boolean;
  variants: {
    id: string;
    size: string;
    color: string;
    sku: string;
    pricePaise: number;
    mrpPaise: number | null;
    stock: number;
  }[];
}

// ---------------------------------------------------------------------------
// Seller orders & stats
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Seller returns
// ---------------------------------------------------------------------------

export interface SellerReturnRow {
  id: string; // return id
  orderItemId: string;
  orderNumber: string;
  title: string;
  size: string;
  color: string;
  quantity: number;
  pricePaise: number;
  imageUrl: string | null;
  customerName: string;
  reason: string; // ReturnReasonValue
  details: string | null;
  photos: string[];
  status: string; // ReturnStatus
  rejectionReason: string | null;
  receivedCondition: string | null;
  adminOverrideAt: string | null;
  refund: { status: string; amountPaise: number; providerRefundId: string | null } | null;
  requestedAt: string;
}

export interface SellerStats {
  totalProducts: number;
  liveProducts: number;
  pendingProducts: number;
  totalOrderItems: number;
  unitsSold: number;
  revenuePaise: number;
  lowStockVariants: number;
}
