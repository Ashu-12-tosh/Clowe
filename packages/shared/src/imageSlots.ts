// ---------------------------------------------------------------------------
// Where an uploaded image is shown, and the size to upload for it.
//
// One table for every image field in admin and seller forms, so the hint next
// to the field, the preview's shape and the storefront slot always agree.
// `picture` is the image beside a banner's own text; `full` is a banner that
// is the image itself (text and buttons baked in), and `mobile` its phone
// version. Sizes are what to upload: bigger is wasted, smaller looks soft.
// ---------------------------------------------------------------------------

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageSlot {
  label: string;
  /** The picture shown beside the banner's text (designed banners), or the image itself for tiles. */
  picture: ImageSize;
  /** A full-image banner on a computer. */
  full?: ImageSize;
  /** A full-image banner on a phone. */
  mobile?: ImageSize;
}

export const IMAGE_SLOTS = {
  HOME_HERO: {
    label: 'Home hero banner',
    picture: { width: 1200, height: 675 },
    full: { width: 2000, height: 750 },
    mobile: { width: 1080, height: 1350 },
  },
  CATEGORY_BANNER: {
    label: 'Category banner',
    picture: { width: 1600, height: 600 },
    full: { width: 2000, height: 600 },
    mobile: { width: 1080, height: 1080 },
  },
  PROMO_CARD: {
    label: 'Promo card (4-tile row)',
    picture: { width: 800, height: 600 },
    full: { width: 800, height: 600 },
    mobile: { width: 1080, height: 810 },
  },
  PROMO_STRIP: {
    label: 'Promo strip (wide)',
    picture: { width: 1200, height: 450 },
    full: { width: 1200, height: 450 },
    mobile: { width: 1080, height: 405 },
  },
  CATEGORY_TILE: { label: 'Category tile', picture: { width: 600, height: 600 } },
} as const satisfies Record<string, ImageSlot>;

export type ImageSlotKey = keyof typeof IMAGE_SLOTS;

/** Largest upload accepted, in bytes (the API's limit). */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "8:3" for 2000 × 750. */
export function aspectLabel({ width, height }: ImageSize): string {
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

/** "2000 × 750 px (8:3)" — what the form says next to the field. */
export function sizeHint(size: ImageSize): string {
  return `${size.width} × ${size.height} px (${aspectLabel(size)})`;
}
