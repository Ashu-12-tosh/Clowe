import { env } from '../../env';

/**
 * The Payouts dashboard's "Test & Add Webhook" sends its test event
 * (LOW_BALANCE_ALERT) with no signature at all, so it can never pass the
 * signature check — and the dashboard will not add a webhook whose test fails.
 *
 * PAYOUT_WEBHOOK_TEST_UNTIL opens a short window for that one click. Inside
 * it, and only for a request carrying no signature headers whose body is that
 * test event, the webhook answers 200 — recording nothing and acting on
 * nothing. Every signed request is still verified, and every transfer event
 * still needs a valid signature, window or not.
 *
 * The window is off unless the setting holds a valid time, and it is capped:
 * it runs from when the API started (setting it means restarting the API) to
 * the setting's time, never more than WINDOW_MAX_MS. Owner-approved 2026-10-27.
 */
export const WINDOW_MAX_MS = 30 * 60 * 1000;
export const TEST_EVENT_TYPE = 'LOW_BALANCE_ALERT';

const startedAt = Date.now();

/** When the window closes, or null when it is not open at `now`. */
export function testWindowClosesAt(now = Date.now(), until = env.PAYOUT_WEBHOOK_TEST_UNTIL, openedAt = startedAt): Date | null {
  if (!until) return null;
  const end = Date.parse(until);
  if (!Number.isFinite(end)) return null;
  const closes = Math.min(end, openedAt + WINDOW_MAX_MS);
  return now >= openedAt && now < closes ? new Date(closes) : null;
}

/** One line for the boot log: whether the window is set, and until when. */
export function testWindowStatus(now = Date.now()): string | null {
  const until = env.PAYOUT_WEBHOOK_TEST_UNTIL;
  if (!until) return null;
  if (!Number.isFinite(Date.parse(until))) return `Payouts webhook test window: PAYOUT_WEBHOOK_TEST_UNTIL is not a valid time — closed`;
  const closes = testWindowClosesAt(now);
  return closes
    ? `Payouts webhook test window: OPEN until ${closes.toISOString()} (an unsigned ${TEST_EVENT_TYPE} gets 200, recorded and acted on nowhere; everything else is verified as always)`
    : `Payouts webhook test window: closed (${until} has passed) — remove PAYOUT_WEBHOOK_TEST_UNTIL`;
}
