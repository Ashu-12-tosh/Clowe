import type { CourierWarehouseView } from './sellerStore';
import { z } from 'zod';
import type { PeriodWindow } from './istPeriods';
import type { SellerKycSummary } from './kyc';

// ---------------------------------------------------------------------------
// Admin seller management
// ---------------------------------------------------------------------------

export const SELLER_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'BANNED',
] as const;
export type AdminSellerStatus = (typeof SELLER_STATUSES)[number];

export const SELLER_STATUS_LABELS: Record<AdminSellerStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Active',
  REJECTED: 'Rejected',
  SUSPENDED: 'Suspended',
  BANNED: 'Banned',
};

export const KYC_STATUSES = ['PENDING_DOCS', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const KYC_STATUS_LABELS: Record<KycStatus, string> = {
  PENDING_DOCS: 'Pending docs',
  UNDER_REVIEW: 'Under review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
};

/** Entity types a shop can register as. */
export const BUSINESS_TYPES = [
  'Proprietorship',
  'Partnership',
  'Private Limited',
  'LLP',
  'Individual',
] as const;

export const ADMIN_SELLER_SORTS = ['NEWEST', 'OLDEST', 'GMV_HIGH', 'ORDERS_HIGH', 'NAME'] as const;
export type AdminSellerSort = (typeof ADMIN_SELLER_SORTS)[number];

export const ADMIN_SELLER_SORT_LABELS: Record<AdminSellerSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  GMV_HIGH: 'GMV: high to low',
  ORDERS_HIGH: 'Most orders',
  NAME: 'Shop name (A–Z)',
};

export interface AdminSellerListRow {
  id: string;
  /** Human reference, e.g. SEL-1A2B3C. */
  sellerId: string;
  shopName: string;
  ownerName: string | null;
  email: string | null;
  phone: string;
  businessType: string | null;
  status: AdminSellerStatus;
  statusLabel: string;
  kycStatus: KycStatus;
  kycLabel: string;
  city: string | null;
  state: string | null;
  /** Category this shop sells the most in. */
  primaryCategory: string | null;
  joinedAt: string;
  productCount: number;
  liveProductCount: number;
  orderCount: number;
  /** Gross merchandise value this calendar month. */
  gmvMonthPaise: number;
  gmvTotalPaise: number;
  ratingAvg: number | null;
  suspensionReason: string | null;
  rejectionReason: string | null;
  /**
   * Fraud signals found by KYC, shown in the list as well as the detail so
   * they cannot be missed by an admin who never opens the seller.
   */
  kycAlerts: { panGstinMismatch: boolean; fraudAccount: boolean };
  /**
   * No complete business address in Store Settings: the "Sold by" box cannot
   * show one, so every listing and the store page stay hidden from shoppers
   * until the seller fills it in.
   */
  addressMissing: boolean;
}

export interface AdminSellerPage {
  rows: AdminSellerListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminSellerDetail extends AdminSellerListRow {
  description: string | null;
  addressLine1: string | null;
  pincode: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  kycReviewedAt: string | null;
  approvedAt: string | null;
  panName: string | null;
  /** Every automated KYC check: status, score, band, provider, time. */
  kyc: SellerKycSummary;
  /** What the approval confirmation must say. Empty = nothing to warn about. */
  kycApprovalWarnings: string[];
  /**
   * What stops a first approval outright (unlike KYC warnings, these can't be
   * acknowledged past). Empty = nothing blocks it.
   */
  approvalBlockers: string[];
  /** No handling fee on new orders, whatever the plan (owner's Batch 2). */
  vip: boolean;
  /** The seller's plan. */
  plan: string;
  /** The application (Vendor Terms 2.1): documents (short-lived URLs), requests for more, terms accepted. */
  application: {
    applicationId: string;
    submittedAt: string | null;
    documents: { key: 'constitutionDoc' | 'cancelledChequeDoc' | 'signatoryKycDoc' | 'brandAuthorisationDoc'; label: string; url: string | null }[];
    infoRequest: string | null;
    infoRequestedAt: string | null;
    vendorTermsCurrent: boolean;
    termsAcceptances: { version: string; acceptedAt: string; ip: string | null; userAgent: string | null }[];
  };
  /** The pickup address as registered with Delhivery. */
  courierWarehouse: CourierWarehouseView;
  /** Performance the admin judges the shop on. */
  performance: {
    unitsSold: number;
    returnRate: number;
    cancelRate: number;
    onTimeRate: number | null;
    avgRating: number | null;
    reviewCount: number;
    openReturns: number;
    payoutsPaise: number;
  };
  recentOrders: {
    orderNumber: string;
    placedAt: string;
    amountPaise: number;
    status: string;
  }[];
  notes: { id: string; body: string; authorName: string | null; createdAt: string }[];
}

export interface AdminSellerSummary {
  /** This month so far, and the same days of last month that every change compares with. */
  period: PeriodWindow;
  kpis: {
    total: number;
    totalChangePercent: number | null;
    active: number;
    verified: number;
    pendingVerification: number;
    suspended: number;
    banned: number;
  };
  /** New sellers per day over the last 30 days. */
  growth: { date: string; count: number }[];
  verification: { key: KycStatus; label: string; count: number; share: number }[];
  statusDistribution: { key: AdminSellerStatus; label: string; count: number; share: number }[];
  topCategories: { id: string; name: string; gmvPaise: number; share: number }[];
  /** Cities/states the marketplace has sellers in, for the filter. */
  cities: string[];
  counts: Record<AdminSellerStatus | 'ALL', number>;
}

export const adminSellerActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    /**
     * Approval is not blocked by KYC, but it is not blind either: with
     * warnings outstanding the request must say it has seen them, or it is
     * refused with the list.
     */
    acknowledgeKycWarnings: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(5, 'Give the seller a reason').max(300),
  }),
  z.object({
    action: z.literal('suspend'),
    reason: z.string().trim().min(5, 'Give the seller a reason').max(300),
  }),
  z.object({
    action: z.literal('ban'),
    reason: z.string().trim().min(5, 'Give the seller a reason').max(300),
  }),
  z.object({
    action: z.literal('reinstate'),
    /** Reinstating a rejected seller is their first approval; the same rule applies. */
    acknowledgeKycWarnings: z.boolean().optional(),
  }),
]);
export type AdminSellerActionInput = z.infer<typeof adminSellerActionSchema>;

export const adminSellerKycSchema = z.object({
  kycStatus: z.enum(KYC_STATUSES),
  businessType: z.string().trim().max(40).optional(),
});
export type AdminSellerKycInput = z.infer<typeof adminSellerKycSchema>;

export const adminSellerNoteSchema = z.object({
  body: z.string().trim().min(3, 'Write a note').max(1000),
});
export type AdminSellerNoteInput = z.infer<typeof adminSellerNoteSchema>;

/** The refusal a seller's first approval meets without a GSTIN: every tax invoice to a buyer is issued under it. */
/** An admin asks a pending applicant for more before deciding ("Needs more info"). */
export const sellerInfoRequestSchema = z.object({ message: z.string().trim().min(5, 'Say what is needed').max(1000) });

export const SELLER_DOCUMENT_LABELS = {
  constitutionDoc: 'Constitution document',
  cancelledChequeDoc: 'Cancelled cheque',
  signatoryKycDoc: 'Authorised signatory KYC',
  brandAuthorisationDoc: 'Brand authorisation (optional)',
} as const;

export const GSTIN_APPROVAL_BLOCKER = 'GSTIN required before approval — every tax invoice to a buyer is issued under it';

/** What blocks a seller's first approval. Already-approved sellers have none. */
export function approvalBlockersFor(seller: { approvedAt: string | Date | null; gstNumber: string | null }): string[] {
  if (seller.approvedAt) return [];
  return seller.gstNumber?.trim() ? [] : [GSTIN_APPROVAL_BLOCKER];
}
