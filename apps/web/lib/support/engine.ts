/**
 * Support chat engines. The widget only talks to the ChatEngine interface,
 * so a future AIEngine (LLM-powered, e.g. for 'Talk about something else' or
 * unmatched queries) can be swapped in without touching the widget or the
 * complaint system.
 */
import type {
  ComplaintCategory,
  ComplaintRow,
  OrderDetailView,
  OrderListRow,
} from '@clowe/shared';
import { COMPLAINT_CATEGORY_LABELS } from '@clowe/shared';
import { api, getStoredUser } from '@/lib/api';
import { FAQ_ENTRIES, FALLBACK_MESSAGE, GREETING, MAIN_MENU } from './faq-content';

export interface Chip {
  id: string;
  label: string;
}
export interface BotLink {
  label: string;
  href: string;
}
export interface BotMessage {
  text: string;
  links?: BotLink[];
  chips?: Chip[];
}
export interface BotReply {
  messages: BotMessage[];
}

export interface ChatEngine {
  start(): Promise<BotReply>;
  handleChip(id: string): Promise<BotReply>;
  handleText(text: string): Promise<BotReply>;
}

// ---------------------------------------------------------------------------
// Rule-based engine (menu-driven + keyword matching; no AI calls)
// ---------------------------------------------------------------------------

const MENU_CHIPS: Chip[] = MAIN_MENU.map((m) => ({ id: m.id, label: m.label }));
const BACK_CHIP: Chip = { id: 'menu', label: '🏠 Back to menu' };
const COMPLAINT_CHIP: Chip = { id: 'complaint', label: '📢 Raise a complaint' };
const HELPED_CHIP: Chip = { id: 'helped', label: '👍 Yes, that helped' };

const CHIP_LABELS: Record<string, string> = {
  menu: BACK_CHIP.label,
  complaint: COMPLAINT_CHIP.label,
  helped: HELPED_CHIP.label,
  'order-status': '📦 Where is my order?',
  'return-cancel': '↩️ Return / Cancel an order',
};

function chipFor(id: string): Chip {
  const faq = FAQ_ENTRIES.find((f) => f.id === id);
  if (faq) return { id: faq.id, label: faq.label };
  return { id, label: CHIP_LABELS[id] ?? id };
}

const STATUS_EMOJI: Record<string, string> = {
  PLACED: '🕐',
  CONFIRMED: '✅',
  SHIPPED: '🚚',
  DELIVERED: '📦',
  CANCELLED: '❌',
  RETURN_REQUESTED: '↩️',
  RETURNED: '↩️',
};

interface ComplaintDraft {
  stage: 'category' | 'order' | 'description';
  category?: ComplaintCategory;
  orderId?: string;
}

export class RuleBasedEngine implements ChatEngine {
  private complaintDraft: ComplaintDraft | null = null;

  async start(): Promise<BotReply> {
    return { messages: [{ text: GREETING, chips: MENU_CHIPS }] };
  }

  async handleChip(id: string): Promise<BotReply> {
    // Complaint sub-flow chips
    if (id.startsWith('ccat:')) return this.complaintPickCategory(id.slice(5) as ComplaintCategory);
    if (id.startsWith('corder:')) return this.complaintPickOrder(id.slice(7));
    if (id.startsWith('order:')) return this.orderStatus(id.slice(6));

    switch (id) {
      case 'menu':
        this.complaintDraft = null;
        return { messages: [{ text: 'What would you like help with?', chips: MENU_CHIPS }] };
      case 'helped':
        this.complaintDraft = null;
        return {
          messages: [
            { text: 'Glad I could help! 😊 Anything else?', chips: MENU_CHIPS },
          ],
        };
      case 'order-status':
        return this.listOrders('status');
      case 'return-cancel':
        return this.listOrders('return');
      case 'complaint':
        return this.startComplaint();
      case 'cancel-complaint':
        this.complaintDraft = null;
        return { messages: [{ text: 'No problem — complaint cancelled.', chips: MENU_CHIPS }] };
      case 'else':
        return {
          messages: [
            {
              text: 'Right now I can help with the topics in the menu. Our smart AI assistant is coming soon for everything else!\n\nIf something specific is bothering you, raising a complaint is the fastest way to reach our team.',
              chips: [COMPLAINT_CHIP, BACK_CHIP],
            },
          ],
        };
    }

    const faq = FAQ_ENTRIES.find((f) => f.id === id);
    if (faq) {
      return {
        messages: [
          {
            text: faq.answer.replace(/\s*\/\* TODO:[^*]*\*\//g, ''),
            links: faq.links,
            chips: faq.followUps.map(chipFor),
          },
        ],
      };
    }
    return this.fallback();
  }

  async handleText(text: string): Promise<BotReply> {
    // Mid-complaint: free text is the description.
    if (this.complaintDraft?.stage === 'description') {
      return this.submitComplaint(text);
    }

    const lower = text.toLowerCase();

    // Intent keywords for the interactive flows.
    if (/(where|track|status|kaha|kab).*(order|parcel|item)|^track/.test(lower) || lower.includes('tracking')) {
      return this.listOrders('status');
    }
    if (/cancel|return kar|wapas|exchange/.test(lower)) {
      return this.listOrders('return');
    }
    if (/complaint|complain|shikayat|issue|problem/.test(lower)) {
      return this.startComplaint();
    }

    // FAQ keyword match — best score wins.
    let best: { id: string; score: number } | null = null;
    for (const faq of FAQ_ENTRIES) {
      const score = faq.keywords.filter((k) => lower.includes(k)).length;
      if (score > 0 && (!best || score > best.score)) best = { id: faq.id, score };
    }
    if (best) return this.handleChip(best.id);

    return this.fallback();
  }

  private fallback(): BotReply {
    return { messages: [{ text: FALLBACK_MESSAGE, chips: MENU_CHIPS }] };
  }

  // ---------------- Orders (live data from our own API) ----------------

  private async fetchOrders(): Promise<OrderListRow[] | null> {
    if (!getStoredUser()) return null;
    try {
      return await api<OrderListRow[]>('/api/orders', { auth: true });
    } catch {
      return [];
    }
  }

  private async listOrders(purpose: 'status' | 'return'): Promise<BotReply> {
    const orders = await this.fetchOrders();
    if (orders === null) {
      return {
        messages: [
          {
            text: 'Please log in first so I can look up your orders securely.',
            links: [{ label: 'Login', href: '/login' }],
            chips: [BACK_CHIP],
          },
        ],
      };
    }
    if (orders.length === 0) {
      return {
        messages: [
          {
            text: "You don't have any orders yet. Once you place one, I can track it for you!",
            links: [{ label: 'Start shopping', href: '/products' }],
            chips: [BACK_CHIP],
          },
        ],
      };
    }
    const recent = orders.slice(0, 5);
    const text =
      purpose === 'status'
        ? 'Here are your recent orders — tap one to see its live status:'
        : 'Pick the order you want to return or cancel:\n\n• Cancel: possible until the item ships\n• Return: possible after delivery';
    return {
      messages: [
        {
          text,
          chips: [
            ...recent.map((o) => ({
              id: `order:${o.id}`,
              label: `${o.orderNumber} · ${STATUS_EMOJI[o.status] ?? ''} ${o.status.replace('_', ' ')}`,
            })),
            BACK_CHIP,
          ],
        },
      ],
    };
  }

  private async orderStatus(orderId: string): Promise<BotReply> {
    try {
      const order = await api<OrderDetailView>(`/api/orders/${orderId}`, { auth: true });
      const lines = order.items.map(
        (i) =>
          `${STATUS_EMOJI[i.status] ?? '•'} ${i.title} — ${i.status.replace('_', ' ')}${
            i.courierName ? ` (${i.courierName}, AWB ${i.awbNumber})` : ''
          }`,
      );
      const hints: string[] = [];
      if (order.canCancel) hints.push('You can cancel this order from its page.');
      if (order.items.some((i) => i.status === 'DELIVERED' && !i.returnStatus))
        hints.push('Delivered items can be returned from the order page.');
      return {
        messages: [
          {
            text: `Order ${order.orderNumber}:\n\n${lines.join('\n')}${hints.length ? `\n\n${hints.join(' ')}` : ''}`,
            links: [{ label: 'Open order page', href: `/orders/${order.id}` }],
            chips: [chipFor('order-status'), COMPLAINT_CHIP, BACK_CHIP],
          },
        ],
      };
    } catch {
      return this.fallback();
    }
  }

  // ---------------- Complaint flow ----------------

  private startComplaint(): BotReply {
    if (!getStoredUser()) {
      return {
        messages: [
          {
            text: 'To raise a complaint, please log in first — so we can link it to your account and keep you updated.',
            links: [{ label: 'Login', href: '/login' }],
            chips: [BACK_CHIP],
          },
        ],
      };
    }
    this.complaintDraft = { stage: 'category' };
    return {
      messages: [
        {
          text: "I'm sorry you're facing an issue. What is it about?",
          chips: [
            ...(Object.entries(COMPLAINT_CATEGORY_LABELS) as [ComplaintCategory, string][]).map(
              ([id, label]) => ({ id: `ccat:${id}`, label }),
            ),
            { id: 'cancel-complaint', label: '✕ Never mind' },
          ],
        },
      ],
    };
  }

  private async complaintPickCategory(category: ComplaintCategory): Promise<BotReply> {
    this.complaintDraft = { stage: 'category', category };

    // Order-related categories: offer to link an order.
    if (category === 'ORDER' || category === 'PAYMENT' || category === 'DELIVERY' || category === 'PRODUCT_QUALITY') {
      const orders = await this.fetchOrders();
      if (orders && orders.length > 0) {
        this.complaintDraft.stage = 'order';
        return {
          messages: [
            {
              text: 'Which order is this about? (You can also skip.)',
              chips: [
                ...orders.slice(0, 5).map((o) => ({
                  id: `corder:${o.id}`,
                  label: `${o.orderNumber} · ${o.status.replace('_', ' ')}`,
                })),
                { id: 'corder:skip', label: 'Skip — not about a specific order' },
                { id: 'cancel-complaint', label: '✕ Never mind' },
              ],
            },
          ],
        };
      }
    }
    this.complaintDraft.stage = 'description';
    return this.askDescription();
  }

  private complaintPickOrder(orderId: string): BotReply {
    if (!this.complaintDraft) return this.fallback();
    if (orderId !== 'skip') this.complaintDraft.orderId = orderId;
    this.complaintDraft.stage = 'description';
    return this.askDescription();
  }

  private askDescription(): BotReply {
    return {
      messages: [
        {
          text: 'Please describe the issue briefly (type below and press send):',
          chips: [{ id: 'cancel-complaint', label: '✕ Never mind' }],
        },
      ],
    };
  }

  private async submitComplaint(description: string): Promise<BotReply> {
    const draft = this.complaintDraft!;
    if (description.trim().length < 10) {
      return {
        messages: [
          {
            text: 'Could you add a little more detail (at least 10 characters)? It helps our team resolve it faster.',
            chips: [{ id: 'cancel-complaint', label: '✕ Never mind' }],
          },
        ],
      };
    }
    try {
      const complaint = await api<ComplaintRow>('/api/complaints', {
        body: {
          category: draft.category!,
          description: description.trim(),
          orderId: draft.orderId,
        },
        auth: true,
      });
      this.complaintDraft = null;
      return {
        messages: [
          {
            text: `✅ Your complaint ${complaint.complaintId} has been registered${
              complaint.orderNumber ? ` (order ${complaint.orderNumber})` : ''
            }.\n\nOur team will get back to you. You can check its status anytime under "My Complaints" in your account.`,
            links: [{ label: 'View my complaints', href: '/complaints' }],
            chips: [BACK_CHIP],
          },
        ],
      };
    } catch {
      return {
        messages: [
          {
            text: 'Sorry, I could not register the complaint right now. Please try again in a moment.',
            chips: [{ id: 'complaint', label: '🔁 Try again' }, BACK_CHIP],
          },
        ],
      };
    }
  }
}
