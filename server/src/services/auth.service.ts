import bcrypt from 'bcryptjs';
import type { Role, User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { signAccessToken, generateRefreshToken, hashRefreshToken, refreshExpiryDate } from '../lib/tokens';
import { env } from '../config/env';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
}

/** Never let passwordHash leave the service layer. */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    teamId: user.teamId,
  };
}

const BCRYPT_ROUNDS = 12;

export async function registerUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<PublicUser> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw Errors.conflict('An account with that email already exists');

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      // Public self-registration always yields the least-privileged role.
      // Admin and PM accounts are created by an admin via POST /api/users,
      // otherwise anyone could grant themselves ADMIN at signup.
      role: 'DEVELOPER',
    },
  });

  return toPublicUser(user);
}

/** Admin-only creation, where the role is caller-supplied and already validated. */
export async function createUser(input: {
  email: string;
  password: string;
  name: string;
  role: Role;
  teamId?: string | null;
}): Promise<PublicUser> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw Errors.conflict('An account with that email already exists');

  if (input.teamId) {
    const team = await prisma.team.findUnique({ where: { id: input.teamId } });
    if (!team) throw Errors.notFound('Team');
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      role: input.role,
      teamId: input.teamId ?? null,
    },
  });

  return toPublicUser(user);
}

export async function verifyCredentials(email: string, password: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });

  // Compare against a dummy hash when the user is absent so the response time
  // does not reveal whether an email is registered.
  if (!user) {
    await bcrypt.compare(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    throw Errors.unauthorized('Invalid email or password');
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw Errors.unauthorized('Invalid email or password');

  return user;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Issues a fresh access token and a new refresh-token row. */
export async function issueTokenPair(user: User): Promise<TokenPair> {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const { raw, hash } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt: refreshExpiryDate() },
  });

  return { accessToken, refreshToken: raw };
}

/**
 * Exchanges a refresh token for a new pair, with rotation and reuse detection.
 *
 * A refresh token is single-use. Presenting one that has already been rotated
 * means the value leaked or was replayed, so the entire token family for that
 * user is revoked and the session is force-ended — the standard defence, and
 * the reason refresh tokens are stored server-side at all rather than being
 * self-contained JWTs.
 */
export async function rotateRefreshToken(rawToken: string): Promise<{ user: User; pair: TokenPair }> {
  const tokenHash = hashRefreshToken(rawToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) throw Errors.invalidToken('Refresh token not recognised');

  if (stored.revokedAt) {
    // Replay of a rotated token: assume compromise, drop every live session.
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.warn(`[auth] refresh token reuse detected for user ${stored.userId}; all sessions revoked`);
    throw Errors.invalidToken('Refresh token has already been used');
  }

  if (stored.expiresAt.getTime() < Date.now()) {
    throw Errors.invalidToken('Refresh token expired');
  }

  const { raw, hash } = generateRefreshToken();

  const [, newToken] = await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: { userId: stored.userId, tokenHash: hash, expiresAt: refreshExpiryDate() },
    }),
  ]);

  // Link old -> new so the rotation chain is auditable.
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { replacedById: newToken.id },
  });

  return {
    user: stored.user,
    pair: {
      accessToken: signAccessToken({ sub: stored.userId, role: stored.user.role }),
      refreshToken: raw,
    },
  };
}

/** Revokes a single refresh token (logout on this device). Idempotent. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes every live session for a user (logout everywhere). */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getPublicUserById(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw Errors.unauthorized();
  return toPublicUser(user);
}

/** The assignee picker's list. Admins and PMs only — see the route. */
export async function listAssignableUsers(role?: string): Promise<PublicUser[]> {
  const users = await prisma.user.findMany({
    where: role ? { role: role as Role } : { role: { in: ['DEVELOPER', 'PROJECT_MANAGER'] } },
    orderBy: { name: 'asc' },
  });
  return users.map(toPublicUser);
}

export const ACCESS_TTL_FOR_CLIENT = env.ACCESS_TOKEN_TTL;
