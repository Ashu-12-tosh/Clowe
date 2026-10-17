import type { Prisma } from '@prisma/client';
import type { CourierWalletAlert } from '@clowe/shared';
import { prisma } from '../../db';
import { env } from '../../env';
import { enqueueEmail } from '../email';

// ---------------------------------------------------------------------------
// Delhivery refused a booking because of Clowe's wallet.
//
// Bookings are paid from Clowe's prepaid Delhivery wallet: under ₹500, or
// locked after going too far negative ("Finlock"), Delhivery refuses every
// booking. Delhivery has no API to read the balance, so the refusal is the
// signal: admins see a banner on every admin page until one marks it
// resolved, are told in the app, and support@ gets an email — at most one
// every six hours while it lasts.
// ---------------------------------------------------------------------------

const KEY = 'courier.walletAlert';
const EMAIL_EVERY_MS = 6 * 60 * 60_000;

/** Delhivery's words for a wallet problem: low balance, a negative balance, or a lock. */
export function isWalletRefusal(message: string): boolean {
  return /wallet|insufficient|low balance|balance (is )?(low|insufficient|negative)|recharge|fin ?lock/i.test(message);
}

interface Stored {
  message: string;
  firstAt: string;
  lastAt: string;
  count: number;
  context: string | null;
  emailedAt: string | null;
}

async function read(): Promise<Stored | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: KEY } });
  const v = row?.value as Partial<Stored> | null | undefined;
  return v && typeof v.message === 'string' && typeof v.lastAt === 'string' ? (v as Stored) : null;
}

/** What the admin banner shows; null when there is nothing to fix. */
export async function walletAlertView(): Promise<CourierWalletAlert | null> {
  const s = await read();
  return s ? { message: s.message, firstAt: s.firstAt, lastAt: s.lastAt, count: s.count, context: s.context } : null;
}

/** Record a wallet refusal: the banner, an in-app note for admins (new alerts only) and an email to support@. */
export async function raiseWalletAlert(message: string, context: string | null, now: Date = new Date()): Promise<void> {
  const before = await read();
  const emailDue = !before?.emailedAt || now.getTime() - new Date(before.emailedAt).getTime() >= EMAIL_EVERY_MS;
  const next: Stored = {
    message,
    firstAt: before?.firstAt ?? now.toISOString(),
    lastAt: now.toISOString(),
    count: (before?.count ?? 0) + 1,
    context,
    emailedAt: emailDue ? now.toISOString() : (before?.emailedAt ?? null),
  };
  await prisma.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue },
  });

  const recharge =
    'Recharge the wallet in Delhivery One → Finances → Wallet → Recharge Wallet, and keep at least ₹500 in it. If the wallet is locked (negative beyond its limit), recharge enough to bring it back above zero. Then mark the alert resolved on the admin dashboard.';
  if (!before) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: 'COURIER_WALLET',
        title: 'Delhivery is refusing bookings: recharge the wallet',
        body: `Delhivery said: ${message}${context ? ` (${context})` : ''}. ${recharge}`,
        linkHref: '/admin/shipments',
      })),
    });
  }
  if (emailDue) {
    await enqueueEmail({
      to: env.MAIL_REPLY_TO,
      kind: 'COURIER_WALLET_ALERT',
      dedupeKey: `courier-wallet:${Math.floor(now.getTime() / EMAIL_EVERY_MS)}`,
      title: 'Delhivery is refusing bookings: recharge the wallet',
      body: `Delhivery refused a booking because of the Clowe wallet.\n\nDelhivery said: ${message}${context ? `\nBooking: ${context}` : ''}\nRefusals so far: ${next.count}, since ${new Date(next.firstAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (India time).\n\n${recharge}`,
      ctaHref: '/admin/shipments',
      ctaLabel: 'Open shipments',
    }).catch((err) => console.error('[clowe-api] wallet alert email not queued:', err instanceof Error ? err.message : err));
  }
}

/** An admin recharged the wallet: the banner goes until the next refusal. */
export async function clearWalletAlert(): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: KEY } });
}

/** Never let the alert get in the way of telling the seller why the booking failed. */
export function raiseWalletAlertIfWallet(message: string, context: string | null): Promise<void> {
  if (!isWalletRefusal(message)) return Promise.resolve();
  return raiseWalletAlert(message, context).catch((err) =>
    console.error('[clowe-api] wallet alert not recorded:', err instanceof Error ? err.message : err),
  );
}
