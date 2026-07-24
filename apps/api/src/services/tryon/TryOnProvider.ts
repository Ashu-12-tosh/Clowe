export interface TryOnInput {
  /** Public URL of the customer's photo (may be a localhost /uploads URL in dev). */
  personImageUrl: string;
  /** Public URL of the garment/product image. */
  garmentImageUrl: string;
  /** Product title, for watermarks/logging. */
  productTitle: string;
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
}
