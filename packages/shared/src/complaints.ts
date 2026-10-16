import { z } from 'zod';

export const COMPLAINT_CATEGORIES = [
  'ORDER',
  'PAYMENT',
  'PRODUCT_QUALITY',
  'DELIVERY',
  'ACCOUNT',
  'OTHER',
  // Grievance Policy 4.3: intimate or nude images, sexual acts, impersonation
  // or morphed images (including misuse of the AI Try-On) — acted on in 24 hours.
  'URGENT_CONTENT',
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
  URGENT_CONTENT: 'Unlawful or intimate content, impersonation (urgent)',
};

// ---------------------------------------------------------------------------
// Customer Support and Grievance Policy — levels and timers.
//
// Level 1 Customer Support answers within 24 hours (2.2, 3.1), Level 2 the
// Nodal Officer within 72 hours, Level 3 the Grievance Officer acknowledges
// within 48 hours (4.1). A consumer complaint is redressed within one month
// of receipt (4.2); at the Grievance Officer within 15 days (4.1); content
// under 4.3 is acted on within 24 hours. A complaint about the product goes
// to its seller, who answers within 24 hours (2.4).
// ---------------------------------------------------------------------------

export const SUPPORT_LEVELS = ['SUPPORT', 'NODAL', 'GRIEVANCE'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export const SUPPORT_LEVEL_LABELS: Record<SupportLevel, string> = {
  SUPPORT: 'Level 1 — Customer Support',
  NODAL: 'Level 2 — Nodal Officer',
  GRIEVANCE: 'Level 3 — Grievance Officer',
};

/** Hours each level has to acknowledge (respond to) a ticket it receives. */
export const LEVEL_ACK_HOURS: Record<SupportLevel, number> = { SUPPORT: 24, NODAL: 72, GRIEVANCE: 48 };
/** Days the Grievance Officer has to dispose of a complaint (4.1). */
export const GRIEVANCE_RESOLVE_DAYS = 15;
/** Hours to act on unlawful or intimate content (4.3). */
export const URGENT_CONTENT_HOURS = 24;
/** Hours a seller has to answer a complaint about their product (2.4). */
export const SELLER_RESPONSE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** The resolve-by date for a new complaint: one month, or 24 hours for urgent content. */
export function complaintResolveDue(category: ComplaintCategory, receivedAt: Date): Date {
  if (category === 'URGENT_CONTENT') return new Date(receivedAt.getTime() + URGENT_CONTENT_HOURS * HOUR_MS);
  const due = new Date(receivedAt);
  due.setMonth(due.getMonth() + 1);
  return due;
}

/** The next level up, or null at the Grievance Officer. */
export function nextSupportLevel(level: string): SupportLevel | null {
  const i = SUPPORT_LEVELS.indexOf(level as SupportLevel);
  return i >= 0 && i < SUPPORT_LEVELS.length - 1 ? SUPPORT_LEVELS[i + 1]! : null;
}

/** Timers once a ticket reaches `level` at `at`: acknowledge, and resolve no later than before. */
export function escalationTimers(level: SupportLevel, at: Date, resolveDueAt: Date | null): { slaDueAt: Date; resolveDueAt: Date | null } {
  const slaDueAt = new Date(at.getTime() + LEVEL_ACK_HOURS[level] * HOUR_MS);
  if (level !== 'GRIEVANCE') return { slaDueAt, resolveDueAt };
  const fifteen = new Date(at.getTime() + GRIEVANCE_RESOLVE_DAYS * 24 * HOUR_MS);
  return { slaDueAt, resolveDueAt: resolveDueAt && resolveDueAt < fifteen ? resolveDueAt : fifteen };
}

export const complaintEscalateSchema = z.object({
  reason: z.string().trim().min(5, 'Say why you are not satisfied').max(1000),
});

export const sellerComplaintReplySchema = z.object({
  body: z.string().trim().min(2, 'Write a reply').max(2000),
});

/** A customer complaint about a seller's product, as the seller sees it. */
export interface SellerComplaintRow {
  id: string;
  reference: string;
  orderNumber: string | null;
  subject: string;
  description: string;
  status: string;
  dueAt: string | null;
  respondedAt: string | null;
  overdue: boolean;
  createdAt: string;
  messages: { authorRole: string; body: string; createdAt: string }[];
}

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
  /** Which level has it (Grievance Policy 3), and its resolve-by date. */
  level?: SupportLevel;
  resolveDueAt?: string | null;
}

export interface AdminComplaintRow extends ComplaintRow {
  userName: string | null;
  userPhone: string;
  orderId: string | null;
  adminNotes: string | null;
  updatedAt: string;
}
