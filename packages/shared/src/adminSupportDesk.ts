import { z } from 'zod';
import { COMPLAINT_CATEGORIES } from './complaints';

// ---------------------------------------------------------------------------
// Customer support & ticket management (admin desk)
// ---------------------------------------------------------------------------

export const SUPPORT_CHANNELS = ['CHAT', 'EMAIL', 'WEB', 'APP', 'WHATSAPP', 'PHONE'] as const;
export type SupportChannelValue = (typeof SUPPORT_CHANNELS)[number];

export const SUPPORT_CHANNEL_LABELS: Record<SupportChannelValue, string> = {
  CHAT: 'Live chat',
  EMAIL: 'Email',
  WEB: 'Web',
  APP: 'App',
  WHATSAPP: 'WhatsApp',
  PHONE: 'Phone',
};

export const DESK_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export type DeskStatus = (typeof DESK_STATUSES)[number];

export const DESK_STATUS_LABELS: Record<DeskStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  PENDING_CUSTOMER: 'Pending customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const DESK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type DeskPriority = (typeof DESK_PRIORITIES)[number];

export const DESK_PRIORITY_LABELS: Record<DeskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

/** Hours allowed for the first reply, by priority. Drives the SLA clock. */
export const SLA_RESPONSE_HOURS: Record<DeskPriority, number> = {
  URGENT: 2,
  HIGH: 8,
  MEDIUM: 24,
  LOW: 48,
};

export const SLA_STATES = ['MET', 'ON_TRACK', 'AT_RISK', 'BREACHED'] as const;
export type SlaState = (typeof SLA_STATES)[number];

export const SLA_STATE_LABELS: Record<SlaState, string> = {
  MET: 'Met',
  ON_TRACK: 'On track',
  AT_RISK: 'At risk',
  BREACHED: 'Breached',
};

export const DESK_TABS = ['ALL', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export type DeskTab = (typeof DESK_TABS)[number];

export const DESK_TAB_LABELS: Record<DeskTab, string> = {
  ALL: 'All tickets',
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  PENDING_CUSTOMER: 'Pending customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const DESK_SORTS = ['NEWEST', 'OLDEST', 'SLA_URGENT', 'PRIORITY'] as const;
export type DeskSort = (typeof DESK_SORTS)[number];

export const DESK_SORT_LABELS: Record<DeskSort, string> = {
  NEWEST: 'Newest first',
  OLDEST: 'Oldest first',
  SLA_URGENT: 'SLA: most urgent',
  PRIORITY: 'Priority: high to low',
};

export interface SupportMessageRow {
  id: string;
  authorRole: 'CUSTOMER' | 'AGENT' | 'SYSTEM';
  authorName: string | null;
  body: string;
  attachments: string[];
  isInternal: boolean;
  createdAt: string;
}

export interface SupportTicketDeskRow {
  id: string;
  reference: string;
  customer: { id: string; name: string | null; email: string | null; phone: string };
  subject: string;
  category: string;
  categoryLabel: string;
  channel: SupportChannelValue;
  channelLabel: string;
  priority: DeskPriority;
  status: DeskStatus;
  statusLabel: string;
  orderNumber: string | null;
  assignedTo: { id: string; name: string | null } | null;
  slaDueAt: string | null;
  slaState: SlaState;
  /** Minutes from creation to the first agent reply. */
  firstResponseMinutes: number | null;
  /** Minutes from creation to resolution. */
  resolutionMinutes: number | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  rating: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SupportTicketDeskDetail extends SupportTicketDeskRow {
  description: string;
  adminNotes: string | null;
  ratingComment: string | null;
  messages: SupportMessageRow[];
  /** Other tickets from the same shopper. */
  customerHistory: { id: string; reference: string; subject: string; status: DeskStatus; createdAt: string }[];
}

export interface SupportDeskPage {
  rows: SupportTicketDeskRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SupportAgent {
  id: string;
  name: string | null;
  email: string | null;
  openTickets: number;
  resolvedTickets: number;
  /** Median first response across their answered tickets, in minutes. */
  medianResponseMinutes: number | null;
}

export interface SupportDeskSummary {
  kpis: {
    total: number;
    totalChangePercent: number | null;
    open: number;
    inProgress: number;
    pendingCustomer: number;
    resolved: number;
    slaMetPercent: number;
    avgResolutionMinutes: number | null;
  };
  byStatus: { key: DeskStatus; label: string; count: number; share: number }[];
  byChannel: { key: SupportChannelValue; label: string; count: number; share: number }[];
  byCategory: { key: string; label: string; count: number; share: number }[];
  sla: { met: number; breached: number; inFlight: number; metPercent: number };
  /** Tickets created and resolved per day. */
  trend: { date: string; created: number; resolved: number }[];
  satisfaction: {
    average: number | null;
    ratedCount: number;
    distribution: { stars: number; count: number; share: number }[];
  };
  agents: SupportAgent[];
  recentFeedback: {
    id: string;
    reference: string;
    customerName: string | null;
    rating: number;
    comment: string | null;
    channel: SupportChannelValue;
    createdAt: string;
  }[];
}

export const deskReplySchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(4000),
  attachments: z.array(z.string().url()).max(5).default([]),
  /** Internal notes stay on the desk and never reach the shopper. */
  isInternal: z.boolean().default(false),
});
export type DeskReplyInput = z.infer<typeof deskReplySchema>;

export const deskUpdateSchema = z.object({
  status: z.enum(DESK_STATUSES).optional(),
  priority: z.enum(DESK_PRIORITIES).optional(),
  category: z.enum(COMPLAINT_CATEGORIES).optional(),
  /** Empty string unassigns. */
  assignedToId: z.string().optional(),
  adminNotes: z.string().trim().max(1000).optional(),
});
export type DeskUpdateInput = z.infer<typeof deskUpdateSchema>;

export const deskBulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Select at least one ticket').max(100),
  action: z.enum(['ASSIGN', 'STATUS', 'PRIORITY']),
  assignedToId: z.string().optional(),
  status: z.enum(DESK_STATUSES).optional(),
  priority: z.enum(DESK_PRIORITIES).optional(),
});
export type DeskBulkInput = z.infer<typeof deskBulkSchema>;

/** What the shopper sends back on their own ticket. */
export const customerReplySchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(4000),
});
export type CustomerReplyInput = z.infer<typeof customerReplySchema>;

export const customerRatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(300).optional(),
});
export type CustomerRatingInput = z.infer<typeof customerRatingSchema>;
