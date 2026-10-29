import dotenv from 'dotenv';
import { z } from 'zod';
import { DELHIVERY_HOSTS, isLiveDelhiveryUrl } from './services/shipping/delhiveryHosts';

// `.env` holds the shared, checked-in-by-example config; `.env.local` holds
// whatever one machine needs differently (a free port, a local service) and
// wins where both set the same key. Both are gitignored. This mirrors how
// Next.js layers the two on the web side, so the same file means the same
// thing in either app.
dotenv.config({ path: ['.env.local', '.env'] });

/**
 * An optional variable that may arrive as an empty string. docker-compose
 * passes `${VAR:-}` for an unset variable, which is "" rather than absent, and
 * "" must mean "not configured" — not a malformed value that stops the server
 * booting. A value that is actually set is still validated in full.
 */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

/** An optional API key or secret: blank is unset; anything else must be non-empty. */
const optionalSecret = blankAsUnset(z.string().trim().min(1).optional());

/** Used outside production so a dev machine needs no extra setup. */
export const DEV_KYC_FINGERPRINT_SECRET = 'dev-only-kyc-fingerprint-secret-change-me';

// Validate environment up-front so a misconfigured server fails fast.
const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // --- Auth ---
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_ACCESS_TTL_MIN: z.coerce.number().default(15), // access token lifetime (minutes)
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(90), // sliding — renewed on every refresh

  // --- OTP ---
  // 'mock' prints the code to the API log. 'smspanel' sends it by SMS through
  // the DLT-registered panel below, and falls back to the mock (with a warning
  // at boot) while any of its settings is missing.
  OTP_PROVIDER: z.enum(['mock', 'smspanel']).default('mock'),
  OTP_TTL_MIN: z.coerce.number().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  // The SMS panel. Its certificate must verify for this host: https only.
  SMS_PANEL_BASE_URL: blankAsUnset(z.string().default('https://alots.in')),
  SMS_PANEL_USERNAME: optionalSecret,
  SMS_PANEL_API_KEY: optionalSecret,
  // The 6-character DLT header, e.g. CLOWEE.
  SMS_PANEL_SENDER_ID: optionalSecret,
  // The DLT template ID of the approved OTP template.
  SMS_PANEL_TEMPLATE_ID: optionalSecret,
  // The approved template text, character for character, with its one DLT
  // variable ({#num#}, {#var#}, …) where the code goes. Not trimmed: DLT
  // matches the text exactly. A line break is written \n inside double quotes.
  SMS_PANEL_OTP_TEMPLATE: blankAsUnset(z.string().optional()),

  // Phone number that gets the ADMIN role via the seed script.
  ADMIN_PHONE: blankAsUnset(z.string().regex(/^[6-9]\d{9}$/).optional()),

  // --- Payments ---
  // 'mock' settles payments via a fake pay button (dev). 'razorpay' and
  // 'cashfree' use test/live keys.
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay', 'cashfree']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Cashfree Payment Gateway. Sandbox never moves money; production only with
  // NODE_ENV=production. The secret also signs the gateway's webhooks.
  CASHFREE_PG_ENV: blankAsUnset(z.enum(['sandbox', 'production']).default('sandbox')),
  CASHFREE_PG_CLIENT_ID: optionalSecret,
  CASHFREE_PG_CLIENT_SECRET: optionalSecret,
  // How seller money reaches sellers: 'payouts' — collected into Clowe's
  // settlement and paid by Cashfree Payouts after the hold; 'easy_split' —
  // each seller's share split to their Cashfree vendor account at payment and
  // released after the hold (needs Easy Split active on the account).
  SETTLEMENT_MODE: blankAsUnset(z.enum(['payouts', 'easy_split']).default('payouts')),

  // --- Seller payouts ---
  // 'mock' settles instantly with a fake UTR; 'cashfree' sends real transfers
  // through Cashfree Payouts (its own keys, its own environment).
  PAYOUT_PROVIDER: blankAsUnset(z.enum(['mock', 'cashfree']).default('mock')),
  CASHFREE_PAYOUT_ENV: blankAsUnset(z.enum(['sandbox', 'production']).default('sandbox')),
  CASHFREE_PAYOUT_CLIENT_ID: optionalSecret,
  CASHFREE_PAYOUT_CLIENT_SECRET: optionalSecret,
  // Only when the server's IP is not allowlisted: the PEM public key Cashfree
  // issues for signature 2FA, on one line with literal \n for line breaks.
  CASHFREE_PAYOUT_PUBLIC_KEY: optionalSecret,
  // A short window for the Payouts dashboard's unsigned "Test & Add Webhook"
  // event (services/payouts/webhookTestWindow.ts): an ISO time, at most 30
  // minutes after the API starts. Unset (the default): closed.
  PAYOUT_WEBHOOK_TEST_UNTIL: blankAsUnset(z.string().trim().optional()),

  // --- Returns ---
  // Customers can request a return up to this many days after delivery.

  // --- AI Try-On ---
  // 'auto': use FASHN when FASHN_API_KEY is set, otherwise the free mock.
  TRYON_PROVIDER: z.enum(['auto', 'mock', 'fashn']).default('auto'),
  FASHN_API_KEY: optionalSecret,
  // FASHN model. 'tryon-v1.6' is 1 credit per image; 'tryon-max' is higher
  // quality and costs more credits per run.
  FASHN_MODEL: z.string().default('tryon-v1.6'),
  // Speed/quality trade-off: performance ~5s, balanced ~8s, quality ~12-17s.
  FASHN_MODE: z.enum(['performance', 'balanced', 'quality']).default('balanced'),
  // Whole-run budget. The request is held open for this long, so it must stay
  // comfortably under any proxy/CDN timeout in front of the API (Cloudflare: 100s).
  TRYON_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(90_000).default(75_000),
  TRYON_DAILY_LIMIT: z.coerce.number().int().min(1).default(10),
  // Cost logged per FASHN try-on (paise) — for accounting (~$0.075 ≈ ₹6.5).
  TRYON_COST_PAISE: z.coerce.number().int().min(0).default(650),

  // --- AI features (descriptions, review summary, voice search, support chat) ---
  // 'auto': use Claude when ANTHROPIC_API_KEY is set, otherwise the free mock.
  // 'auto': Gemini when GEMINI_API_KEY is set, else Claude when ANTHROPIC_API_KEY is set, else the free mock.
  AI_PROVIDER: z.enum(['auto', 'mock', 'anthropic', 'gemini']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-4-8'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),

  // --- Growth & notifications ---
  // Reward credited to the referrer when a referred user's first order is paid.
  REFERRAL_REWARD_PAISE: z.coerce.number().int().min(0).default(10000),
  // 'mock' logs WhatsApp/SMS/email to the console. MSG91/Gupshup/SES later.
  MESSAGING_PROVIDER: z.enum(['mock']).default('mock'),
  // --- Email (Hostinger SMTP, from no-reply@cloweshop.com) ---
  // 'auto': SMTP when SMTP_PASSWORD is set (never under tests), else the mock,
  // which only logs. Emails queue in email_outbox and send in the background.
  EMAIL_PROVIDER: z.enum(['auto', 'mock', 'smtp']).default('auto'),
  SMTP_HOST: z.string().default('smtp.hostinger.com'),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_USER: z.string().default('no-reply@cloweshop.com'),
  SMTP_PASSWORD: optionalSecret,
  MAIL_FROM: z.string().default('Clowe <no-reply@cloweshop.com>'),
  MAIL_REPLY_TO: z.string().default('support@cloweshop.com'),
  // Emails a day (IST), held below Hostinger's per-mailbox limit; the rest
  // wait in the queue for the next day.
  EMAIL_DAILY_CAP: z.coerce.number().int().min(0).default(90),
  // --- Shipping: Delhivery is the only courier ---
  // 'mock' imitates Delhivery (no network, no money); 'delhivery' calls its
  // API with DELHIVERY_API_TOKEN.
  SHIPPING_PROVIDER: z.enum(['mock', 'delhivery']).default('mock'),
  // Staging (staging-express.delhivery.com) unless set to production
  // (track.delhivery.com). Staging and production have different tokens.
  DELHIVERY_ENV: blankAsUnset(z.enum(['staging', 'production']).default('staging')),
  DELHIVERY_API_TOKEN: optionalSecret,
  // Optional: another host for the chosen environment (e.g. a local stub).
  // Staging refuses to start if it is live Delhivery (track.delhivery.com).
  DELHIVERY_BASE_URL: blankAsUnset(z.string().url().optional()),
  // Production only, and off unless exactly 'true': booking, pickup requests,
  // cancellations and warehouse registration — anything that moves a real
  // parcel or spends wallet money. Without it live Delhivery is read-only.
  DELHIVERY_PRODUCTION_WRITES: blankAsUnset(z.enum(['true', 'false']).default('false')),
  // The secret Delhivery sends with each pushed scan (we choose it and give it
  // to them): "Authorization: Bearer <it>" or ?token=<it>. Unset: the webhook
  // is off and scans come by polling only.
  DELHIVERY_WEBHOOK_TOKEN: optionalSecret,

  // --- Seller KYC verification (PAN, GSTIN, bank account) ---
  // 'auto': Cashfree when its verification credentials are set, otherwise the
  // free mock — so adding the keys switches over with no code change.
  KYC_PROVIDER: z.enum(['auto', 'mock', 'cashfree']).default('auto'),
  // Each Cashfree product has its own environment, so one can go live while
  // another is still in sandbox — payouts will get CASHFREE_PAYOUT_ENV beside
  // this one. Sandbox never bills.
  CASHFREE_VERIFICATION_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  // Cashfree issues separate API keys per product; these are the Verification
  // Suite's (Secure ID), named so payments' and payouts' keys can sit beside them.
  CASHFREE_VERIFICATION_CLIENT_ID: optionalSecret,
  CASHFREE_VERIFICATION_CLIENT_SECRET: optionalSecret,
  // Only for signature 2FA (no static IP to allowlist): the PEM public key
  // Cashfree issues, on one line with literal \n where the line breaks go.
  CASHFREE_VERIFICATION_PUBLIC_KEY: optionalSecret,
  // Keys the fingerprints that tell whether a PAN, GSTIN or bank account on
  // file changed since it was verified. Rotating it makes every fingerprint
  // look new, and so re-bills every verification: set once, leave alone.
  KYC_FINGERPRINT_SECRET: optionalSecret,

  // --- File storage (local disk in dev; S3-compatible later) ---
  UPLOAD_DIR: z.string().default('uploads'),
  // Private files (return photos, try-on photos and results, packing videos)
  // when they are stored locally. Never served statically: only through a
  // signed /api/files URL. Must be on a persistent volume in production.
  PRIVATE_UPLOAD_DIR: z.string().default('uploads-private'),
  // Where private files live: 'local' (PRIVATE_UPLOAD_DIR), 'r2', or 'auto'
  // (R2 when its four settings below are present, else local).
  STORAGE_PROVIDER: z.enum(['auto', 'local', 'r2']).default('auto'),
  // Cloudflare R2, for private files. An API token scoped to the one bucket,
  // with Object Read & Write. The bucket has no public access.
  R2_ACCOUNT_ID: optionalSecret,
  R2_ACCESS_KEY_ID: optionalSecret,
  R2_SECRET_ACCESS_KEY: optionalSecret,
  R2_PRIVATE_BUCKET: optionalSecret,
  // Another S3-compatible endpoint instead of R2's. Tests only.
  R2_ENDPOINT: optionalSecret,
  // Signs the short-lived URLs for locally stored private files. Falls back to
  // JWT_ACCESS_SECRET, so nothing breaks when it is unset.
  FILE_URL_SECRET: optionalSecret,
  // Encrypts the bank details Cash on Delivery buyers give for a refund. Set
  // once (32+ random characters) and leave it: rotating it makes the stored
  // details unreadable. Unset: a key derived from JWT_ACCESS_SECRET.
  COD_REFUND_KEY: optionalSecret,
  // Public base URL of this API, used to build absolute image URLs.
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  // Public base URL of the web app, printed into the QR codes on seller labels and
  // invoices. Defaults to the first CORS origin, which is the storefront everywhere.
  WEB_PUBLIC_URL: z.string().optional(),
});

/** The schema with the rules between variables, exported for tests. */
export const envRules = envSchema
  .superRefine((e, ctx) => {
    // Live Delhivery only from the production server: never from staging, a
    // developer machine or a test run.
    if (e.DELHIVERY_ENV === 'staging' && isLiveDelhiveryUrl(e.DELHIVERY_BASE_URL ?? DELHIVERY_HOSTS.staging)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DELHIVERY_BASE_URL'],
        message: 'DELHIVERY_ENV=staging must not point at live Delhivery (track.delhivery.com) — refusing to start',
      });
    }
    if (e.DELHIVERY_ENV === 'production' && e.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['DELHIVERY_ENV'],
        message: 'DELHIVERY_ENV=production is only allowed on the production server (NODE_ENV=production)',
      });
    }
    if (e.NODE_ENV === 'test' && e.SHIPPING_PROVIDER !== 'mock') {
      ctx.addIssue({ code: 'custom', path: ['SHIPPING_PROVIDER'], message: 'Tests run on the mock courier only' });
    }
    if (e.SHIPPING_PROVIDER === 'delhivery' && !e.DELHIVERY_API_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['DELHIVERY_API_TOKEN'],
        message: 'SHIPPING_PROVIDER=delhivery requires DELHIVERY_API_TOKEN',
      });
    }
    // Live Cashfree (money that is real) only from the production server, and
    // never from a test run, whatever keys happen to be in the environment.
    for (const [key, value] of [
      ['CASHFREE_PG_ENV', e.CASHFREE_PG_ENV],
      ['CASHFREE_PAYOUT_ENV', e.CASHFREE_PAYOUT_ENV],
      ['CASHFREE_VERIFICATION_ENV', e.CASHFREE_VERIFICATION_ENV],
    ] as const) {
      if (value === 'production' && e.NODE_ENV !== 'production') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key}=production is only allowed on the production server (NODE_ENV=production)`,
        });
      }
    }
    if (e.NODE_ENV === 'test' && e.PAYMENT_PROVIDER !== 'mock') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'Tests run on the mock gateway only' });
    }
    if (e.NODE_ENV === 'test' && e.PAYOUT_PROVIDER !== 'mock') {
      ctx.addIssue({ code: 'custom', path: ['PAYOUT_PROVIDER'], message: 'Tests run on the mock payouts only' });
    }
    if (e.PAYMENT_PROVIDER === 'cashfree' && (!e.CASHFREE_PG_CLIENT_ID || !e.CASHFREE_PG_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CASHFREE_PG_CLIENT_ID'],
        message: 'PAYMENT_PROVIDER=cashfree requires CASHFREE_PG_CLIENT_ID and CASHFREE_PG_CLIENT_SECRET',
      });
    }
    if (e.PAYOUT_PROVIDER === 'cashfree' && (!e.CASHFREE_PAYOUT_CLIENT_ID || !e.CASHFREE_PAYOUT_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CASHFREE_PAYOUT_CLIENT_ID'],
        message: 'PAYOUT_PROVIDER=cashfree requires CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET',
      });
    }
    if (e.SETTLEMENT_MODE === 'easy_split' && e.PAYMENT_PROVIDER !== 'cashfree') {
      ctx.addIssue({
        code: 'custom',
        path: ['SETTLEMENT_MODE'],
        message: 'SETTLEMENT_MODE=easy_split needs PAYMENT_PROVIDER=cashfree',
      });
    }
    if (e.NODE_ENV === 'production' && (!e.KYC_FINGERPRINT_SECRET || e.KYC_FINGERPRINT_SECRET.length < 32)) {
      ctx.addIssue({
        code: 'custom',
        path: ['KYC_FINGERPRINT_SECRET'],
        message: 'KYC_FINGERPRINT_SECRET (32+ characters) is required in production',
      });
    }
  });

export const env = envRules.parse(process.env);

/** The fingerprint key actually in use: the configured one, or the dev default. */
export const kycFingerprintSecret = env.KYC_FINGERPRINT_SECRET ?? DEV_KYC_FINGERPRINT_SECRET;

export const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
export const webPublicUrl = env.WEB_PUBLIC_URL ?? corsOrigins[0];
