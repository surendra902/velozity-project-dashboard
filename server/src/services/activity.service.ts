import type { ActivityType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface LogActivityInput {
  type: ActivityType;
  message: string;
  projectId: string;
  actorId: string;
  taskId?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  client?: Prisma.TransactionClient;
}

export type ActivityWithActor = Prisma.ActivityLogGetPayload<{
  include: {
    actor: { select: { id: true; name: true; role: true } };
    task: { select: { id: true; title: true; assigneeId: true } };
  };
}>;

/**
 * Writes one activity row.
 *
 * Accepts an optional transaction client so a status change and its log entry
 * commit together — a task update that succeeded while its audit row failed
 * would leave the feed permanently missing an event, and the brief is explicit
 * that this history must be stored, not derived.
 *
 * This function does NOT emit over the socket. Emitting is the caller's job
 * (see activity.broadcast) so it happens once per logical event rather than
 * per row, and never from inside a transaction that might still roll back.
 */
export async function logActivity(
  input: LogActivityInput,
): Promise<ActivityWithActor> {
  const db = input.client ?? prisma;

  return db.activityLog.create({
    data: {
      type: input.type,
      message: input.message,
      projectId: input.projectId,
      actorId: input.actorId,
      taskId: input.taskId ?? null,
      fromValue: input.fromValue ?? null,
      toValue: input.toValue ?? null,
    },
    include: {
      actor: { select: { id: true, name: true, role: true } },
      task: { select: { id: true, title: true, assigneeId: true } },
    },
  });
}

/**
 * Shapes a row for the wire.
 *
 * `createdAt` goes out as an ISO string and the human phrasing is composed on
 * the client: a server-rendered "2 mins ago" is stale by the time it renders.
 * The message text is static ("moved this task from X to Y"); only the relative
 * time is computed at display time.
 */
export function serializeActivity(row: ActivityWithActor) {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    projectId: row.projectId,
    taskId: row.taskId,
    taskTitle: row.task?.title ?? null,
    fromValue: row.fromValue,
    toValue: row.toValue,
    createdAt: row.createdAt.toISOString(),
    actor: { id: row.actor.id, name: row.actor.name, role: row.actor.role },
  };
}

/**
 * The feed query. `scopeWhere` is always the output of activityScope(actor) —
 * the same predicate used to decide which socket rooms the user is in, which
 * is what guarantees live and catch-up feeds agree.
 */
export async function listActivity(opts: {
  scopeWhere: Prisma.ActivityLogWhereInput;
  since?: Date;
  limit: number;
}) {
  const where: Prisma.ActivityLogWhereInput = opts.since
    ? { AND: [opts.scopeWhere, { createdAt: { gt: opts.since } }] }
    : opts.scopeWhere;

  const rows = await prisma.activityLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: opts.limit,
    include: {
      actor: { select: { id: true, name: true, role: true } },
      task: { select: { id: true, title: true, assigneeId: true } },
    },
  });

  // Newest-first is right for a feed, but a catch-up batch should be applied
  // oldest-first so the client's list stays chronological.
  const items = opts.since ? rows.reverse() : rows;
  return items.map(serializeActivity);
}

/** Unread notification count for the badge. */
export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

/**
 * Display name for an actor, so feed lines read "Ravi moved ..." instead of
 * "user_cm3k... moved ...". Shared by the task and project services.
 */
export async function getActorName(id: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id }, select: { name: true } });
  return user?.name ?? 'Someone';
}
