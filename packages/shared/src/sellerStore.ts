import { z } from 'zod';

// ---------------------------------------------------------------------------
// Seller store settings
//
// Everything a seller controls about how their shop looks and behaves:
// storefront presentation, pickup/return addresses, fulfilment preferences
// and availability.
// ---------------------------------------------------------------------------

export const STORE_TABS = [
  'PROFILE',
  'BUSINESS',
  'BANK',
  'SHIPPING',
  'RETURNS',
  'HOURS',
  'INTEGRATIONS',
] as const;
export type StoreTab = (typeof STORE_TABS)[number];

export const STORE_TAB_LABELS: Record<StoreTab, string> = {
  PROFILE: 'Store profile',
  BUSINESS: 'Business info',
  BANK: 'Bank & payouts',
  SHIPPING: 'Shipping & pickup',
  RETURNS: 'Return policy',
  HOURS: 'Hours & vacation',
  INTEGRATIONS: 'Integrations',
};

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface WorkingHours {
  open: string; // "09:00"
  close: string; // "21:00"
  closed: boolean;
}

export interface StoreHighlight {
  icon: string;
  title: string;
  subtitle: string;
}

/** Suggested trust chips a seller can add with one click. */
export const HIGHLIGHT_PRESETS: StoreHighlight[] = [
  { icon: '🏷', title: '100% Original', subtitle: 'Genuine products only' },
  { icon: '↩', title: 'Easy returns', subtitle: 'Hassle-free within the window' },
  { icon: '🔒', title: 'Secure payments', subtitle: 'Protected checkout' },
  { icon: '🚚', title: 'Fast dispatch', subtitle: 'Shipped in 1–2 days' },
  { icon: '✅', title: 'Quality checked', subtitle: 'Inspected before shipping' },
  { icon: '💬', title: 'Responsive support', subtitle: 'We answer quickly' },
];

export interface SellerStoreSettings {
  id: string;
  /** Presentation. */
  shopName: string;
  slug: string | null;
  storeUrl: string | null;
  tagline: string | null;
  description: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  storeEmail: string | null;
  storePhone: string | null;
  highlights: StoreHighlight[];
  socialLinks: { website: string; instagram: string; facebook: string; youtube: string };
  primaryCategoryId: string | null;
  primaryCategoryName: string | null;

  /** Business & compliance (KYC fields are read-only once verified). */
  businessType: string | null;
  gstNumber: string | null;
  panNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;

  /** Payouts. */
  bankAccountName: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  payoutMethodCount: number;

  /** Pickup + fulfilment. */
  pickupSameAsBusiness: boolean;
  pickupName: string | null;
  pickupPhone: string | null;
  pickupLine1: string | null;
  pickupLine2: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupPincode: string | null;
  dispatchDays: number;
  codEnabled: boolean;

  /** Returns. */
  returnWindowDays: number | null;
  /** The window in force — the seller's override or the platform default. */
  effectiveReturnWindowDays: number;
  platformReturnWindowDays: number;
  returnAddressSameAsPickup: boolean;
  returnLine1: string | null;
  returnCity: string | null;
  returnState: string | null;
  returnPincode: string | null;

  /** Availability. */
  workingHours: Record<Weekday, WorkingHours>;
  vacationMode: boolean;
  vacationUntil: string | null;
  vacationMessage: string | null;

  /** Read-only status. */
  status: string;
  kycStatus: string;
  productCount: number;
  liveProductCount: number;
}

/** One checklist row behind the store-strength score. */
export interface StoreHealthItem {
  key: string;
  label: string;
  done: boolean;
  hint: string;
  /** Which tab fixes it. */
  tab: StoreTab;
}

export interface SellerStoreHealth {
  /** 0–100 completeness of the store setup. */
  score: number;
  rating: 'EXCELLENT' | 'GOOD' | 'NEEDS_WORK';
  items: StoreHealthItem[];
}

/** What the platform is wired to — read-only, set by the marketplace. */
export interface PlatformIntegration {
  key: string;
  name: string;
  purpose: string;
  status: 'LIVE' | 'SANDBOX';
  detail: string;
}

export interface SellerStoreOverview {
  settings: SellerStoreSettings;
  health: SellerStoreHealth;
  integrations: PlatformIntegration[];
}

const socialUrl = z.string().trim().url().max(200).or(z.literal(''));

export const storeProfileSchema = z.object({
  shopName: z.string().trim().min(2, 'Store name is required').max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes')
    .min(3)
    .max(60)
    .optional()
    .or(z.literal('')),
  tagline: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
  logoUrl: z.string().trim().url().optional().or(z.literal('')),
  bannerUrl: z.string().trim().url().optional().or(z.literal('')),
  storeEmail: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  storePhone: z.string().trim().max(20).optional(),
  primaryCategoryId: z.string().optional().or(z.literal('')),
  highlights: z
    .array(
      z.object({
        icon: z.string().trim().min(1).max(4),
        title: z.string().trim().min(2).max(30),
        subtitle: z.string().trim().max(40),
      }),
    )
    .max(6)
    .optional(),
  socialLinks: z
    .object({
      website: socialUrl,
      instagram: socialUrl,
      facebook: socialUrl,
      youtube: socialUrl,
    })
    .optional(),
});
export type StoreProfileInput = z.infer<typeof storeProfileSchema>;

export const storeBusinessSchema = z.object({
  businessType: z.string().trim().max(40).optional().or(z.literal('')),
  gstNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'GSTIN looks like 29ABCDE1234F1Z5')
    .optional()
    .or(z.literal('')),
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN looks like ABCDE1234F')
    .optional()
    .or(z.literal('')),
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  landmark: z.string().trim().max(80).optional(),
  city: z.string().trim().max(60).optional(),
  state: z.string().trim().max(60).optional(),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'PIN code is 6 digits')
    .optional()
    .or(z.literal('')),
});
export type StoreBusinessInput = z.infer<typeof storeBusinessSchema>;

export const storeShippingSchema = z.object({
  pickupSameAsBusiness: z.boolean(),
  pickupName: z.string().trim().max(80).optional(),
  pickupPhone: z.string().trim().max(20).optional(),
  pickupLine1: z.string().trim().max(120).optional(),
  pickupLine2: z.string().trim().max(120).optional(),
  pickupCity: z.string().trim().max(60).optional(),
  pickupState: z.string().trim().max(60).optional(),
  pickupPincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'PIN code is 6 digits')
    .optional()
    .or(z.literal('')),
  dispatchDays: z.number().int().min(1).max(10),
  codEnabled: z.boolean(),
});
export type StoreShippingInput = z.infer<typeof storeShippingSchema>;

export const storeReturnsSchema = z.object({
  /** null / undefined = follow the platform window. */
  returnWindowDays: z.number().int().min(0).max(30).nullable().optional(),
  returnAddressSameAsPickup: z.boolean(),
  returnLine1: z.string().trim().max(120).optional(),
  returnCity: z.string().trim().max(60).optional(),
  returnState: z.string().trim().max(60).optional(),
  returnPincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'PIN code is 6 digits')
    .optional()
    .or(z.literal('')),
});
export type StoreReturnsInput = z.infer<typeof storeReturnsSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 09:30');

export const storeHoursSchema = z.object({
  workingHours: z.record(
    z.enum(WEEKDAYS),
    z.object({ open: hhmm, close: hhmm, closed: z.boolean() }),
  ),
  vacationMode: z.boolean(),
  vacationUntil: z.string().optional().or(z.literal('')),
  vacationMessage: z.string().trim().max(200).optional(),
});
export type StoreHoursInput = z.infer<typeof storeHoursSchema>;

// ---------------------------------------------------------------------------
// Public storefront
// ---------------------------------------------------------------------------

export interface PublicStore {
  slug: string;
  shopName: string;
  tagline: string | null;
  description: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  isVerified: boolean;
  city: string | null;
  state: string | null;
  primaryCategoryName: string | null;
  highlights: StoreHighlight[];
  socialLinks: { website: string; instagram: string; facebook: string; youtube: string };
  workingHours: Record<Weekday, WorkingHours>;
  /** Set when the shop is on vacation — the storefront explains the pause. */
  vacationMessage: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  productCount: number;
  memberSince: string;
  returnWindowDays: number;
}
