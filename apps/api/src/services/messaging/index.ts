import { env } from '../../env';
import type { MessagingProvider, OutboundMessage } from './MessagingProvider';
import { MockMessagingProvider } from './MockMessagingProvider';

function createMessagingProvider(): MessagingProvider {
  switch (env.MESSAGING_PROVIDER) {
    case 'mock':
    default:
      return new MockMessagingProvider();
    // case 'msg91': ...   // production SMS/WhatsApp
    // case 'gupshup': ... // production WhatsApp Business
  }
}

export const messagingProvider = createMessagingProvider();

/** Fire-and-forget send — never lets a messaging failure break the main flow. */
export function sendMessageSafe(message: OutboundMessage): void {
  messagingProvider.send(message).catch((err) => {
    console.error('[clowe-api] messaging send failed:', err);
  });
}
