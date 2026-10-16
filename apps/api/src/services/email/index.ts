import nodemailer from 'nodemailer';
import { prisma } from '../../db';
import { env } from '../../env';
import { renderEmail, type EmailContent } from './templates';

/**
 * Email from "Clowe <no-reply@cloweshop.com>" through Hostinger SMTP (465, SSL),
 * replies to support@cloweshop.com.
 *
 * Nothing sends inline: every email is a row in email_outbox, and a background
 * job sends them — retrying a failed send with growing gaps, and stopping for
 * the day at EMAIL_DAILY_CAP (India time) so Hostinger's per-mailbox limit is
 * never hit; what is left waits for the next day.
 *
 * Most emails come from the in-app notifications: the bridge below turns the
 * notification types in EMAIL_NOTIFICATIONS into emails for users with an
 * email address. Notifications from before the bridge first ran are never
 * emailed.
 */

export const emailProviderName: 'smtp' | 'mock' =
  env.EMAIL_PROVIDER === 'mock' || env.NODE_ENV === 'test'
    ? 'mock'
    : env.EMAIL_PROVIDER === 'smtp' || env.SMTP_PASSWORD
      ? 'smtp'
      : 'mock';

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** The mock's sent mail, for tests; `mockControl.failFor` makes the next send to that address fail. */
export const mockSent: Mail[] = [];
export const mockControl: { failFor: string | null; loginFails: boolean } = { failFor: null, loginFails: false };

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function smtp() {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 20_000,
    socketTimeout: 30_000,
  });
  return transport;
}

async function deliver(m: Mail): Promise<void> {
  if (emailProviderName === 'mock') {
    if (mockControl.loginFails) throw Object.assign(new Error('Invalid login: 535 5.7.8 Error: authentication failed'), { code: 'EAUTH' });
    if (mockControl.failFor === m.to) {
      mockControl.failFor = null;
      throw new Error('mock SMTP failure');
    }
    mockSent.push(m);
    if (env.NODE_ENV !== 'test') console.log(`[clowe-api] email (mock) to ${m.to}: ${m.subject}`);
    return;
  }
  await smtp().sendMail({ from: env.MAIL_FROM, replyTo: env.MAIL_REPLY_TO, to: m.to, subject: m.subject, html: m.html, text: m.text });
}

export function logEmailProviderStatus(): void {
  console.log(
    emailProviderName === 'smtp'
      ? `[clowe-api] Email: SMTP ${env.SMTP_HOST}:${env.SMTP_PORT} as ${env.SMTP_USER}, cap ${env.EMAIL_DAILY_CAP}/day`
      : '[clowe-api] Email: mock (logged only)',
  );
}

const EMAIL_RX = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** Queue one email. A repeated dedupeKey is ignored, so a source never mails twice. */
export async function enqueueEmail(input: EmailContent & { to: string; kind: string; subject?: string; userId?: string | null; dedupeKey?: string | null }): Promise<boolean> {
  const to = input.to.trim();
  if (!EMAIL_RX.test(to)) return false;
  const { html, text } = renderEmail(input);
  const r = await prisma.emailOutbox.createMany({
    data: [{ dedupeKey: input.dedupeKey ?? null, kind: input.kind, toEmail: to, userId: input.userId ?? null, subject: (input.subject ?? input.title).slice(0, 200), html, text }],
    skipDuplicates: true,
  });
  return r.count > 0;
}

/** Fire-and-forget queueing, for the messaging layer's email channel. */
export function enqueueEmailSafe(input: Parameters<typeof enqueueEmail>[0]): void {
  enqueueEmail(input).catch((err) => console.error('[clowe-api] email queue failed:', err));
}

// --- Sending -----------------------------------------------------------------------------

/** Minutes before each retry; after the last one the email is marked FAILED. */
const RETRY_MINUTES = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

/** Midnight India time at the start of the day of `at`. */
export function istStartOfDay(at: Date): Date {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3_600_000);
}

export async function sentToday(now = new Date()): Promise<number> {
  return prisma.emailOutbox.count({ where: { sentAt: { gte: istStartOfDay(now) } } });
}

/**
 * Hostinger refusing the login (a wrong or changed password, a missing
 * mailbox) is not the email's fault: it does not use up the email's retries.
 * The whole queue waits LOGIN_HOLD_MS and tries again — one login attempt per
 * pause, so the mailbox is never locked out by repeated failures.
 */
const LOGIN_HOLD_MS = 30 * 60_000;
export const loginState: { heldUntil: Date | null; error: string | null } = { heldUntil: null, error: null };
const isLoginError = (err: unknown) => {
  const e = err as { code?: string; responseCode?: number; message?: string };
  return e?.code === 'EAUTH' || e?.responseCode === 535 || /invalid login|authentication failed/i.test(String(e?.message ?? ''));
};

/** Send what is due, within today's cap. Returns how many went out. */
export async function processEmailOutbox(
  now = new Date(),
  batch = 20,
  opts: { ignoreLoginHold?: boolean } = {},
): Promise<{ sent: number; failed: number; held: boolean; loginFailed?: boolean }> {
  if (!opts.ignoreLoginHold && loginState.heldUntil && loginState.heldUntil > now) return { sent: 0, failed: 0, held: true, loginFailed: true };
  // A send cut off mid-way (a restart) is tried again.
  await prisma.emailOutbox.updateMany({ where: { status: 'SENDING', nextAttemptAt: { lt: new Date(now.getTime() - 10 * 60_000) } }, data: { status: 'PENDING' } });
  const room = env.EMAIL_DAILY_CAP - (await sentToday(now));
  if (room <= 0) return { sent: 0, failed: 0, held: true };
  const due = await prisma.emailOutbox.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: Math.min(batch, room),
  });
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const claimed = await prisma.emailOutbox.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'SENDING', nextAttemptAt: now } });
    if (claimed.count === 0) continue;
    try {
      await deliver({ to: row.toEmail, subject: row.subject, html: row.html, text: row.text });
      await prisma.emailOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), attempts: row.attempts + 1, lastError: null } });
      loginState.heldUntil = null;
      loginState.error = null;
      sent += 1;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      if (isLoginError(err)) {
        const until = new Date(now.getTime() + LOGIN_HOLD_MS);
        loginState.heldUntil = until;
        loginState.error = message;
        await prisma.emailOutbox.update({ where: { id: row.id }, data: { status: 'PENDING', lastError: message, nextAttemptAt: until } });
        console.error(`[clowe-api] email: SMTP login refused - the queue waits until ${until.toISOString()}: ${message}`);
        return { sent, failed: failed + 1, held: true, loginFailed: true };
      }
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: {
          status: giveUp ? 'FAILED' : 'PENDING',
          attempts,
          lastError: message,
          nextAttemptAt: giveUp ? now : new Date(now.getTime() + RETRY_MINUTES[attempts - 1]! * 60_000),
        },
      });
      failed += 1;
    }
  }
  return { sent, failed, held: sent >= room };
}

// --- Notifications → email -------------------------------------------------------------------

/**
 * The in-app notifications that also go by email, with the button they get.
 * (Seller application received, fee-change notices, seller notices and
 * complaint updates already send their own email through the messaging layer.)
 */
export const EMAIL_NOTIFICATIONS: Record<string, string> = {
  // Shoppers
  ORDER_CONFIRMED: 'View your order',
  ITEM_SHIPPED: 'Track your order',
  ITEM_DELIVERED: 'View your order',
  ORDER_CANCELLED: 'View your order',
  REFUND_INITIATED: 'View your order',
  REFUND_PROCESSED: 'View your order',
  RETURN_REQUESTED: 'View your return',
  RETURN_APPROVED: 'View your return',
  RETURN_REJECTED: 'View your return',
  RETURN_PICKUP_BOOKED: 'View your return',
  RETURN_PICKUP_FAILED: 'View your return',
  RETURN_RECEIVED: 'View your return',
  RETURN_ARRIVED: 'View the return',
  RETURN_OVERRIDDEN: 'View your return',
  RETURN_SELF_SHIP: 'View your return',
  RETURN_SELF_SHIP_PAID: 'View your return',
  // Sellers
  NEW_ORDER: 'Open your orders',
  SELLER_APPROVED: 'Open your seller dashboard',
  SELLER_REJECTED: 'Open your seller dashboard',
  SELLER_TRYON: 'Try-on credits',
  SELLER_INVOICE: 'View the invoice',
};

const BRIDGE_KEY = 'email.bridge';
/** Notifications are looked at again for this long, so one written by a slow transaction is not missed. */
const OVERLAP_MS = 10 * 60_000;

/** Queue emails for notifications written since the last run. Returns how many were queued. */
export async function bridgeNotifications(now = new Date()): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: BRIDGE_KEY } });
  const state = (row?.value ?? null) as { startedAt?: string; lastRunAt?: string } | null;
  if (!state?.startedAt) {
    // First run: start from now — nothing from before goes out.
    const value = { startedAt: now.toISOString(), lastRunAt: now.toISOString() };
    await prisma.platformSetting.upsert({ where: { key: BRIDGE_KEY }, update: { value }, create: { key: BRIDGE_KEY, value } });
    return 0;
  }
  const startedAt = new Date(state.startedAt);
  const from = new Date(Math.max(startedAt.getTime(), new Date(state.lastRunAt ?? state.startedAt).getTime() - OVERLAP_MS));
  const rows = await prisma.notification.findMany({
    where: { createdAt: { gte: from }, type: { in: Object.keys(EMAIL_NOTIFICATIONS) }, user: { email: { not: null } } },
    select: { id: true, type: true, title: true, body: true, linkHref: true, userId: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  let queued = 0;
  for (const n of rows) {
    const ok = await enqueueEmail({
      to: n.user.email!,
      userId: n.userId,
      kind: n.type,
      dedupeKey: `n:${n.id}`,
      title: n.title,
      subject: `${n.title.replace(/\s*\p{Extended_Pictographic}️?/gu, '').trim()} — Clowe`,
      body: n.body,
      ctaHref: n.linkHref,
      ctaLabel: EMAIL_NOTIFICATIONS[n.type],
    });
    if (ok) queued += 1;
  }
  // A full page means more are waiting: carry on from the last one next time.
  const next = rows.length === 500 ? (await prisma.notification.findUnique({ where: { id: rows[rows.length - 1]!.id }, select: { createdAt: true } }))!.createdAt : now;
  const value = { startedAt: state.startedAt, lastRunAt: new Date(next.getTime() + (rows.length === 500 ? OVERLAP_MS : 0)).toISOString() };
  await prisma.platformSetting.update({ where: { key: BRIDGE_KEY }, data: { value } });
  return queued;
}

export async function runEmailTick(now = new Date()) {
  const queued = await bridgeNotifications(now);
  const r = await processEmailOutbox(now);
  return { queued, ...r };
}

/** Every 30 seconds: notifications into the queue, then the queue out. */
export function startEmailJobs(): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runEmailTick()
      .catch((err) => console.error('[clowe-api] email job failed:', err))
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, 30_000);
  timer.unref();
}

// --- Admin -------------------------------------------------------------------------------------

export async function emailOutboxView() {
  const now = new Date();
  const [today, pending, failed, recent] = await Promise.all([
    sentToday(now),
    prisma.emailOutbox.count({ where: { status: { in: ['PENDING', 'SENDING'] } } }),
    prisma.emailOutbox.count({ where: { status: 'FAILED' } }),
    prisma.emailOutbox.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, kind: true, toEmail: true, subject: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true },
    }),
  ]);
  return {
    provider: emailProviderName,
    from: env.MAIL_FROM,
    replyTo: env.MAIL_REPLY_TO,
    dailyCap: env.EMAIL_DAILY_CAP,
    loginError: loginState.error,
    heldUntil: loginState.heldUntil?.toISOString() ?? null,
    sentToday: today,
    pending,
    failed,
    recent,
  };
}
