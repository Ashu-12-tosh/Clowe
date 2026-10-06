/**
 * Stock-photo hosts the demo data hot-links (prisma/seed). Matched as a URL
 * prefix, so a product titled "picsum" is left alone.
 */
const STOCK_PHOTO = /^https?:\/\/([a-z0-9-]+\.)*(picsum\.photos|loremflickr\.com)(\/|$)/i;
export const MENTIONS_STOCK = /picsum\.photos|loremflickr\.com/i;

export function isStockPhoto(value: unknown): boolean {
  return typeof value === 'string' && STOCK_PHOTO.test(value);
}

/** A field holding a stock photo becomes null ("no image yet"); one in a list is dropped. */
export function withoutStockPhotos(value: unknown): unknown {
  if (isStockPhoto(value)) return null;
  if (Array.isArray(value)) return value.filter((v) => !isStockPhoto(v)).map(withoutStockPhotos);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutStockPhotos(v)]));
  }
  return value;
}
