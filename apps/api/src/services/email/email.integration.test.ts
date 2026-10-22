import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../env';
import { sendMessageSafe } from '../messaging';
import { bridgeNotifications, enqueueEmail, loginState, mockControl, mockSent, processEmailOutbox, sentToday } from '.';

/**
 * Email (mock transport here): notifications of the listed types become one
 * email each for users with an address; nothing from before the bridge first
 * ran goes out; a failed send retries later; the daily cap holds the rest.
 */

const prisma = new PrismaClient();
let withEmail: string;
let noEmail: string;
const cap = env.EMAIL_DAILY_CAP;

beforeAll(async () => {
  withEmail = (await prisma.user.create({ data: { phone: '9177400001', name: 'Mail Shopper', email: 'mail-shopper@example.com', emailVerifiedAt: new Date(), referralCode: 'MAIL-1' } })).id;
  noEmail = (await prisma.user.create({ data: { phone: '9177400002', name: 'No Mail', referralCode: 'MAIL-2' } })).id;
  await prisma.platformSetting.deleteMany({ where: { key: 'email.bridge' } });
  setCap(1_000_000); // other test files' emails count towards today too
});
const setCap = (n: number) => {
  (env as { EMAIL_DAILY_CAP: number }).EMAIL_DAILY_CAP = n;
};

afterAll(async () => {
  setCap(cap);
  await prisma.$disconnect();
});

const mine = () => prisma.emailOutbox.findMany({ where: { userId: { in: [withEmail, noEmail] } }, orderBy: { createdAt: 'asc' } });

describe('notifications by email', () => {
  it('starts from its first run: older notifications are never emailed', async () => {
    await prisma.notification.create({ data: { userId: withEmail, type: 'ORDER_CONFIRMED', title: 'Old order', body: 'Placed before email existed.' } });
    await new Promise((r) => setTimeout(r, 20));
    await bridgeNotifications();
    expect(await mine()).toHaveLength(0);
  });

  it('emails the listed types once each, only to users with an address', async () => {
    await new Promise((r) => setTimeout(r, 20));
    await prisma.notification.createMany({
      data: [
        { userId: withEmail, type: 'ORDER_CONFIRMED', title: 'Order placed 🎉', body: 'Your order CLW-123 is placed.\n\nWe will tell you when it ships.', linkHref: '/orders/abc' },
        { userId: withEmail, type: 'CREDITS_EARNED', title: 'Not an email type', body: 'x' },
        { userId: noEmail, type: 'ORDER_CONFIRMED', title: 'Order placed', body: 'No address on file.' },
      ],
    });
    await bridgeNotifications();
    await bridgeNotifications(); // a second pass over the same window queues nothing new
    const rows = await mine();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ORDER_CONFIRMED', toEmail: 'mail-shopper@example.com', subject: 'Order placed — Clowe', status: 'PENDING' });
    // The Clowe Shop wordmark as a hosted PNG (email clients do not show SVG), with its name as the alt text.
    expect(rows[0]!.html).toMatch(/<img src="https?:\/\/[^"]+\/brand\/wordmark-black-480\.png"[^>]*alt="CLOWE SHOP"/);
    expect(rows[0]!.text.startsWith('CLOWE SHOP')).toBe(true);
    expect(rows[0]!.html).toMatch(/href="https?:\/\/[^"]+\/orders\/abc"/);
    expect(rows[0]!.text).toContain('View your order: ');
  });

  it('sends, and a failed send waits and tries again', async () => {
    mockControl.failFor = 'mail-shopper@example.com';
    const now = new Date();
    await processEmailOutbox(now, 1000);
    let row = (await mine())[0]!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'mock SMTP failure' });
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    await processEmailOutbox(new Date(now.getTime() + 61_000), 1000);
    row = (await mine())[0]!;
    expect(row).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(mockSent.some((m) => m.to === 'mail-shopper@example.com' && m.subject === 'Order placed — Clowe')).toBe(true);
  });

  it('stops at the daily cap; the rest wait', async () => {
    await processEmailOutbox(new Date(), 1000); // nothing else waiting
    for (const n of [1, 2]) await enqueueEmail({ to: 'mail-shopper@example.com', userId: withEmail, kind: 'TEST', title: `Capped ${n}`, body: 'x' });
    setCap((await sentToday()) + 1);
    const r = await processEmailOutbox(new Date(), 50);
    expect(r).toMatchObject({ sent: 1, held: true });
    const capped = (await mine()).filter((m) => m.subject.startsWith('Capped'));
    expect(capped.map((m) => m.status).sort()).toEqual(['PENDING', 'SENT']);
    setCap(1_000_000);
  });

  it('a refused SMTP login holds the whole queue without using up retries', async () => {
    await processEmailOutbox(new Date(), 1000); // nothing else waiting
    await enqueueEmail({ to: 'mail-shopper@example.com', userId: withEmail, kind: 'TEST', title: 'Login held', body: 'x' });
    mockControl.loginFails = true;
    const now = new Date();
    expect(await processEmailOutbox(now, 1000)).toMatchObject({ sent: 0, loginFailed: true, held: true });
    const row = (await mine()).find((m) => m.subject === 'Login held')!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + 30 * 60_000);
    // Held: nothing is tried again until the pause is over…
    mockControl.loginFails = false;
    expect(await processEmailOutbox(new Date(now.getTime() + 60_000), 1000)).toMatchObject({ sent: 0, loginFailed: true });
    // …then it goes, and the hold clears.
    expect((await processEmailOutbox(new Date(now.getTime() + 31 * 60_000), 1000)).sent).toBeGreaterThanOrEqual(1);
    expect((await mine()).find((m) => m.subject === 'Login held')).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(loginState).toMatchObject({ heldUntil: null, error: null });
  });

  it('the messaging layer’s email channel goes through the queue; bad addresses are refused', async () => {
    sendMessageSafe({ channel: 'email', to: 'seller-mail@example.com', subject: 'Seller application CLW-S-1', body: 'Received.' });
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.emailOutbox.findFirst({ where: { toEmail: 'seller-mail@example.com', kind: 'message' } })).toMatchObject({ subject: 'Seller application CLW-S-1' });
    expect(await enqueueEmail({ to: 'not an address', kind: 'TEST', title: 'x', body: 'x' })).toBe(false);
  });
});
