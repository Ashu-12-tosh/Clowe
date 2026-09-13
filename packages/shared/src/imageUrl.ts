import { z } from 'zod';

/**
 * Image URL accepted by admin/seller forms: an absolute http(s) URL, or a
 * root-relative path under our own `/uploads` (how the seeded demo catalog
 * references its locally stored placeholder images). Relative paths may use
 * sub-folders but never `..` segments.
 */
const UPLOADS_PATH = /^\/uploads\/(?!(?:.*\/)?\.\.(?:\/|$))[\w./-]+$/;

export const imageUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => (v.startsWith('/uploads/') ? UPLOADS_PATH.test(v) : z.string().url().safeParse(v).success), {
    message: 'Invalid url',
  });
