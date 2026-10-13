import { z } from 'zod';

// ---------------------------------------------------------------------------
// The admin support inbox: seller tickets and customer complaints as one list
// of conversations, WhatsApp Web style. Replies and status changes go through
// each kind's own endpoints (/api/admin/support for sellers,
// /api/admin/support-desk for customers), so notifications and response-time
// stamps stay exactly as they were.
// ---------------------------------------------------------------------------

export const INBOX_KINDS = ['SELLER', 'CUSTOMER'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Every status either kind can be in; PENDING_CUSTOMER is customers only. */
export const INBOX_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const INBOX_STATUS_LABELS: Record<InboxStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  PENDING_CUSTOMER: 'Waiting on customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};
/** What an admin may set, per kind. */
export const INBOX_STATUSES_FOR: Record<InboxKind, readonly InboxStatus[]> = {
  SELLER: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  CUSTOMER: INBOX_STATUSES,
};

export const inboxListQuerySchema = z.object({
  status: z.enum(['ALL', 'ACTIVE', ...INBOX_STATUSES]).default('ACTIVE'),
  kind: z.enum(['ALL', ...INBOX_KINDS]).default('ALL'),
  q: z.string().trim().max(80).optional(),
});
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

/** One conversation in the left-hand list. */
export interface InboxRow {
  kind: InboxKind;
  id: string;
  /** TK-000123 or CMP-2026-48213. */
  reference: string;
  /** The shop's name, or the customer's. */
  name: string;
  subject: string;
  lastMessage: string;
  /** Who spoke last: them, or us (an admin / agent). */
  lastFrom: 'THEM' | 'US';
  lastMessageAt: string;
  status: InboxStatus;
  priority: string;
  /** Their messages since an admin last opened this conversation. */
  unread: number;
}

export interface InboxPage {
  rows: InboxRow[];
  /** Unread messages across every conversation that matches, not just the rows shown. */
  unreadTotal: number;
}

export interface InboxMessage {
  id: string;
  from: 'THEM' | 'US' | 'SYSTEM';
  authorName: string | null;
  body: string;
  attachments: string[];
  /** A customer-desk note only admins see. */
  internal: boolean;
  createdAt: string;
}

export interface InboxThread {
  row: InboxRow;
  /** Order the conversation is about, if any. */
  orderNumber: string | null;
  /** Category, as the person who raised it chose. */
  category: string;
  messages: InboxMessage[];
}
