import { z } from 'zod';

// ---------------------------------------------------------------------------
// Private files are referred to as "asset:<id>", never by URL.
//
// The upload endpoints hand back a reference and a short-lived URL to preview
// it. Forms send the reference; the database stores it; and the API turns it
// into a fresh signed URL for each viewer it has already authorised. A URL a
// browser holds therefore stops working within minutes, and nobody can point
// a return photo or a try-on photo at a file they did not upload.
// ---------------------------------------------------------------------------

export const ASSET_PURPOSES = ['RETURN_PHOTO', 'TRYON_PHOTO', 'TRYON_RESULT', 'PACKING_VIDEO'] as const;
export type AssetPurposeValue = (typeof ASSET_PURPOSES)[number];

/** Purposes a client may upload directly (results are written by the server). */
export const UPLOADABLE_IMAGE_PURPOSES = ['RETURN_PHOTO', 'TRYON_PHOTO'] as const;
export type UploadableImagePurpose = (typeof UPLOADABLE_IMAGE_PURPOSES)[number];

const ASSET_REF = /^asset:(c[a-z0-9]{20,40})$/;

export function isAssetRef(value: unknown): value is string {
  return typeof value === 'string' && ASSET_REF.test(value);
}

/** The asset id inside a reference, or null if it is not one. */
export function assetIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return ASSET_REF.exec(value)?.[1] ?? null;
}

export function assetRef(id: string): string {
  return `asset:${id}`;
}

export const assetRefSchema = z.string().trim().refine(isAssetRef, { message: 'Upload the file again' });

/** What a private upload returns: the reference to submit, and a URL to preview it now. */
export interface UploadedAsset {
  ref: string;
  url: string;
}
