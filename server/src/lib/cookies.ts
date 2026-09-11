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
 * `sameSite` follows the origin split rather than NODE_ENV. In the deployed
 * shape the SPA is served by this same Express process, so the cookie is
 * first-party and 'lax' is correct and stronger. 'none' is only needed when a
 * separate frontend origin is configured via CORS_ORIGIN — it is the weaker
 * setting, since it lets the browser attach this cookie to cross-site requests.
 * It also requires `secure: true`, which would otherwise be silently dropped.
 */
export const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  // 'lax' unconditionally: the SPA is served from this same origin in
  // production and proxied to it in dev, so the cookie is first-party in both.
  // A cross-origin frontend would need 'none' — the weaker setting — which this
  // deploy deliberately does not have. See the note above.
  sameSite: 'lax',
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
