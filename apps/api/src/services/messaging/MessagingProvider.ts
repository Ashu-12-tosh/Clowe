export type MessageChannel = 'whatsapp' | 'sms' | 'email';

export interface OutboundMessage {
  channel: MessageChannel;
  /** Phone (whatsapp/sms) or email address. */
  to: string;
  /** Email subject; ignored for whatsapp/sms. */
  subject?: string;
  body: string;
}

/**
 * Provider-agnostic outbound messaging (order confirmations, shipping updates).
 * Mock logs to the console in dev; WhatsApp Business/MSG91/SES slot in later.
 * Sends are fire-and-forget: failures are logged, never break the main flow.
 */
export interface MessagingProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<void>;
}
