import { z } from 'zod';
import type { ProductStatusValue, SellerStatusValue } from './seller';
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
  };
  pending: { sellers: number; products: number };
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

export interface AdminOrderRow {
  id: string;
  orderNumber: string;
  customerName: string | null;
  customerPhone: string;
  status: string;
  itemCount: number;
  totalPaise: number;
  createdAt: string;
}
