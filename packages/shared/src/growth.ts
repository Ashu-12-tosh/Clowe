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

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationRow[];
  unreadCount: number;
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
