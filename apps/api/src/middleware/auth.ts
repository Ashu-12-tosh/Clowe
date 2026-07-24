import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@clowe/shared';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';

// Attach the authenticated user's id/role to the request.
declare module 'express-serve-static-core' {
  interface Request {
    auth?: { userId: string; role: UserRole };
  }
}

/** Requires a valid Bearer access token. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return next(ApiError.unauthorized('Missing access token'));

  const payload = verifyAccessToken(token);
  if (!payload) return next(ApiError.unauthorized('Invalid or expired access token'));

  req.auth = { userId: payload.sub, role: payload.role };
  next();
}

/** Requires one of the given roles. Use after requireAuth. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(ApiError.forbidden(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}
