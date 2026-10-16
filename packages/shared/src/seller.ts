import { imageUrlSchema } from './imageUrl';
import { httpUrlSchema } from './url';
import { SHIPPING_LIMITS } from './shipping';
import { z } from 'zod';
import { gstNumberField, gstinMatchesPan, panNumberField } from './taxIds';
import type { PackingVideoView } from './sellerOrders';
import { optionValuesSchema } from './variants';
import { assetRefSchema } from './assets';
import { IFSC_PATTERN } from './kyc';
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
  gstNumber: gstNumberField.optional(),
  panNumber: panNumberField.optional(),
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
  })
  // The GSTIN is issued against the PAN given with it.
  .superRefine(gstinMatchesPan);
export type SellerRegisterInput = z.infer<typeof sellerRegisterSchema>;

/**
 * A seller's application as submitted (Vendor Terms 2.1): the business
 * details above, now required where the Vendor Terms require them — PAN,
 * bank account with a cancelled cheque, principal place of business — the
 * constitution document and the authorised signatory's KYC, an optional
 * brand authorisation, and acceptance of the Vendor Terms. A GSTIN stays
 * optional here ("where registration is required", 2.1(c)).
 */
export const sellerApplicationSchema = z
  .object({
    constitutionDoc: assetRefSchema,
    cancelledChequeDoc: assetRefSchema,
    signatoryKycDoc: assetRefSchema,
    brandAuthorisationDoc: assetRefSchema.optional(),
    acceptVendorTerms: z.literal(true, { errorMap: () => ({ message: 'Accept the Vendor Terms & Seller Agreement to submit' }) }),
    vendorTermsVersion: z.string().min(1),
  })
  .and(sellerRegisterSchema)
  .superRefine((v, ctx) => {
    const need = (key: string, ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
    };
    need('panNumber', !!v.panNumber, 'PAN is required');
    need('bankAccountName', !!v.bankAccountName, 'Name on the bank account is required');
    need('bankAccountNo', /^\d{9,18}$/.test(v.bankAccountNo ?? ''), 'Account number is 9–18 digits');
    need('bankIfsc', IFSC_PATTERN.test((v.bankIfsc ?? '').toUpperCase()), 'IFSC is 11 characters, like HDFC0001234');
    need('bankName', !!v.bankName, 'Bank name is required');
    need('addressLine1', !!v.addressLine1, 'Business address is required');
    need('city', !!v.city, 'City is required');
    need('state', !!v.state, 'State is required');
    need('pincode', !!v.pincode, 'PIN code is required');
  });
export type SellerApplicationInput = z.infer<typeof sellerApplicationSchema>;

/** A pending application's answer to "needs more information": any field or document again. */
export const sellerApplicationUpdateSchema = z.object({
  constitutionDoc: assetRefSchema.optional(),
  cancelledChequeDoc: assetRefSchema.optional(),
  signatoryKycDoc: assetRefSchema.optional(),
  brandAuthorisationDoc: assetRefSchema.optional(),
  gstNumber: gstNumberField.optional(),
  note: z.string().trim().max(1000).optional(),
});

export const vendorTermsAcceptSchema = z.object({ version: z.string().min(1) });

/** "SA-" and the last 8 of the profile id: the number a seller quotes for their application. */
export function sellerApplicationId(profileId: string): string {
  return `SA-${profileId.slice(-8).toUpperCase()}`;
}

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
  /** Whether a GSTIN is on file. Without one there are no payouts: every tax invoice is issued under it. */
  hasGstin: boolean;
  /** The number to quote for the application, e.g. SA-4F2A9C1B. */
  applicationId: string;
  applicationSubmittedAt: string | null;
  /** An admin asked for more before deciding (the application shows "Needs more info"). */
  infoRequest: string | null;
  /** True when the seller has accepted the current Vendor Terms. */
  vendorTermsCurrent: boolean;
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
  /** The seller's price per unit BEFORE GST; the buyer pays it plus GST at the category's rate. */
  sellerPricePaise: z.number().int().min(100, 'Price must be at least ₹1'),
  /** MRP before GST; shoppers see it with GST added, like the price. */
  sellerMrpPaise: z.number().int().min(100).nullable().optional(),
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
    // No shippingTemplate: hidden until the Delhivery integration gives it
    // meaning. A stale form that still sends one has it stripped here.
    metaTitle: z.string().trim().max(70).optional(),
    metaDescription: z.string().trim().max(160).optional(),
    tags: z.array(z.string().trim().min(2).max(30)).max(15).optional(),
    isVisible: z.boolean().optional(),
    tryOnEnabled: z.boolean().optional(),
    /** "Not returnable": pierced jewellery, customised or final-sale items. */
    nonReturnable: z.boolean().optional(),
    /** "Non-cancellable" once confirmed: customised, made-to-measure or final-sale. */
    nonCancellable: z.boolean().optional(),
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
  nonReturnable: boolean;
  nonCancellable: boolean;
  /** The 360° view's images, in order (Pro and Premium). */
  spinImages: string[];
  /** A new 360° view waiting for admin review. */
  spinImagesPending: string[];
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
    /** The seller's price and MRP, BEFORE GST: what the form edits. */
    sellerPricePaise: number;
    sellerMrpPaise: number | null;
    /** What the buyer pays and the MRP they see, GST included. */
    buyerPricePaise: number;
    buyerMrpPaise: number | null;
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
  /** Delhivery's collection from the buyer, once booked. */
  pickup: { awbNumber: string | null; status: string } | null;
  requestedAt: string;
  /** On the return's own page: the seller's packing clip for the order (never sent to the buyer). */
  packingVideo?: PackingVideoView | null;
  /** A Return Policy claim: the remedy asked for and the rest of the evidence (detail view only). */
  claim?: import('./returnClaims').ClaimEvidenceView | null;
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
