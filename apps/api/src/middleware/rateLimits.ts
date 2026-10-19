import type { Request } from 'express';
import rateLimit from 'express-rate-limit';

const limitError = (message: string) => ({
  success: false,
  error: { code: 'TOO_MANY_REQUESTS', message },
});

const common = { standardHeaders: true, legacyHeaders: false } as const;

/** Worded for the shopper: the web app shows it as is. */
export const TOO_MANY_REQUESTS = 'Too many requests, please try again in a moment';

/** Requests per minute per address: browsing the catalog, and everything else. */
export const CATALOG_READ_LIMIT = 1200;
export const GLOBAL_LIMIT = 300;

/**
 * Public catalog reads — the home page, categories, products and search. One
 * busy page fires a burst of these (and a shared office or mobile carrier
 * puts many shoppers behind one address), so they get their own, higher
 * allowance instead of eating into the one for changes. Mounted at /api, so
 * req.path has no /api prefix.
 */
export function isCatalogRead(req: Pick<Request, 'method' | 'path'>) {
  return (req.method === 'GET' || req.method === 'HEAD') && /^\/(home|categories|products|search)(\/|$)/.test(req.path);
}

/** Whole-API safety net. Generous — normal browsing never hits it. */
export const globalLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: GLOBAL_LIMIT,
  skip: isCatalogRead,
  message: limitError(TOO_MANY_REQUESTS),
});

/** The catalog's own allowance (see isCatalogRead). */
export const catalogReadLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: CATALOG_READ_LIMIT,
  skip: (req) => !isCatalogRead(req),
  message: limitError(TOO_MANY_REQUESTS),
});

/** OTP request: main brute-force/SMS-abuse target. */
export const otpRequestLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: limitError('Too many OTP requests. Please try again in 15 minutes.'),
});

/** OTP verify: prevents code guessing across phones from one IP. */
export const otpVerifyLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: limitError('Too many attempts. Please try again in 15 minutes.'),
});

/**
 * Login's "is there an account?" step. It answers yes or no, so it is kept to
 * what a person needs (a typo or two), not what a list of numbers would.
 */
export const ACCOUNT_LOOKUP_LIMIT = 15;
export const accountLookupLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: ACCOUNT_LOOKUP_LIMIT,
  message: limitError('Too many lookups from this connection. Please try again in 15 minutes.'),
});

/** Public order tracking: a shopper checks an order a few times, not hundreds. */
export const trackLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: limitError('Too many tracking lookups. Please try again in 15 minutes.'),
});

/** Content-Security-Policy reports: one page load can send a few; a flood is not a browser. */
export const cspReportLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 60,
  message: limitError('Too many reports.'),
});

/** Ad clicks: a shopper clicks a few ads, not dozens a minute. */
export const adClickLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 30,
  message: limitError(TOO_MANY_REQUESTS),
});

/** Image uploads. */
export const uploadLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 60,
  message: limitError('Upload limit reached. Please try again later.'),
});

/** AI endpoints (mock is cheap, real Claude/FASHN calls are not). */
export const aiLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 120,
  message: limitError('AI request limit reached. Please try again later.'),
});

/**
 * Search suggestions. Fires per keystroke, so the ceiling is high — it exists
 * to stop a scraper walking the catalog, not to police normal typing. The
 * client debounces at ~200ms, which keeps a fast typist well inside this.
 */
/**
 * Seller KYC verification. Every check is a paid call to the provider, so this
 * is a budget, not a courtesy: five runs an hour per seller, counted per
 * account rather than per IP so a phone switching networks is still one seller.
 * Cached answers make most runs free anyway; this stops the ones that are not.
 */
export const kycVerifyLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `kyc-seller:${req.auth?.userId ?? 'anonymous'}`,
  message: limitError('Too many verification attempts. Please try again in an hour.'),
});

/** An admin re-running checks across many sellers needs more room than one seller. */
export const kycAdminRunLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 60,
  keyGenerator: (req) => `kyc-admin:${req.auth?.userId ?? 'anonymous'}`,
  message: limitError('Too many verification re-runs. Please try again later.'),
});

export const suggestLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 120,
  message: limitError('Too many search requests — please slow down.'),
});

/**
 * The checkout asking whether a payment went through. Each ask is two reads
 * at the gateway; a page polling a pending UPI payment every few seconds fits
 * well inside this, a loop does not.
 */
export const paymentConfirmLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 40,
  keyGenerator: (req) => `pay-confirm:${req.auth?.userId ?? 'anonymous'}`,
  message: limitError('Too many payment checks. Please wait a moment.'),
});
