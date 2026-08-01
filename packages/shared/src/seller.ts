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

export type SellerStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
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
});
export type SellerVariantInput = z.infer<typeof sellerVariantInputSchema>;

export const sellerProductUpsertSchema = z.object({
  title: z.string().trim().min(3).max(120),
  categoryId: z.string().min(1, 'Pick a category'),
  brand: z.string().trim().max(40).optional(),
  description: z.string().trim().min(20, 'Description must be at least 20 characters').max(3000),
  imageUrls: z.array(z.string().url()).min(1, 'Add at least one image').max(6),
  variants: z.array(sellerVariantInputSchema).min(1, 'Add at least one variant').max(60),
});
export type SellerProductUpsertInput = z.infer<typeof sellerProductUpsertSchema>;

export interface SellerProductListItem {
  id: string;
  title: string;
  slug: string;
  status: ProductStatusValue;
  rejectionReason: string | null;
  categoryName: string;
  imageUrl: string | null;
  variantCount: number;
  totalStock: number;
  minPricePaise: number;
  updatedAt: string;
}

export interface SellerProductDetail {
  id: string;
  title: string;
  categoryId: string;
  brand: string | null;
  description: string;
  status: ProductStatusValue;
  rejectionReason: string | null;
  imageUrls: string[];
  variants: {
    id: string;
    size: string;
    color: string;
    pricePaise: number;
    mrpPaise: number | null;
    stock: number;
  }[];
}

// ---------------------------------------------------------------------------
// Seller orders & stats
// ---------------------------------------------------------------------------

export interface SellerOrderItemRow {
  id: string;
  orderNumber: string;
  placedAt: string;
  title: string;
  size: string;
  color: string;
  quantity: number;
  pricePaise: number;
  status: string;
  /** Set when the customer has requested a return for this item. */
  returnId: string | null;
  shipTo: { name: string; city: string; state: string; pincode: string };
}

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
