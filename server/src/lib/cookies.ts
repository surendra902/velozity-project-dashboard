import type { CookieOptions } from 'express';
import { env, isProd } from '../config/env';

export const REFRESH_COOKIE = 'refresh_token';

/**
 * The refresh token lives in an HttpOnly cookie so JavaScript — including any
 * script injected via XSS — cannot read it. That is the whole reason the brief
 * forbids localStorage for this token.
 *
 * `path` is narrowed to the auth routes: the cookie is not attached to ordinary
 * API calls, which shrinks both its exposure and the CSRF surface.
 *
 * `sameSite: 'none'` is required in production because the frontend and API are
 * on different sites (Vercel/Render); it is only valid together with
 * `secure: true`. Locally, over http, 'lax' is used instead.
 */
export const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: isProd ? 'none' : 'lax',
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

/** Options for clearing the cookie — must match path/secure/sameSite to take effect. */
export const clearRefreshCookieOptions: CookieOptions = {
  httpOnly: refreshCookieOptions.httpOnly,
  secure: refreshCookieOptions.secure,
  sameSite: refreshCookieOptions.sameSite,
  path: refreshCookieOptions.path,
};
