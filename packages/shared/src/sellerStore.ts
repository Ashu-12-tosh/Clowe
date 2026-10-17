import { z } from 'zod';
import { gstNumberField, gstinMatchesPan, panNumberField } from './taxIds';
import { imageUrlSchema } from './imageUrl';
import { httpUrlSchema } from './url';

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
  'VACATION',
] as const;
export type StoreTab = (typeof STORE_TABS)[number];

export const STORE_TAB_LABELS: Record<StoreTab, string> = {
  PROFILE: 'Store profile',
  BUSINESS: 'Business info',
  BANK: 'Bank & payouts',
  SHIPPING: 'Shipping & pickup',
  RETURNS: 'Return policy',
  VACATION: 'Vacation',
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
  { icon: '🎥', title: 'Packed on video', subtitle: 'Every order is filmed as it is packed' },
  { icon: '↩', title: 'Exchange or refund', subtitle: 'For defective, damaged or wrong items' },
  { icon: '🔒', title: 'Secure payments', subtitle: 'Protected checkout' },
  { icon: '🚚', title: 'Fast dispatch', subtitle: 'Packed and shipped quickly' },
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
  panName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;

  /** Payouts. */
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  /** SAVINGS or CURRENT. */
  bankAccountType: string | null;
  /** A cancelled cheque is on file for the admin to verify the account against. */
  bankChequeOnFile: boolean;
  bankSubmittedAt: string | null;
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
  /** When Delhivery should come: HH:MM (India time) and weekdays, 1 = Monday … 6 = Saturday. */
  pickupSlot: string;
  pickupDays: number[];
  /** The pickup address as registered with Delhivery: booking waits for ACTIVE. */
  courierWarehouse: CourierWarehouseView;

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

  /** Availability. (Working hours are still stored, but no longer edited or shown.) */
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

export interface SellerStoreOverview {
  settings: SellerStoreSettings;
  health: SellerStoreHealth;
}

const socialUrl = httpUrlSchema(200).or(z.literal(''));

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
  logoUrl: imageUrlSchema.optional().or(z.literal('')),
  bannerUrl: imageUrlSchema.optional().or(z.literal('')),
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
  gstNumber: gstNumberField.optional(),
  panNumber: panNumberField.optional(),
  /**
   * The name exactly as printed on the PAN — the owner for a proprietorship,
   * the company for a company. The PAN check scores against this.
   */
  panName: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9 .&/-]*$/, 'Use only letters, digits, spaces and . & / -')
    .optional(),
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
}).superRefine(gstinMatchesPan);
export type StoreBusinessInput = z.infer<typeof storeBusinessSchema>;

/** The pickup times a seller can choose (India time); Delhivery collects in working hours. */
export const PICKUP_SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'] as const;
/** Monday … Saturday: Delhivery doesn't collect on Sundays. */
export const PICKUP_WEEKDAYS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
] as const;

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
  /** No longer sent by the form: the dispatch promise is a platform setting. Kept if absent. */
  dispatchDays: z.number().int().min(1).max(10).optional(),
  codEnabled: z.boolean(),
  /** Kept as stored if absent. */
  pickupSlot: z.enum(PICKUP_SLOTS).optional(),
  pickupDays: z
    .array(z.number().int().min(1).max(6))
    .min(1, 'Pick at least one pickup day')
    .max(6)
    .optional(),
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

/** Vacation mode. Working hours are no longer edited; what is stored stays. */
export const storeVacationSchema = z.object({
  vacationMode: z.boolean(),
  vacationUntil: z.string().optional().or(z.literal('')),
  vacationMessage: z.string().trim().max(200).optional(),
});
export type StoreVacationInput = z.infer<typeof storeVacationSchema>;

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
  /** Set when the shop is on vacation — the storefront explains the pause. */
  vacationMessage: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  productCount: number;
  memberSince: string;
  /** Hours after delivery to claim a damaged, wrong or defective item (no change-of-mind returns). */
  claimWindowHours: number;
}

/** A seller's pickup address as registered with the courier (Delhivery). */
export interface CourierWarehouseView {
  /** NONE: not registered yet · PENDING · ACTIVE: booking works · FAILED: see error. */
  status: 'NONE' | 'PENDING' | 'ACTIVE' | 'FAILED';
  name: string | null;
  error: string | null;
  syncedAt: string | null;
}
