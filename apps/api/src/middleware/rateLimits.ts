import rateLimit from 'express-rate-limit';

const limitError = (message: string) => ({
  success: false,
  error: { code: 'TOO_MANY_REQUESTS', message },
});

const common = { standardHeaders: true, legacyHeaders: false } as const;

/** Whole-API safety net. Generous — normal browsing never hits it. */
export const globalLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 300,
  message: limitError('Too many requests — please slow down.'),
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
