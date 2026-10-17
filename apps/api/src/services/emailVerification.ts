import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { enqueueEmail, istStartOfDay } from './email';

/**
 * A customer's email address, confirmed by a one-time link. Setting or
 * changing the address sends the link; opening it marks the address confirmed
 * and the link stops working. Order updates by email go to confirmed
 * addresses only, so a mistyped address never receives someone's orders.
 * Sign-in stays SMS OTP; this is only about where emails go.
 */

/** How long a link works. */
export const EMAIL_LINK_HOURS = 48;
/** The least time between two links for one account, and the most links a day. */
const RESEND_GAP_MS = 60_000;
export const EMAIL_LINKS_PER_DAY = 5;

async function assertCanSendLink(userId: string): Promise<void> {
  const today = await prisma.emailOutbox.count({ where: { userId, kind: 'EMAIL_VERIFY', createdAt: { gte: istStartOfDay(new Date()) } } });
  if (today >= EMAIL_LINKS_PER_DAY) {
    throw ApiError.badRequest("You've asked for several links today — please try again tomorrow", 'EMAIL_LINK_DAILY_LIMIT');
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Normalised for storing and comparing: trimmed, lower case. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** A new link for the address on the account (replacing any earlier one), sent by email. */
export async function sendVerificationLink(userId: string): Promise<{ email: string; sentAt: Date }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true, emailVerifiedAt: true, emailVerifySentAt: true } });
  if (!user?.email) throw ApiError.badRequest('Add an email address first', 'EMAIL_MISSING');
  if (user.emailVerifiedAt) throw ApiError.badRequest('This email address is already confirmed', 'EMAIL_ALREADY_VERIFIED');
  const now = new Date();
  if (user.emailVerifySentAt && now.getTime() - user.emailVerifySentAt.getTime() < RESEND_GAP_MS) {
    throw ApiError.badRequest('We just sent a link — please wait a minute before asking for another', 'EMAIL_LINK_TOO_SOON');
  }
  await assertCanSendLink(userId);
  const token = randomBytes(32).toString('base64url');
  await prisma.user.update({ where: { id: userId }, data: { emailVerifyTokenHash: hash(token), emailVerifySentAt: now } });
  await enqueueEmail({
    to: user.email,
    userId,
    kind: 'EMAIL_VERIFY',
    title: 'Confirm your email address',
    subject: 'Confirm your email for Clowe',
    body:
      `Hi${user.name ? ` ${user.name.split(' ')[0]}` : ''}, please confirm that ${user.email} is your email address, so we can send you your order updates and invoices here.\n\n` +
      `The link works once, for ${EMAIL_LINK_HOURS} hours. If you didn't add this address on Clowe, you can ignore this email.`,
    ctaHref: `/verify-email?token=${token}`,
    ctaLabel: 'Confirm my email',
  });
  return { email: user.email, sentAt: now };
}

/** Set (or clear) the account's address. A new address is unconfirmed until its link is opened. */
export async function setUserEmail(userId: string, raw: string | null): Promise<{ changed: boolean }> {
  const email = raw ? normaliseEmail(raw) : null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw ApiError.notFound('Account not found');
  if ((user.email ? normaliseEmail(user.email) : null) === email) return { changed: false };
  if (email) {
    const taken = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, id: { not: userId } }, select: { id: true } });
    if (taken) throw ApiError.badRequest('This email is already in use', 'EMAIL_TAKEN');
    await assertCanSendLink(userId);
  }
  await prisma.user.update({
    where: { id: userId },
    data: { email, emailVerifiedAt: null, emailVerifyTokenHash: null, emailVerifySentAt: null },
  });
  if (email) await sendVerificationLink(userId);
  return { changed: true };
}

/** Open a link: confirms the address once. */
export async function confirmEmail(token: string): Promise<{ email: string }> {
  const user = token ? await prisma.user.findUnique({ where: { emailVerifyTokenHash: hash(token) }, select: { id: true, email: true, emailVerifySentAt: true } }) : null;
  if (!user?.email) throw ApiError.badRequest('This link has already been used or is not valid. Ask for a new one in My Account.', 'EMAIL_LINK_INVALID');
  if (!user.emailVerifySentAt || Date.now() - user.emailVerifySentAt.getTime() > EMAIL_LINK_HOURS * 3_600_000) {
    throw ApiError.badRequest('This link has expired. Ask for a new one in My Account.', 'EMAIL_LINK_EXPIRED');
  }
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), emailVerifyTokenHash: null } });
  return { email: user.email };
}
