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
