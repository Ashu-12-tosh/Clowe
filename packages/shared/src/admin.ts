import { imageUrlSchema } from './imageUrl';
import { z } from 'zod';
import { categoryRulesInputSchema, type CategoryRuleFields, type CategoryRules } from './categoryRules';
import type { ProductStatusValue, SellerReturnRow, SellerStatusValue } from './seller';
import type { UserRole } from './index';
import type { BrandAuthView } from './brandAuth';
import { productAttributeInputSchema } from './productAttributes';

// ---------------------------------------------------------------------------
// Moderation decisions
// ---------------------------------------------------------------------------

export const sellerDecisionSchema = z.object({
  action: z.enum(['approve', 'reject', 'suspend']),
  reason: z.string().trim().max(300).optional(),
});
export type SellerDecisionInput = z.infer<typeof sellerDecisionSchema>;

export const productDecisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(300).optional(),
});
export type ProductDecisionInput = z.infer<typeof productDecisionSchema>;

// ---------------------------------------------------------------------------
// Category management
// ---------------------------------------------------------------------------

/** One bullet on a category landing page: icon, title, a line under it. */
export const categoryCalloutSchema = z.object({
  icon: z.string().trim().max(8),
  title: z.string().trim().min(2).max(60),
  subtitle: z.string().trim().max(120),
});

export const categoryUpsertSchema = z.object({
  name: z.string().trim().min(2).max(40),
  parentId: z.string().nullable().optional(),
  /** The tile picture (home "Shop by Category", subcategory tiles); null removes it. */
  imageUrl: imageUrlSchema.nullable().optional(),
  /** Emoji/glyph shown in the category nav bar and mega menu. */
  icon: z.string().trim().max(8).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  /** Referral fee for products here, percent of the selling price (owner's Batch 2). */
  referralPercent: z.number().min(0).max(50).optional(),
  /** The landing page's hero side-card bullets and bottom feature strip. */
  highlights: z.array(categoryCalloutSchema).max(8).optional(),
  features: z.array(categoryCalloutSchema).max(8).optional(),
}).merge(categoryRulesInputSchema);
export type CategoryUpsertInput = z.infer<typeof categoryUpsertSchema>;

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export interface AdminStats {
  totals: {
    users: number;
    sellers: number;
    products: number;
    liveProducts: number;
    orders: number;
    unitsSold: number;
    revenuePaise: number;
    returns: number;
  };
  pending: { sellers: number; products: number; complaints: number; returns: number };
  topProducts: { id: string; title: string; unitsSold: number; revenuePaise: number }[];
  sellerBreakdown: {
    sellerId: string;
    shopName: string;
    status: SellerStatusValue;
    liveProducts: number;
    unitsSold: number;
    revenuePaise: number;
  }[];
}

export interface AdminSellerRow {
  id: string;
  shopName: string;
  status: SellerStatusValue;
  rejectionReason: string | null;
  phone: string;
  userName: string | null;
  city: string | null;
  state: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  productCount: number;
  createdAt: string;
}

export interface AdminProductRow {
  id: string;
  title: string;
  slug: string;
  status: ProductStatusValue;
  rejectionReason: string | null;
  brand: string | null;
  categoryName: string;
  shopName: string;
  imageUrl: string | null;
  minPricePaise: number;
  variantCount: number;
  createdAt: string;
  /** When the row is an edit to a live listing waiting for review. */
  revisionSubmittedAt: string | null;
  /** The seller has no business address: the listing is hidden from shoppers until it is filled. */
  sellerAddressMissing: boolean;
  /** For a brand that needs authorization; null for every other brand. */
  brandAuth: BrandAuthView | null;
}

/** An edit to a live listing, as the review screen shows it beside the live version. */
export interface AdminProductRevision {
  submittedAt: string | null;
  /** title, category, brand, shortDescription, description, video, attributes, highlights, images, variants, newVariants */
  changedFields: string[];
  proposed: {
    title: string;
    categoryName: string;
    brand: string | null;
    shortDescription: string | null;
    description: string;
    videoUrl: string | null;
    imageUrls: string[];
    highlights: string[];
    attributes: { label: string; value: string }[];
    /** Live variants whose options or pictures change, by their new label. */
    variantEdits: { label: string; imageCount: number | null }[];
    newVariants: { label: string; pricePaise: number; stock: number }[];
  };
}

export const revisionDecisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(300).optional(),
});

/** Full product view for the admin review screen. */
export interface AdminProductDetail {
  id: string;
  title: string;
  slug: string;
  status: ProductStatusValue;
  rejectionReason: string | null;
  brand: string | null;
  categoryName: string;
  description: string;
  imageUrls: string[];
  /** Internal notes on pictures, by position ("low-res, replace later"); null where none. */
  imageNotes: (string | null)[];
  /** Packing video uploaded with the listing (expires after 10 days). */
  variants: {
    sku: string;
    size: string;
    color: string;
    optionValues: Record<string, string>;
    label: string;
    pricePaise: number;
    mrpPaise: number | null;
    stock: number;
  }[];
  seller: {
    shopName: string;
    status: SellerStatusValue;
    phone: string;
    city: string | null;
    state: string | null;
    gstNumber: string | null;
    panNumber: string | null;
  };
  createdAt: string;
  updatedAt: string;
  /** A content edit waiting for review; the fields above are the live listing. */
  revision: AdminProductRevision | null;
}

export interface AdminCategoryRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  icon: string | null;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
  /** Referral fee, percent of the selling price, on new orders. */
  referralPercent: number;
  /** 0 = root, 1 = child, 2 = grandchild. */
  depth: number;
  /** Rule fields set on this category itself (null = inherited). */
  own: CategoryRuleFields;
  /** Effective rules after inheritance. */
  rules: CategoryRules;
}

export interface AdminUserRow {
  id: string;
  phone: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  /** May order while the store is closed (owner's pre-launch switch). */
  isTestAccount: boolean;
  orderCount: number;
  createdAt: string;
}

// AdminOrderRow was replaced by AdminOrderListRow in ./adminOrders, which the
// Order Management desk uses.

// ---------------------------------------------------------------------------
// Admin returns oversight
// ---------------------------------------------------------------------------

/** SellerReturnRow + seller identity, for the cross-seller admin view. */
export interface AdminReturnRow extends SellerReturnRow {
  shopName: string;
  customerPhone: string;
}

/** Admin override: approve a seller-rejected return (dispute resolution). */
export const adminReturnOverrideSchema = z.object({
  note: z.string().trim().max(300).optional(),
});
export type AdminReturnOverrideInput = z.infer<typeof adminReturnOverrideSchema>;

/**
 * PATCH /api/admin/products/:id/listing — an admin fixes a listing on the
 * seller's behalf, applied at once and recorded as "Listing edited by Clowe
 * admin" with every value before and after. `sizes` turns the variants into
 * one per size at today's price, the stock split evenly (at least 1 each).
 */
export const adminListingEditSchema = z.object({
  /** Move the listing to another (active) category — e.g. for the right HSN code. */
  categoryId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(3).max(150).optional(),
  brand: z.string().trim().min(1).max(40).optional(),
  shortDescription: z.string().trim().max(200).optional(),
  description: z.string().trim().min(20).max(5000).optional(),
  attributes: z.array(productAttributeInputSchema).max(20).optional(),
  sizes: z.array(z.string().trim().min(1).max(20)).min(1).max(12).optional(),
  /**
   * The listing's pictures in order (the first is the main one), each URL from
   * POST /api/uploads; `qualityNote` is internal ("low-res, replace later").
   */
  images: z
    .array(z.object({ url: imageUrlSchema, qualityNote: z.string().trim().max(80).optional() }))
    .min(1)
    .max(8)
    .optional(),
  visible: z.boolean().optional(),
  /** Why: kept with the edit. */
  reason: z.string().trim().min(5).max(300),
});
export type AdminListingEditInput = z.infer<typeof adminListingEditSchema>;
