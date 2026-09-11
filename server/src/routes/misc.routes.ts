import { Router, type Request, type Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validate, param } from '../middleware/validate';
import { activityQuerySchema, createUserSchema, idParamSchema } from '../schemas';
import { activityScope } from '../services/scope';
import { listActivity, unreadCount } from '../services/activity.service';
import { createUser } from '../services/auth.service';
import { prisma } from '../lib/prisma';
import { listNotifications, markRead, markAllRead } from '../services/notification.service';
import { dashboardFor } from '../services/dashboard.service';

export const activityRouter = Router();
export const notificationRouter = Router();
export const userRouter = Router();
export const dashboardRouter = Router();

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

activityRouter.use(authenticate);

/**
 * The feed, and the catch-up endpoint in one.
 *
 * With no `since` this is the initial page of the feed. With `since=<ISO>` it
 * returns what happened while the client was disconnected — read from the
 * database, not from a server-side buffer of recent events, because a buffer
 * dies with the process and a user who was away longer than the buffer holds
 * would silently miss history.
 *
 * The scope predicate is the same one that decides socket room membership, so
 * what arrives live and what this returns cannot disagree.
 */
activityRouter.get(
  '/',
  validate(activityQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { since, limit } = req.query as unknown as { since?: Date; limit: number };
    const items = await listActivity({
      scopeWhere: activityScope(req.user!),
      since,
      limit,
    });
    res.json({
      items,
      // Echoed so the client can send it back as the next `since` without
      // relying on its own clock, which may be skewed.
      serverTime: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// Notifications — always personal, never role-scoped
// ---------------------------------------------------------------------------

notificationRouter.use(authenticate);

notificationRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const [notifications, count] = await Promise.all([
      listNotifications(userId),
      unreadCount(userId),
    ]);
    res.json({ notifications, unreadCount: count });
  }),
);

notificationRouter.patch(
  '/:id/read',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await markRead(req.user!.id, param(req, 'id')));
  }),
);

notificationRouter.post(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await markAllRead(req.user!.id));
  }),
);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

userRouter.use(authenticate);

/**
 * The assignee picker needs the developer list. Available to admins and PMs
 * (the only roles that assign work); a developer has no reason to enumerate
 * staff and is refused.
 */
userRouter.get(
  '/',
  requireRole('ADMIN', 'PROJECT_MANAGER'),
  asyncHandler(async (req: Request, res: Response) => {
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;
    const users = await prisma.user.findMany({
      where: role ? { role: role as never } : { role: { in: ['DEVELOPER', 'PROJECT_MANAGER'] } },
      select: { id: true, name: true, email: true, role: true, teamId: true },
      orderBy: { name: 'asc' },
    });
    res.json({ users });
  }),
);

/** Admin-only: creating an account with a privileged role. */
userRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ user: await createUser(req.body) });
  }),
);

// ---------------------------------------------------------------------------
// Dashboards — one route, three genuinely different payloads
// ---------------------------------------------------------------------------

dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ dashboard: await dashboardFor(req.user!) });
  }),
);
