import { z } from 'zod';
import { phoneSchema } from './auth';

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
  };
}

// ---------------------------------------------------------------------------
// Public order tracking
// ---------------------------------------------------------------------------

export const trackOrderSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .regex(/^CLW-\d{4}-\d{6}$/i, 'Order number looks like CLW-2026-123456'),
  phone: phoneSchema,
});
export type TrackOrderInput = z.infer<typeof trackOrderSchema>;

export interface TrackOrderItem {
  title: string;
  imageUrl: string | null;
  quantity: number;
  size: string;
  color: string;
  status: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  courierName: string | null;
  awbNumber: string | null;
  trackingUrl: string | null;
}

export interface TrackOrderView {
  orderNumber: string;
  status: string;
  placedAt: string;
  paid: boolean;
  shipCity: string;
  shipState: string;
  shipPincode: string;
  items: TrackOrderItem[];
}
