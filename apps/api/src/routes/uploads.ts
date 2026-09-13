import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { uploadLimiter } from '../middleware/rateLimits';

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
 * Content sniffing: verify the file's magic bytes actually match an allowed
 * image format (the client-supplied MIME type is trivially spoofable).
 */
function isRealImage(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true; // JPEG
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return true; // PNG
    if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP')
      return true; // WebP
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Upload up to 6 images; returns their public URLs.
// Local disk in dev — swapped for S3-compatible storage at deploy time.
uploadsRouter.post('/', requireAuth, uploadLimiter, upload.array('images', 6), (req, res) => {
  const files = (req.files ?? []) as Express.Multer.File[];
  if (files.length === 0) {
    throw ApiError.badRequest('No images uploaded. Use multipart field name "images".');
  }
  // Reject files whose bytes don't match a real image format.
  const fakes = files.filter((f) => !isRealImage(f.path));
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
// Packing videos (sellers) — one clip per listing, kept for 10 days.
// ---------------------------------------------------------------------------

const VIDEO_ALLOWED = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
]);

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const ext = VIDEO_ALLOWED.get(file.mimetype) ?? '.bin';
      cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB per video
  fileFilter: (_req, file, cb) => {
    if (VIDEO_ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new ApiError(400, 'INVALID_FILE_TYPE', 'Only MP4, WebM or MOV videos are allowed'));
  },
});

/** Magic-byte check: MP4/MOV carry "ftyp" at offset 4, WebM starts with the EBML header. */
function isRealVideo(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (header.subarray(4, 8).toString('ascii') === 'ftyp') return true; // MP4 / MOV
    if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true; // WebM
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Upload one packing video; returns its public URL.
uploadsRouter.post('/video', requireAuth, uploadLimiter, videoUpload.single('video'), (req, res) => {
  const file = req.file;
  if (!file) {
    throw ApiError.badRequest('No video uploaded. Use multipart field name "video".');
  }
  if (!isRealVideo(file.path)) {
    fs.unlink(file.path, () => {});
    throw ApiError.badRequest('That file is not a valid video', 'INVALID_FILE_CONTENT');
  }
  res.json({ success: true, data: { url: `${env.API_PUBLIC_URL}/uploads/${file.filename}` } });
});

/** Best-effort delete of a local upload by its public URL (used by video expiry). */
export function removeUploadByUrl(url: string): void {
  const name = url.split('/uploads/')[1];
  // Refuse anything that is not a plain filename (no traversal, no separators).
  if (!name || path.basename(name) !== name || name.includes('..')) return;
  fs.unlink(path.join(uploadDir, name), () => {});
}
