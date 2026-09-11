import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { Errors } from './errors';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

/**
 * The access token carries only identity and role. It deliberately does NOT
 * carry ownership claims (which projects a PM owns, which tasks a developer
 * has) — those are always re-derived from the database, so a token that was
 * minted before a reassignment cannot grant stale access.
 */
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    if (typeof decoded.sub !== 'string' || typeof decoded.role !== 'string') {
      throw Errors.invalidToken();
    }
    return { sub: decoded.sub, role: decoded.role as Role };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw Errors.invalidToken('Access token expired');
    }
    throw Errors.invalidToken();
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they must be revocable
 * and single-use, and a stateless token cannot be either without a store
 * lookup anyway. Only the SHA-256 hash is persisted.
 */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(48).toString('hex');
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function refreshExpiryDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return d;
}
