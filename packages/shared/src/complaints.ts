import { z } from 'zod';

export const COMPLAINT_CATEGORIES = [
  'ORDER',
  'PAYMENT',
  'PRODUCT_QUALITY',
  'DELIVERY',
  'ACCOUNT',
  'OTHER',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

/**
 * A request to stop a parcel already dispatched (Cancellation Policy 1.2):
 * a DELIVERY complaint with this subject, forwarded to the seller and the
 * courier, accommodated where the parcel can still be intercepted.
 */
export const INTERCEPT_SUBJECT = 'Stop my parcel — cancel after dispatch';
export const interceptRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const COMPLAINT_CATEGORY_LABELS: Record<ComplaintCategory, string> = {
  ORDER: 'Order issue',
  PAYMENT: 'Payment issue',
  PRODUCT_QUALITY: 'Product quality',
  DELIVERY: 'Delivery issue',
  ACCOUNT: 'Account issue',
  OTHER: 'Other',
};

export const COMPLAINT_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export type ComplaintStatusValue = (typeof COMPLAINT_STATUSES)[number];

/** POST /api/complaints */
export const complaintCreateSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES),
  description: z.string().trim().min(10, 'Please describe the issue in a few words').max(1000),
  orderId: z.string().optional(),
});
export type ComplaintCreateInput = z.infer<typeof complaintCreateSchema>;

/** PATCH /api/admin/complaints/:id */
export const adminComplaintUpdateSchema = z.object({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  adminNotes: z.string().trim().max(2000).optional(),
});

export interface ComplaintRow {
  id: string;
  complaintId: string;
  category: ComplaintCategory;
  description: string;
  status: ComplaintStatusValue;
  orderNumber: string | null;
  createdAt: string;
}

export interface AdminComplaintRow extends ComplaintRow {
  userName: string | null;
  userPhone: string;
  orderId: string | null;
  adminNotes: string | null;
  updatedAt: string;
}
