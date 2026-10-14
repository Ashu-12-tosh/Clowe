import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env';
import { parseDelhiveryShipment } from '../services/shipping/DelhiveryShippingProvider';
import { applyTracking } from '../services/shipping/tracking';

// ---------------------------------------------------------------------------
// POST /api/webhooks/delhivery — Delhivery pushes each scan here.
//
// Authenticated by the secret we give Delhivery (DELHIVERY_WEBHOOK_TOKEN), as
// a bearer token or a token parameter, compared in constant time. The body is
// one shipment or a list of them, shaped as in Delhivery's tracking API.
// Answered 200 once stored, so Delhivery doesn't retry what we have; a scan
// for an AWB we don't know is acknowledged and ignored.
// ---------------------------------------------------------------------------

export const courierWebhookRouter = Router();

function authorised(header: string | undefined, query: unknown): boolean {
  const secret = env.DELHIVERY_WEBHOOK_TOKEN;
  if (!secret) return false;
  const given = header?.replace(/^(Bearer|Token)\s+/i, '') ?? (typeof query === 'string' ? query : '');
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

courierWebhookRouter.post('/delhivery', async (req, res, next) => {
  try {
    if (!env.DELHIVERY_WEBHOOK_TOKEN) {
      res.status(503).json({ success: false, error: { code: 'WEBHOOK_OFF', message: 'Courier webhook is not configured' } });
      return;
    }
    if (!authorised(req.get('authorization'), req.query.token)) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORISED', message: 'Bad webhook token' } });
      return;
    }
    const body = req.body as Record<string, unknown> | unknown[];
    const entries = Array.isArray(body)
      ? body
      : Array.isArray((body as { ShipmentData?: unknown[] }).ShipmentData)
        ? (body as { ShipmentData: unknown[] }).ShipmentData
        : [body];
    let applied = 0;
    for (const entry of entries) {
      const shipment = parseDelhiveryShipment((entry as { Shipment?: unknown }).Shipment ?? entry);
      if (!shipment) continue;
      const result = await applyTracking(shipment, 'WEBHOOK');
      if (result.known) applied += 1;
    }
    res.json({ success: true, data: { received: entries.length, applied } });
  } catch (err) {
    next(err);
  }
});
