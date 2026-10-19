/**
 * Provider-agnostic payment gateway interface.
 * Implementations: MockPaymentProvider (dev), RazorpayProvider, CashfreePaymentProvider.
 *
 * The browser never decides that something is paid. Razorpay's checkout
 * returns a signed callback the server checks (verifySignature); Cashfree's
 * returns nothing signed, so the server asks the gateway (fetchOrder) — and
 * every webhook is handled the same way, as a prompt to ask.
 */
export type GatewayName = 'mock' | 'razorpay' | 'cashfree';

export interface GatewayCustomer {
  /** Our user id: letters and digits. */
  id: string;
  /** 10 digits. */
  phone: string;
  name?: string | null;
  email?: string | null;
}

/** One seller's share sent with the gateway order (Easy Split). */
export interface GatewaySplit {
  vendorId: string;
  amountPaise: number;
}

export interface CreateGatewayOrderInput {
  amountPaise: number;
  /** Our reference for the order at the gateway, unique per create: the order number, CREDITS-…, PROMO-…. */
  receipt: string;
  customer: GatewayCustomer;
  /** Where the browser comes back to after paying (Cashfree redirect flows). */
  returnUrl?: string;
  /** Server-to-server notification URL (Cashfree). */
  notifyUrl?: string;
  /** When the gateway order stops accepting payment. */
  expiresAt?: Date;
  splits?: GatewaySplit[];
  note?: string;
}

export interface GatewayOrder {
  /** What the gateway calls the order — the id every later call uses. */
  providerOrderId: string;
  /** Cashfree: what the browser checkout is opened with. */
  paymentSessionId?: string;
  expiresAt?: Date;
}

/** One payment attempt on a gateway order. */
export interface GatewayPaymentAttempt {
  providerPaymentId: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED' | 'USER_DROPPED' | 'CANCELLED' | 'VOID' | 'NOT_ATTEMPTED' | 'OTHER';
  amountPaise: number;
  currency: string;
  message?: string;
  at?: Date;
}

/** The gateway's current answer about an order: the source of truth. */
export interface GatewayOrderState {
  /** PAID: one successful payment. ACTIVE: still payable. EXPIRED/TERMINATED: can never be paid. */
  status: 'PAID' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
  amountPaise: number;
  currency: string;
  /** Newest first. */
  attempts: GatewayPaymentAttempt[];
}

export interface GatewayRefundInput {
  providerOrderId: string;
  providerPaymentId: string;
  /** Our refund id: sent as the gateway's refund id, so a retry is the same refund. */
  refundId: string;
  amountPaise: number;
  note?: string;
  /** Easy Split: how much of the refund each vendor's share gives back. */
  splits?: GatewaySplit[];
}

/** SUCCESS: money on its way to the buyer. PENDING: accepted, final later. FAILED: will not happen. */
export interface GatewayRefund {
  providerRefundId: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  /** The gateway's own word for it (Cashfree: PENDING, ONHOLD, …). */
  providerStatus: string;
  /** Bank reference for the credit, once known. */
  arn?: string | null;
  message?: string | null;
}

export interface PaymentProvider {
  readonly name: GatewayName;
  /** Public key id for frontend checkout widgets (Razorpay); undefined otherwise. */
  readonly publicKeyId?: string;
  /** Cashfree: which checkout the browser opens. */
  readonly mode?: 'sandbox' | 'production';
  /** Create a gateway-side order. */
  createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder>;
  /** Verify a client-side payment callback signature (Razorpay). Others return false. */
  verifySignature(providerOrderId: string, paymentId: string, signature: string): boolean;
  /** The gateway's current state of an order; undefined for providers that cannot be asked. */
  fetchOrder?(providerOrderId: string): Promise<GatewayOrderState>;
  /** Stop an unpaid order from taking payment (Cashfree). Returns false if the gateway refused (e.g. a payment is in flight). */
  terminateOrder?(providerOrderId: string): Promise<boolean>;
  /** Refund (part of) a captured payment. */
  refund(input: GatewayRefundInput): Promise<GatewayRefund>;
  /** The current state of a refund made earlier (Cashfree); null if the gateway has no such refund. */
  fetchRefund?(providerOrderId: string, refundId: string): Promise<GatewayRefund | null>;
}

/** No answer from the gateway — the caller decides whether to ask again. */
export class GatewayError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    readonly code: string = '',
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /** Timed out, unreachable or a 5xx: the request may or may not have taken effect. */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}
