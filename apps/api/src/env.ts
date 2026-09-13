import dotenv from 'dotenv';
import { z } from 'zod';

// `.env` holds the shared, checked-in-by-example config; `.env.local` holds
// whatever one machine needs differently (a free port, a local service) and
// wins where both set the same key. Both are gitignored. This mirrors how
// Next.js layers the two on the web side, so the same file means the same
// thing in either app.
dotenv.config({ path: ['.env.local', '.env'] });

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
  OTP_PROVIDER: z.enum(['mock']).default('mock'), // 'msg91' | 'twilio' added later
  OTP_TTL_MIN: z.coerce.number().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),

  // Phone number that gets the ADMIN role via the seed script.
  ADMIN_PHONE: z.string().regex(/^[6-9]\d{9}$/).optional(),

  // --- Payments ---
  // 'mock' settles payments via a fake pay button (dev). 'razorpay' uses test/live keys.
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // --- Returns ---
  // Customers can request a return up to this many days after delivery.
  RETURN_WINDOW_DAYS: z.coerce.number().int().min(1).default(7),

  // --- AI Try-On ---
  // 'auto': use FASHN when FASHN_API_KEY is set, otherwise the free mock.
  TRYON_PROVIDER: z.enum(['auto', 'mock', 'fashn']).default('auto'),
  FASHN_API_KEY: z.string().trim().min(1).optional(),
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
  AI_PROVIDER: z.enum(['auto', 'mock', 'anthropic']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-4-8'),

  // --- Growth & notifications ---
  // Reward credited to the referrer when a referred user's first order is paid.
  REFERRAL_REWARD_PAISE: z.coerce.number().int().min(0).default(10000),
  // 'mock' logs WhatsApp/SMS/email to the console. MSG91/Gupshup/SES later.
  MESSAGING_PROVIDER: z.enum(['mock']).default('mock'),
  // 'mock' fabricates AWB numbers. Shiprocket/Delhivery later.
  SHIPPING_PROVIDER: z.enum(['mock']).default('mock'),

  // --- File storage (local disk in dev; S3-compatible later) ---
  UPLOAD_DIR: z.string().default('uploads'),
  // Public base URL of this API, used to build absolute image URLs.
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  // Public base URL of the web app, printed into the QR codes on seller labels and
  // invoices. Defaults to the first CORS origin, which is the storefront everywhere.
  WEB_PUBLIC_URL: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
export const webPublicUrl = env.WEB_PUBLIC_URL ?? corsOrigins[0];
