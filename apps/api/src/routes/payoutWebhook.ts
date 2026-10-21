import { createHash } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env';
import { ApiError } from '../utils/ApiError';
import { cashfreeWebhookFresh, verifyCashfreeWebhook } from '../services/cashfree/client';
import { payoutProvider } from '../services/payouts';
import { payoutByTransferId, syncPayout } from '../services/payoutService';
import { recordWebhook, webhookSeen } from '../services/payments/gatewaySync';

/**
 * Cashfree Payouts webhooks (v2): TRANSFER_SUCCESS, TRANSFER_FAILED,
 * TRANSFER_REVERSED, TRANSFER_REJECTED, … Signed with the payouts client
 * secret over timestamp + raw body. As with payments, the body only says
 * which transfer to look at; the state comes from asking Cashfree, so a
 * replay or an out-of-order delivery changes nothing.
 */
export const payoutWebhookRouter = Router();

payoutWebhookRouter.post('/cashfree/webhook', async (req, res, next) => {
  try {
    const secret = env.CASHFREE_PAYOUT_CLIENT_SECRET;
    if (!secret || payoutProvider.name !== 'cashfree') return res.status(200).json({ received: true });

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.get('x-webhook-signature') ?? '';
    const timestamp = req.get('x-webhook-timestamp') ?? '';
    if (!rawBody || !verifyCashfreeWebhook(rawBody, timestamp, signature, secret)) {
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    if (!cashfreeWebhookFresh(timestamp)) throw ApiError.unauthorized('Stale webhook');
    const body = req.body as { type?: unknown; event?: unknown; data?: Record<string, unknown> };
    const type = typeof body.type === 'string' ? body.type : typeof body.event === 'string' ? body.event : 'UNKNOWN';
    // Recognised by the signed body, not the unsigned x-idempotency-key (a
    // replay under a new key would otherwise pass as a new event). Keys
    // recorded before this change are still honoured.
    const eventKey = createHash('sha256').update(rawBody).digest('hex');
    const legacyKey = req.get('x-idempotency-key');
    if ((await webhookSeen('cashfree-payouts', eventKey)) || (legacyKey && (await webhookSeen('cashfree-payouts', legacyKey)))) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    const data = body.data ?? {};
    const transfer = (data.transfer && typeof data.transfer === 'object' ? data.transfer : data) as Record<string, unknown>;
    const transferId = typeof transfer.transfer_id === 'string' ? transfer.transfer_id : null;
    if (transferId && type.startsWith('TRANSFER_')) {
      const payoutId = await payoutByTransferId(transferId);
      if (payoutId) await syncPayout(payoutId);
    }
    await recordWebhook('cashfree-payouts', eventKey, type, transferId);
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});
