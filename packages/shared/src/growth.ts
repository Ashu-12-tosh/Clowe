import { z } from 'zod';
import { loginIdentifierSchema, phoneSchema } from './auth';
import type { ParcelTracking } from './tracking';
import { ORDER_NUMBER_PATTERN } from './orderNumber';

// ---------------------------------------------------------------------------
// Referral program
// ---------------------------------------------------------------------------

export interface ReferralRow {
  name: string; // masked, e.g. "Priya S." or "+91 98•••••210"
  status: 'PENDING' | 'CREDITED';
  rewardPaise: number;
  joinedAt: string;
}

export interface ReferralView {
  code: string;
  shareText: string;
  rewardPerReferralPaise: number;
  totalEarnedPaise: number;
  pendingCount: number;
  referrals: ReferralRow[];
}

// ---------------------------------------------------------------------------
// Notifications (in-app)
// ---------------------------------------------------------------------------

export const NOTIFICATION_CATEGORIES = ['ORDERS', 'OFFERS', 'ACCOUNT', 'SELLER'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  ORDERS: 'Orders',
  OFFERS: 'Offers & Rewards',
  ACCOUNT: 'Account',
  SELLER: 'Seller',
};

/** Which chip a notification type belongs under. */
export function notificationCategory(type: string): NotificationCategory {
  if (
    type.startsWith('AD_') ||
    type.startsWith('SELLER_') ||
    type.startsWith('PAYOUT_') ||
    type.startsWith('SUPPORT_') ||
    type === 'NEW_ORDER'
  ) {
    return 'SELLER';
  }
  if (
    type.startsWith('ORDER_') ||
    type.startsWith('ITEM_') ||
    type.startsWith('RETURN_') ||
    type.startsWith('REFUND_')
  ) {
    return 'ORDERS';
  }
  if (type === 'CREDITS_EARNED' || type === 'REFERRAL_CREDITED' || type.startsWith('OFFER_')) {
    return 'OFFERS';
  }
  return 'ACCOUNT';
}

/** Button label for a row's deep link, by category. */
export const NOTIFICATION_CTA_LABELS: Record<NotificationCategory, string> = {
  ORDERS: 'View Order',
  OFFERS: 'View Offer',
  ACCOUNT: 'Review Activity',
  SELLER: 'Open Seller Panel',
};

export interface NotificationRow {
  id: string;
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** In-app deep link for the row's CTA. */
  linkHref: string | null;
  imageUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

/** What a badge polls: cheap enough to ask every few seconds. */
export interface UnreadNotifications {
  unreadCount: number;
  /** When the newest notification arrived; a change means "reload the list". */
  latestAt: string | null;
}

export interface NotificationList {
  items: NotificationRow[];
  unreadCount: number;
  /** Rows matching the current filter, for paging. */
  total: number;
  summary: {
    total: number;
    unread: number;
    today: number;
    thisWeek: number;
    /** Count per category across everything (drives the chips). */
    byCategory: Record<NotificationCategory, number>;
    /** Oldest notification - drives the year list in the "received in" filter. */
    firstAt: string | null;
  };
}

// ---------------------------------------------------------------------------
// Public order tracking
// ---------------------------------------------------------------------------

const trackOrderNumber = z
  .string()
  .trim()
  .regex(ORDER_NUMBER_PATTERN, 'Check the order number: it is on your order confirmation, e.g. CLW-7KQ3MX9P2T');

/** Kept for links and tools from before Track Order asked for a code. */
export const trackOrderSchema = z.object({ orderNumber: trackOrderNumber, phone: phoneSchema });
export type TrackOrderInput = z.infer<typeof trackOrderSchema>;

/**
 * Track Order, step 1: the order number and the phone or email on the order.
 * A one-time code goes to that phone (SMS) or that email.
 */
export const trackCodeRequestSchema = z.object({ orderNumber: trackOrderNumber, contact: loginIdentifierSchema });
/** Step 2: the code. Right, it gives a short-lived token for this one order. */
export const trackCodeVerifySchema = trackCodeRequestSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export interface TrackCodeSent {
  channel: 'sms' | 'email';
  /** Where it went, masked: "98•••••210" or "pa•••@gmail.com". */
  sentTo: string;
  resendAfterSec: number;
  expiresInSec: number;
  /** Development with the mock only. */
  devOtp?: string;
}

export interface TrackCodeVerified {
  /** Sent back as the x-track-token header; good for TRACK_TOKEN_TTL_MIN minutes. */
  token: string;
  expiresInSec: number;
}

/** One courier scan, as older pages show it: what happened, where, when. */
export interface TrackingScanView {
  at: string;
  status: string;
  location: string | null;
}

export interface TrackOrderView {
  orderNumber: string;
  status: string;
  placedAt: string;
  paid: boolean;
  shipCity: string;
  shipState: string;
  shipPincode: string;
  /** One bar per parcel, with Delhivery's scans and the AWB. */
  parcels: ParcelTracking[];
}
