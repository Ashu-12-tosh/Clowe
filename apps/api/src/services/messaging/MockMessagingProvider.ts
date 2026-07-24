import type { MessagingProvider, OutboundMessage } from './MessagingProvider';

const ICONS = { whatsapp: '🟢 WhatsApp', sms: '✉️ SMS', email: '📧 Email' } as const;

/** Dev provider: prints the message to the API console instead of sending. */
export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'mock';

  async send(message: OutboundMessage): Promise<void> {
    console.log(`\n[clowe-api] ===== MOCK ${ICONS[message.channel]} =====`);
    console.log(`[clowe-api] To: ${message.to}`);
    if (message.subject) console.log(`[clowe-api] Subject: ${message.subject}`);
    console.log(`[clowe-api] ${message.body}`);
    console.log(`[clowe-api] ==============================\n`);
  }
}
