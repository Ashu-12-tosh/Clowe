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
