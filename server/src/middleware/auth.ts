import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { Errors } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
    }
  }
}

/**
 * Verifies the bearer access token and attaches { id, role }.
 *
 * The role here is used only to short-circuit obvious denials. It is never the
 * basis for an ownership decision — those are always resolved against the
 * database in the service layer. See services/scope.ts.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(Errors.unauthorized('Missing bearer token'));
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) return next(Errors.unauthorized('Missing bearer token'));

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Route-level role gate. Composes after authenticate().
 *
 * This is a coarse filter ("developers may never create projects") and not a
 * substitute for row-level scoping — a PM passing this gate can still only
 * touch projects they own, which is enforced in the service layer.
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(Errors.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(Errors.forbidden('Your role cannot access this resource'));
    }
    next();
  };
}
