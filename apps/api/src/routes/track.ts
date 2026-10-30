import { Router, type Request } from 'express';
import {
  trackCodeRequestSchema,
  trackCodeVerifySchema,
  type LoginIdentifier,
  type TrackCodeSent,
  type TrackCodeVerified,
  type TrackOrderView,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { otpRequestLimiter, otpVerifyLimiter, trackLimiter, trackRefreshLimiter } from '../middleware/rateLimits';
import { authService, consumeOtp } from '../services/authService';
import { enqueueEmail } from '../services/email';
import { orderTracking, refreshOrderTracking } from '../services/shipping/trackingView';
import { ApiError } from '../utils/ApiError';
import { signTrackToken, TRACK_TOKEN_TTL_MIN, verifyTrackToken } from '../utils/jwt';

// ---------------------------------------------------------------------------
// Track Order, for someone not signed in: the order number and the phone or
// email on the order, then a one-time code sent there (SMS to the phone, or
// to the account's confirmed email). The code gives a 30-minute token for that
// one order, sent back as the x-track-token header. Signed-in buyers use
// GET /mine, which needs no code for their own orders.
//
// What it shows: the parcels' bars, Delhivery's scans, the AWB and the
// delivery city — never the street, a phone, an email, or the seller's
// address.
// ---------------------------------------------------------------------------
export const trackRouter = Router();

const NOT_FOUND = () => ApiError.notFound('No order found for this order number and phone or email', 'ORDER_NOT_FOUND');

/** Scans as older pages show them: status, place, time. */
export function scanViews(events: { at: Date; status: string; location: string | null }[] | undefined) {
  return (events ?? []).map((e) => ({ at: e.at.toISOString(), status: e.status, location: e.location }));
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user!.slice(0, 2)}•••@${domain}`;
}

/** The order, if this phone or email is on it: where it ships, or the account that placed it. */
async function orderFor(orderNumber: string, contact: LoginIdentifier) {
  const order = await prisma.order.findUnique({
    where: { orderNumber: orderNumber.toUpperCase() },
    select: { id: true, shipPhone: true, user: { select: { phone: true, email: true, emailVerifiedAt: true } } },
  });
  if (!order) return null;
  if (contact.kind === 'phone') return order.shipPhone === contact.value || order.user.phone === contact.value ? order : null;
  // An email only once confirmed: a mistyped address must never receive the code.
  const email = order.user.email?.toLowerCase();
  return email && order.user.emailVerifiedAt && email === contact.value.toLowerCase() ? order : null;
}

/** The code's key in the OTP store: the phone itself, or the email marked as one. */
const codeKey = (contact: LoginIdentifier) => (contact.kind === 'phone' ? contact.value : `email:${contact.value.toLowerCase()}`);

async function view(orderId: string): Promise<TrackOrderView> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: { select: { status: true } } } });
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    placedAt: order.createdAt.toISOString(),
    paid: order.payment?.status === 'PAID',
    shipCity: order.shipCity,
    shipState: order.shipState,
    shipPincode: order.shipPincode,
    parcels: await orderTracking(order.id),
  };
}

function tokenOrder(req: Request): string {
  const orderId = verifyTrackToken(req.get('x-track-token') ?? '');
  if (!orderId) throw ApiError.unauthorized('Your tracking session has ended — enter the code again', 'TRACK_TOKEN_INVALID');
  return orderId;
}

// Before Track Order asked for a code: anyone with the order number and phone saw the order.
trackRouter.get('/', trackLimiter, (_req, _res, next) => {
  next(new ApiError(410, 'TRACK_NEEDS_CODE', 'Tracking now needs a one-time code: enter your order number and phone or email'));
});

trackRouter.post('/request-code', otpRequestLimiter, async (req, res, next) => {
  try {
    const { orderNumber, contact } = trackCodeRequestSchema.parse(req.body);
    const order = await orderFor(orderNumber, contact);
    if (!order) throw NOT_FOUND();
    const sent =
      contact.kind === 'phone'
        ? await authService.requestOtp(contact.value)
        : await authService.requestOtp(codeKey(contact), async (code) => {
            await enqueueEmail({
              to: contact.value,
              kind: 'TRACK_CODE',
              title: `Your code to track order ${orderNumber.toUpperCase()}`,
              subject: `${code} is your Clowe tracking code`,
              body: `Enter ${code} on the Track Order page to see where order ${orderNumber.toUpperCase()} is. The code works for a few minutes. If you didn't ask for it, you can ignore this email.`,
            });
          });
    const body: TrackCodeSent = {
      channel: contact.kind === 'phone' ? 'sms' : 'email',
      sentTo: contact.kind === 'phone' ? `${contact.value.slice(0, 2)}•••••${contact.value.slice(-3)}` : maskEmail(contact.value),
      resendAfterSec: sent.resendAfterSec,
      expiresInSec: sent.expiresInSec,
      ...(sent.devOtp ? { devOtp: sent.devOtp } : {}),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

trackRouter.post('/verify', otpVerifyLimiter, async (req, res, next) => {
  try {
    const { orderNumber, contact, code } = trackCodeVerifySchema.parse(req.body);
    const order = await orderFor(orderNumber, contact);
    if (!order) throw NOT_FOUND();
    await consumeOtp(codeKey(contact), code);
    const body: TrackCodeVerified = { token: signTrackToken(order.id), expiresInSec: TRACK_TOKEN_TTL_MIN * 60 };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

trackRouter.get('/view', trackLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await view(tokenOrder(req)) });
  } catch (err) {
    next(err);
  }
});

trackRouter.post('/refresh', trackRefreshLimiter, async (req, res, next) => {
  try {
    const orderId = tokenOrder(req);
    const refresh = await refreshOrderTracking(orderId);
    res.json({ success: true, data: { ...refresh, view: await view(orderId) } });
  } catch (err) {
    next(err);
  }
});

// Signed in: their own orders, no code.
trackRouter.get('/mine', trackLimiter, requireAuth, async (req, res, next) => {
  try {
    const orderNumber = String(req.query.orderNumber ?? '').trim().toUpperCase();
    const order = orderNumber ? await prisma.order.findUnique({ where: { orderNumber }, select: { id: true, userId: true } }) : null;
    if (!order || order.userId !== req.auth!.userId) throw NOT_FOUND();
    res.json({ success: true, data: { ...(await view(order.id)), orderId: order.id } });
  } catch (err) {
    next(err);
  }
});
