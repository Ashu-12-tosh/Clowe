import path from 'node:path';
import { Router } from 'express';
import { localFiles } from '../services/storage';
import { verifyLocalFile } from '../services/storage/LocalStorageProvider';

const CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * Locally stored private files, by signed URL only. The signature (made when
 * an authorised endpoint resolved the reference) is the permission: no
 * session is needed, which is what lets an <img> or <video> tag load it, and
 * it expires within minutes.
 */
export const filesRouter = Router();

filesRouter.get('/local', (req, res) => {
  const { k, e, s } = req.query;
  if (!verifyLocalFile(k, e, s)) {
    res.status(403).json({ success: false, error: { code: 'LINK_EXPIRED', message: 'This link has expired' } });
    return;
  }
  const key = k as string;
  const remaining = Math.max(0, Number(e) - Math.floor(Date.now() / 1000));
  res.sendFile(localFiles.pathFor(key), {
    dotfiles: 'deny',
    headers: {
      'Content-Type': CONTENT_TYPE[path.extname(key)] ?? 'application/octet-stream',
      'Cache-Control': `private, max-age=${remaining}`,
      // Opened on its own, a file renders as nothing but itself: no script,
      // no forms, no plugins — an SVG in particular.
      'Content-Security-Policy': "default-src 'none'; img-src data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    },
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
});
