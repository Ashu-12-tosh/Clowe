import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { UPLOADABLE_IMAGE_PURPOSES, type UploadedAsset } from '@clowe/shared';
import { env } from '../env';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { uploadLimiter } from '../middleware/rateLimits';
import { deleteFileRef, resolveFileUrl, storePrivateFile } from '../services/assets';

export const uploadDir = path.resolve(env.UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const ext = ALLOWED.get(file.mimetype) ?? '.bin';
      cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 }, // 5 MB per image
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, 'INVALID_FILE_TYPE', 'Only JPG, PNG, or WebP images are allowed'));
  },
});

export const uploadsRouter = Router();

/**
 * Content sniffing: the format the file's magic bytes say it is, or null if
 * it is not an allowed image (the client-supplied MIME type is trivially
 * spoofable).
 */
function imageTypeOf(header: Buffer): string | null {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function readHeader(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    return header;
  } finally {
    fs.closeSync(fd);
  }
}

// Upload up to 6 public images (catalog, store logo/banner, avatar); returns
// their public URLs. Anything personal goes through /private instead.
uploadsRouter.post('/', requireAuth, uploadLimiter, upload.array('images', 6), (req, res) => {
  const files = (req.files ?? []) as Express.Multer.File[];
  if (files.length === 0) {
    throw ApiError.badRequest('No images uploaded. Use multipart field name "images".');
  }
  // Reject files whose bytes don't match a real image format.
  const fakes = files.filter((f) => !imageTypeOf(readHeader(f.path)));
  if (fakes.length > 0) {
    for (const f of files) fs.unlink(f.path, () => {});
    throw ApiError.badRequest('One or more files are not valid images', 'INVALID_FILE_CONTENT');
  }
  res.json({
    success: true,
    data: { urls: files.map((f) => `${env.API_PUBLIC_URL}/uploads/${f.filename}`) },
  });
});

// ---------------------------------------------------------------------------
// Private files: held in memory until checked, then stored privately. Nothing
// here ever touches the public uploads folder.
// ---------------------------------------------------------------------------

const privateImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, 'INVALID_FILE_TYPE', 'Only JPG, PNG, or WebP images are allowed'));
  },
});

/**
 * Personal photos: a return's damage photos, a shopper's try-on photo. The
 * multipart field `purpose` says which. Returns, for each, a reference to
 * submit and a short-lived URL to preview it.
 */
uploadsRouter.post('/private', requireAuth, uploadLimiter, privateImageUpload.array('images', 3), async (req, res, next) => {
  try {
    const purpose = req.body?.purpose;
    if (!(UPLOADABLE_IMAGE_PURPOSES as readonly string[]).includes(purpose)) {
      throw ApiError.badRequest('Say what the photo is for', 'INVALID_PURPOSE');
    }
    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) throw ApiError.badRequest('No images uploaded. Use multipart field name "images".');
    const types = files.map((f) => imageTypeOf(f.buffer.subarray(0, 12)));
    if (types.some((t) => t === null)) {
      throw ApiError.badRequest('One or more files are not valid images', 'INVALID_FILE_CONTENT');
    }
    const items: UploadedAsset[] = [];
    for (const [i, file] of files.entries()) {
      const stored = await storePrivateFile({ purpose, ownerId: req.auth!.userId, body: file.buffer, contentType: types[i]! });
      items.push({ ref: stored.ref, url: (await resolveFileUrl(stored.ref))! });
    }
    res.json({ success: true, data: { items } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Packing videos (sellers) — one clip per listing, kept for 10 days. Private.
// ---------------------------------------------------------------------------

const VIDEO_ALLOWED = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB per video
  fileFilter: (_req, file, cb) => {
    if (VIDEO_ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, 'INVALID_FILE_TYPE', 'Only MP4, WebM or MOV videos are allowed'));
  },
});

/** Magic-byte check: MP4/MOV carry "ftyp" at offset 4, WebM starts with the EBML header. */
function videoTypeOf(header: Buffer, declared: string): string | null {
  if (header.subarray(4, 8).toString('ascii') === 'ftyp') {
    return declared === 'video/quicktime' ? 'video/quicktime' : 'video/mp4';
  }
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null;
}

// Upload one packing video; returns a reference to submit and a preview URL.
uploadsRouter.post(
  '/video',
  requireAuth,
  requireRole('SELLER'),
  uploadLimiter,
  videoUpload.single('video'),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) throw ApiError.badRequest('No video uploaded. Use multipart field name "video".');
      const contentType = videoTypeOf(file.buffer.subarray(0, 12), file.mimetype);
      if (!contentType) throw ApiError.badRequest('That file is not a valid video', 'INVALID_FILE_CONTENT');
      const stored = await storePrivateFile({
        purpose: 'PACKING_VIDEO',
        ownerId: req.auth!.userId,
        body: file.buffer,
        contentType,
      });
      const body: UploadedAsset = { ref: stored.ref, url: (await resolveFileUrl(stored.ref))! };
      res.json({ success: true, data: body });
    } catch (err) {
      next(err);
    }
  },
);

/** Best-effort delete of a public upload by its URL (files from before private storage). */
export function removeUploadByUrl(url: string): void {
  const name = url.split('/uploads/')[1];
  // Refuse anything that is not a plain filename (no traversal, no separators).
  if (!name || path.basename(name) !== name || name.includes('..')) return;
  fs.unlink(path.join(uploadDir, name), () => {});
}

/** Delete a stored file: a private asset reference, or an older public upload URL. */
export async function removeStoredFile(value: string): Promise<void> {
  if (!(await deleteFileRef(value))) removeUploadByUrl(value);
}
