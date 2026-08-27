import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller support & help centre
// ---------------------------------------------------------------------------

export const TICKET_CATEGORIES = [
  'ACCOUNT',
  'LISTING',
  'ORDERS',
  'PAYOUTS',
  'RETURNS',
  'POLICY',
  'TECHNICAL',
  'OTHER',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  ACCOUNT: 'Account & verification',
  LISTING: 'Products & listings',
  ORDERS: 'Orders & shipping',
  PAYOUTS: 'Payouts & payments',
  RETURNS: 'Returns & refunds',
  POLICY: 'Policy & compliance',
  TECHNICAL: 'Technical problem',
  OTHER: 'Something else',
};

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatusValue = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatusValue, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TicketPriorityValue = (typeof TICKET_PRIORITIES)[number];

export const TICKET_PRIORITY_LABELS: Record<TicketPriorityValue, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export interface SupportTicketMessageRow {
  id: string;
  authorRole: 'SELLER' | 'ADMIN';
  authorName: string | null;
  body: string;
  attachments: string[];
  createdAt: string;
}

export interface SupportTicketRow {
  id: string;
  reference: string;
  category: TicketCategory;
  categoryLabel: string;
  subject: string;
  status: TicketStatusValue;
  statusLabel: string;
  priority: TicketPriorityValue;
  orderNumber: string | null;
  messageCount: number;
  /** Preview of the newest message in the thread. */
  lastMessage: string | null;
  lastMessageAt: string;
  /** Minutes from first message to the first staff reply. */
  firstResponseMinutes: number | null;
  rating: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SupportTicketDetail extends SupportTicketRow {
  messages: SupportTicketMessageRow[];
  shopName?: string;
}

export interface SupportTicketPage {
  rows: SupportTicketRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** One measured account-health metric with its threshold. */
export interface AccountHealthMetric {
  key: string;
  label: string;
  /** Percentage, 0–100. */
  value: number;
  /** At or below this is healthy. */
  target: number;
  rating: 'GOOD' | 'WATCH' | 'POOR';
  detail: string;
}

export interface SellerSupportSummary {
  tickets: {
    open: number;
    inProgress: number;
    resolved: number;
    /** Median first-response time across answered tickets, in minutes. */
    avgResponseMinutes: number | null;
    /** Average of the seller's own ticket ratings, out of 5. */
    satisfaction: number | null;
    ratedCount: number;
  };
  health: {
    overall: 'GOOD' | 'WATCH' | 'POOR';
    summary: string;
    metrics: AccountHealthMetric[];
    /** Orders the metrics were measured over. */
    sampleSize: number;
  };
  recentTickets: SupportTicketRow[];
}

export const ticketCreateSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().trim().min(5, 'Give your ticket a subject').max(120),
  body: z.string().trim().min(20, 'Describe the problem in at least 20 characters').max(4000),
  priority: z.enum(TICKET_PRIORITIES).default('MEDIUM'),
  orderNumber: z.string().trim().max(40).optional(),
  productId: z.string().trim().max(40).optional(),
  attachments: z.array(z.string().url()).max(5).default([]),
});
export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;

export const ticketReplySchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(4000),
  attachments: z.array(z.string().url()).max(5).default([]),
});
export type TicketReplyInput = z.infer<typeof ticketReplySchema>;

export const ticketRatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(300).optional(),
});
export type TicketRatingInput = z.infer<typeof ticketRatingSchema>;

/** Admin-side ticket update. */
export const ticketAdminUpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});
export type TicketAdminUpdateInput = z.infer<typeof ticketAdminUpdateSchema>;

export const sellerAssistantSchema = z.object({
  question: z.string().trim().min(3).max(500),
  /** Prior turns, so follow-up questions keep their context. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
    .max(10)
    .default([]),
});
export type SellerAssistantInput = z.infer<typeof sellerAssistantSchema>;

export interface SellerAssistantReply {
  answer: string;
  provider: string;
  /** Help-centre articles the answer was grounded in. */
  sources: { id: string; title: string }[];
}
