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
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

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
  totalPaise: number;
  payment: { provider: string; status: string } | null;
  /** True while payment is still pending (mock/razorpay not completed). */
  awaitingPayment: boolean;
  canCancel: boolean;
}

export const returnRequestSchema = z.object({
  reason: z.string().trim().min(5, 'Tell us briefly why (min 5 chars)').max(300),
});
