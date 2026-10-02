import { imageUrlSchema } from './imageUrl';
import { httpUrlSchema } from './url';
import { SHIPPING_LIMITS } from './shipping';
import { z } from 'zod';
import type { PackingVideoView } from './sellerOrders';
import { optionValuesSchema } from './variants';
import { productAttributeInputSchema, type ProductAttribute } from './productAttributes';

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
  bankName: z.string().trim().max(80).optional(),
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
})
  // Bank details are optional as a set, but not piecemeal: an account number
  // without the bank it belongs to is half an instruction.
  .refine((s) => !(s.bankAccountNo || s.bankIfsc || s.bankAccountName) || Boolean(s.bankName), {
    message: 'Bank name is required with bank details',
    path: ['bankName'],
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
  /**
   * Why the shop was suspended, shown to the seller. Read-only access that
   * cannot say what went wrong is not an appeal path, just a locked door.
   */
  suspensionReason: string | null;
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
  /** Option combination, e.g. { size: "L", color: "Black" } or { ram: "16GB" }. Empty = single SKU. */
  optionValues: optionValuesSchema.default({}),
  /** Legacy clients only - folded into optionValues when that is empty. */
  size: z.string().trim().max(60).optional(),
  color: z.string().trim().max(60).optional(),
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
  /**
   * Pictures for this variant, replacing whatever it has.
   *
   * Omitted is not the same as empty, and the difference is what keeps a save
   * from destroying work. Omitted means "leave this variant's images alone";
   * `[]` means "the seller cleared them". The form only sends the field for a
   * colour it actually edited, so re-colouring a variant, or editing a price,
   * can never discard pictures somebody uploaded — only an explicit edit to
   * that colour's images can.
   */
  imageUrls: z.array(imageUrlSchema).max(6).optional(),
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
    imageUrls: z.array(imageUrlSchema).max(8),
    videoUrl: httpUrlSchema(300).optional().or(z.literal('')),
    /**
     * Packing-process clip - optional; auto-removed after 10 days. The
     * reference from POST /api/uploads/video. (A per-order clip is planned to
     * replace it.)
     */
    attributes: z.array(productAttributeInputSchema).max(20).optional(),
    highlights: z.array(z.string().trim().min(3).max(120)).max(8).optional(),
    variants: z.array(sellerVariantInputSchema).max(60),
    // Blank is fine on a draft; sending anything to review needs all four
    // within range (parcelProblems).
    weightGrams: z.number().int().min(0).max(SHIPPING_LIMITS.maxWeightGrams).nullable().optional(),
    lengthMm: z.number().int().min(0).max(SHIPPING_LIMITS.maxSideMm).nullable().optional(),
    widthMm: z.number().int().min(0).max(SHIPPING_LIMITS.maxSideMm).nullable().optional(),
    heightMm: z.number().int().min(0).max(SHIPPING_LIMITS.maxSideMm).nullable().optional(),
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

/** An edit to a live listing: saved but not sent (DRAFT), waiting for review, or turned down. */
export type ProductRevisionStatusValue = 'DRAFT' | 'PENDING' | 'REJECTED';

export interface ListingRevisionInfo {
  status: ProductRevisionStatusValue;
  rejectionReason: string | null;
  submittedAt: string | null;
}

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
    /** Option combination; size/color are display caches of it. */
    optionValues: Record<string, string>;
    label: string;
    size: string;
    color: string;
    sku: string;
    pricePaise: number;
    mrpPaise: number | null;
    stock: number;
    /** This variant's own pictures; empty means it shows the product's. */
    imageUrls: string[];
  }[];
  /**
   * An edit to this live listing that is not live yet. When present, the
   * content fields above (title, descriptions, category, brand, spec sheet,
   * highlights, video, pictures, variant options and new variants) are the
   * edit's, so the form shows what the seller is working on; price, stock and
   * the other fields are the listing's own.
   */
  revision: ListingRevisionInfo | null;
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
  variantLabel: string;
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
  /** On the return's own page: the seller's packing clip for the order (never sent to the buyer). */
  packingVideo?: PackingVideoView | null;
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
