/** Garment category hint the try-on model accepts. */
export type TryOnGarmentCategory = 'auto' | 'tops' | 'bottoms' | 'one-pieces';

export interface TryOnInput {
  /** Public URL of the customer's photo (may be a localhost /uploads URL in dev). */
  personImageUrl: string;
  /** Public URL of the garment/product image. */
  garmentImageUrl: string;
  /** Product title, for watermarks/logging. */
  productTitle: string;
  /**
   * What kind of garment this is. Narrows the model's own classifier; omit or
   * pass 'auto' when the product's category does not map cleanly.
   */
  garmentCategory?: TryOnGarmentCategory;
}

/**
 * A try-on failure with two audiences: `message` is shown to the shopper and
 * must be plain and actionable, `detail` is kept for the admin monitor and may
 * carry upstream status codes, prediction ids and raw provider text.
 *
 * Anything thrown that is *not* a TryOnError is treated as an internal fault
 * and never shown verbatim to a customer.
 */
export class TryOnError extends Error {
  readonly detail: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'TryOnError';
    this.detail = detail ?? message;
  }
}

/**
 * Provider-agnostic virtual try-on interface.
 * Implementations: MockTryOnProvider (free, dev), FashnTryOnProvider (fashn.ai).
 */
export interface TryOnProvider {
  readonly name: string;
  /** Cost logged per successful try-on (paise) — for accounting. */
  readonly costPaise: number;
  /** Generate the try-on image; returns a public URL of the result. */
  generate(input: TryOnInput): Promise<string>;
  /** Optional credentials/reachability probe used at startup and by tryon:check. */
  verifyCredentials?(): Promise<{ ok: boolean; detail: string }>;
}
