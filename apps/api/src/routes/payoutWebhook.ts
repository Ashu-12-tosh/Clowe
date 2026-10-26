import { createHash } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env';
import { ApiError } from '../utils/ApiError';
import { cashfreeWebhookFresh, verifyCashfreeWebhook } from '../services/cashfree/client';
import { payoutProvider } from '../services/payouts';
import { payoutByTransferId, syncPayout } from '../services/payoutService';
import { recordWebhook, webhookSeen } from '../services/payments/gatewaySync';

/**
 * Cashfree Payouts webhooks — version V2 (JSON): TRANSFER_SUCCESS,
 * TRANSFER_FAILED, TRANSFER_REVERSED, TRANSFER_REJECTED, … Signed with the
 * payouts client secret over x-webhook-timestamp + raw body. (V1 posts a form
 * with the signature inside it; it is refused here as unsigned.) As with
 * payments, the body only says which transfer to look at; the state comes
 * from asking Cashfree, so a replay or an out-of-order delivery changes
 * nothing.
 *
 * The signature is checked whenever the payouts secret is set — also while
 * PAYOUT_PROVIDER is still the mock, so the dashboard's "Test & Add Webhook"
 * proves the secret and the endpoint before any money moves. Until then a
 * verified event is recorded and logged, and acts on nothing.
 */
export const payoutWebhookRouter = Router();

payoutWebhookRouter.post('/cashfree/webhook', async (req, res, next) => {
  try {
    const secret = env.CASHFREE_PAYOUT_CLIENT_SECRET;
    if (!secret) return res.status(200).json({ received: true });

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.get('x-webhook-signature') ?? '';
    const timestamp = req.get('x-webhook-timestamp') ?? '';
    if (!rawBody || !verifyCashfreeWebhook(rawBody, timestamp, signature, secret)) {
      console.warn(`[clowe-api] payout webhook: signature check FAILED (${signature ? 'signature did not match' : 'no signature header'}) — refused`);
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    if (!cashfreeWebhookFresh(timestamp)) {
      console.warn('[clowe-api] payout webhook: signature ok but the timestamp is outside the allowed window — refused');
      throw ApiError.unauthorized('Stale webhook');
    }
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
    const live = payoutProvider.name === 'cashfree';
    const payoutId = transferId && type.startsWith('TRANSFER_') ? await payoutByTransferId(transferId) : null;
    if (live && payoutId) await syncPayout(payoutId);
    await recordWebhook('cashfree-payouts', eventKey, type, transferId);
    console.log(
      `[clowe-api] payout webhook: ${type.slice(0, 40)} — signature ok; ${
        !live ? 'recorded only (PAYOUT_PROVIDER is not cashfree)' : payoutId ? 'payout checked with Cashfree' : 'no payout of ours'
      }`,
    );
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});
