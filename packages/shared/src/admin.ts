import { z } from 'zod';
import type { ProductStatusValue, SellerReturnRow, SellerStatusValue } from './seller';
import type { UserRole } from './index';

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

export const categoryUpsertSchema = z.object({
  name: z.string().trim().min(2).max(40),
  parentId: z.string().nullable().optional(),
  imageUrl: z.string().url().optional(),
  /** Emoji/glyph shown in the category nav bar and mega menu. */
  icon: z.string().trim().max(8).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
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
}

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
  variants: {
    sku: string;
    size: string;
    color: string;
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
}

export interface AdminCategoryRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  icon: string | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}

export interface AdminUserRow {
  id: string;
  phone: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
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
