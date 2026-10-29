import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../env';
import { ApiError } from '../utils/ApiError';
import { cashfreeWebhookFresh, verifyCashfreeWebhook } from '../services/cashfree/client';
import { payoutProvider } from '../services/payouts';
import { TEST_EVENT_TYPE, testWindowClosesAt } from '../services/payouts/webhookTestWindow';
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

/** The fields a Cashfree event names itself in (V2 uses "type"). */
const EVENT_FIELDS = ['type', 'event', 'event_type'] as const;
/** What an event name looks like; anything else is never printed. */
const EVENT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The event name a body carries, and the field it is in, or null. */
function eventNameOf(body: unknown): { field: string; name: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const field of EVENT_FIELDS) {
    const v = (body as Record<string, unknown>)[field];
    if (typeof v === 'string') return { field, name: v };
  }
  return null;
}

/**
 * A refused delivery is logged at most once a minute (anyone can post here),
 * with what it carried: the header NAMES, the content type, the body size, the
 * body's top-level key NAMES and its event name — never a header value or any
 * other part of the body, which hold the signature and the payload.
 */
let lastRefusalLog = 0;
let refusedSince = 0;
function logRefusal(why: string, req: Request): void {
  refusedSince += 1;
  if (Date.now() - lastRefusalLog < 60_000) return;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const names = Object.keys(req.headers).sort().join(',');
  const contentType = (req.get('content-type') ?? '').split(';')[0]!.trim().slice(0, 60) || 'none';
  const body = req.body as unknown;
  const keys =
    body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body)
          .filter((k) => EVENT_NAME.test(k))
          .sort()
          .slice(0, 20)
          .join(',') || 'none'
      : Array.isArray(body)
        ? 'an array'
        : 'not an object';
  const event = eventNameOf(body);
  const eventText = event ? (EVENT_NAME.test(event.name) ? `${event.field}=${event.name}` : `${event.field}=(not an event name)`) : 'none';
  console.warn(
    `[clowe-api] payout webhook: ${why} — refused${refusedSince > 1 ? ` (${refusedSince} refused in the last minute or so)` : ''}` +
      ` [headers: ${names}; content-type: ${contentType}; raw body: ${rawBody ? `${rawBody.length} bytes` : 'not captured'}; body keys: ${keys}; event: ${eventText}]`,
  );
  lastRefusalLog = Date.now();
  refusedSince = 0;
}

/** Why a delivery failed the signature check, in our words. */
function refusalReason(rawBody: Buffer | undefined, signature: string, timestamp: string): string {
  if (!signature) return 'no signature header';
  if (!timestamp) return 'no timestamp header';
  if (!rawBody) return 'body not captured (not JSON?)';
  return 'signature did not match';
}

payoutWebhookRouter.post('/cashfree/webhook', async (req, res, next) => {
  try {
    const secret = env.CASHFREE_PAYOUT_CLIENT_SECRET;
    if (!secret) return res.status(200).json({ received: true });

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.get('x-webhook-signature') ?? '';
    const timestamp = req.get('x-webhook-timestamp') ?? '';
    // The dashboard's unsigned test event, inside the owner's short window
    // only: answered 200, recorded nowhere, acted on never (webhookTestWindow.ts).
    // Its name may sit in "type", "event" or "event_type"; only this one name passes.
    if (!signature && !timestamp && rawBody && eventNameOf(req.body)?.name === TEST_EVENT_TYPE) {
      const closes = testWindowClosesAt();
      if (closes) {
        console.warn(`[clowe-api] payout webhook: unsigned ${TEST_EVENT_TYPE} (the dashboard test) answered 200 inside the test window (closes ${closes.toISOString()}) — not recorded, not acted on`);
        return res.status(200).json({ received: true });
      }
    }
    if (!rawBody || !verifyCashfreeWebhook(rawBody, timestamp, signature, secret)) {
      logRefusal(`signature check FAILED (${refusalReason(rawBody, signature, timestamp)})`, req);
      throw ApiError.unauthorized('Invalid webhook signature');
    }
    if (!cashfreeWebhookFresh(timestamp)) {
      logRefusal('signature ok but the timestamp is outside the allowed window', req);
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
