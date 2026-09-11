import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validate } from '../middleware/validate';
import { Errors } from '../lib/errors';
import { loginSchema, registerSchema } from '../schemas';
import { REFRESH_COOKIE, refreshCookieOptions, clearRefreshCookieOptions } from '../lib/cookies';
import {
  verifyCredentials,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  registerUser,
  getPublicUserById,
  toPublicUser,
  ACCESS_TTL_FOR_CLIENT,
} from '../services/auth.service';

export const authRouter = Router();

/** Both login and refresh end here, so the cookie flags are set in exactly one place. */
function sendSession(res: Response, user: { id: string; email: string; name: string; role: string; teamId: string | null }, pair: { accessToken: string; refreshToken: string }) {
  res.cookie(REFRESH_COOKIE, pair.refreshToken, refreshCookieOptions);
  res.json({
    user,
    accessToken: pair.accessToken,
    expiresIn: ACCESS_TTL_FOR_CLIENT,
  });
}

authRouter.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = await registerUser(req.body);
    // Registering signs you in, so the client does not have to post twice.
    const full = await getPublicUserById(user.id);
    const pair = await issueTokenPair({
      id: full.id,
      email: full.email,
      name: full.name,
      role: full.role,
      teamId: full.teamId,
      passwordHash: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.status(201);
    sendSession(res, full, pair);
  }),
);

authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = await verifyCredentials(req.body.email, req.body.password);
    const pair = await issueTokenPair(user);
    sendSession(res, toPublicUser(user), pair);
  }),
);

/**
 * Exchanges the HttpOnly refresh cookie for a new access token.
 *
 * The client cannot read this cookie, which is the point: a stolen access token
 * expires in minutes and cannot be renewed without the cookie, and an XSS
 * payload cannot exfiltrate a long-lived credential.
 */
authRouter.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) throw Errors.invalidToken('No refresh token presented');

    try {
      const { user, pair } = await rotateRefreshToken(raw);
      sendSession(res, toPublicUser(user), pair);
    } catch (err) {
      // Clear on failure too — a token we just refused (expired, revoked, or a
      // detected replay) must not sit in the browser and be retried forever.
      res.clearCookie(REFRESH_COOKIE, clearRefreshCookieOptions);
      throw err;
    }
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    // Revoke server-side first: clearing the cookie alone would leave a valid
    // token alive for anyone who had already copied it.
    if (raw) await revokeRefreshToken(raw);
    res.clearCookie(REFRESH_COOKIE, clearRefreshCookieOptions);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ user: await getPublicUserById(req.user!.id) });
  }),
);
