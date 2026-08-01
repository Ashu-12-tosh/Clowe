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

/**
 * Preference-aware send. Non-critical messages respect the user's channel
 * preferences; critical ones (OTP, order/payment/shipping updates) always go.
 */
export function sendToUserSafe(
  userId: string,
  message: OutboundMessage,
  options: { critical?: boolean } = {},
): void {
  if (options.critical) {
    sendMessageSafe(message);
    return;
  }
  void (async () => {
    const { prisma } = await import('../../db');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notifyEmail: true, notifySms: true, notifyWhatsapp: true },
    });
    const allowed =
      message.channel === 'email'
        ? user?.notifyEmail
        : message.channel === 'sms'
          ? user?.notifySms
          : user?.notifyWhatsapp;
    if (allowed) sendMessageSafe(message);
    else console.log(`[clowe-api] skipped ${message.channel} to ${message.to} (user preference)`);
  })().catch((err) => console.error('[clowe-api] preference check failed:', err));
}
