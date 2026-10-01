import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { ApiError } from '../utils/ApiError';
import { env } from '../env';

/** Central error handler — every route error funnels through here. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 5 MB' : err.message;
    return res.status(400).json({
      success: false,
      error: { code: 'UPLOAD_ERROR', message },
    });
  }

  // The name check is Zod's own advice for the case where two copies of the
  // class are loaded (the CJS shared package and an ESM import of zod, as
  // happens under vitest): a schema failure is a 400 whichever copy threw it.
  if (err instanceof ZodError || (err instanceof Error && err.name === 'ZodError')) {
    const first = (err as ZodError).issues[0];
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input',
      },
    });
  }

  console.error('[clowe-api] Unhandled error:', err);
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Something went wrong' : String(err),
    },
  });
}
