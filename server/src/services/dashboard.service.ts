import { prisma } from '../lib/prisma';
import { projectScope, taskScope, type Actor } from './scope';
import { onlineUserCount } from '../realtime/io';

/**
 * Dashboard aggregates.
 *
 * The three roles get genuinely different shapes because the brief asks for
 * different things — not one payload with fields hidden on the client. Every
 * query is scoped with the same predicates the REST layer uses, so a dashboard
 * can never summarise rows the caller could not have fetched directly.
 */

export async function adminDashboard() {
  const now = new Date();
  const [totalProjects, totalTasks, byStatus, overdueCount, recentActivity] = await Promise.all([
    prisma.project.count(),
    prisma.task.count(),
    prisma.task.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.task.count({ where: { isOverdue: true } }),
    prisma.activityLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        actor: { select: { id: true, name: true, role: true } },
        task: { select: { id: true, title: true, assigneeId: true } },
      },
    }),
  ]);

  return {
    role: 'ADMIN' as const,
    totalProjects,
    totalTasks,
    activeUsersOnline: onlineUserCount(),
    overdueCount,
    generatedAt: now.toISOString(),
    tasksByStatus: toStatusMap(byStatus),
    recentActivity,
  };
}

export async function pmDashboard(actor: Actor) {
  const scope = projectScope(actor);
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [projects, byPriority, upcoming, byStatus, overdueCount] = await Promise.all([
    prisma.project.findMany({
      where: scope,
      include: { client: { select: { id: true, name: true } }, _count: { select: { tasks: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.task.groupBy({
      by: ['priority'],
      where: taskScope(actor),
      _count: { _all: true },
    }),
    // Due within the coming week, not yet done.
    prisma.task.findMany({
      where: {
        AND: [
          taskScope(actor),
          { dueDate: { gte: now, lte: weekFromNow } },
          { status: { not: 'DONE' } },
        ],
      },
      orderBy: { dueDate: 'asc' },
      include: {
        assignee: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    }),
    prisma.task.groupBy({
      by: ['status'],
      where: taskScope(actor),
      _count: { _all: true },
    }),
    prisma.task.count({ where: { AND: [taskScope(actor), { isOverdue: true }] } }),
  ]);

  return {
    role: 'PROJECT_MANAGER' as const,
    projects,
    tasksByPriority: toCountMap(byPriority, 'priority'),
    tasksByStatus: toStatusMap(byStatus),
    upcomingDueThisWeek: upcoming,
    overdueCount,
    generatedAt: now.toISOString(),
  };
}

export async function developerDashboard(actor: Actor) {
  const scope = taskScope(actor);

  const [tasks, byStatus, overdueCount] = await Promise.all([
    prisma.task.findMany({
      where: scope,
      // The brief's ordering for this role: priority, then due date.
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      include: { project: { select: { id: true, name: true } } },
    }),
    prisma.task.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.task.count({ where: { AND: [scope, { isOverdue: true }] } }),
  ]);

  return {
    role: 'DEVELOPER' as const,
    tasks,
    tasksByStatus: toStatusMap(byStatus),
    overdueCount,
    generatedAt: new Date().toISOString(),
  };
}

export function dashboardFor(actor: Actor) {
  if (actor.role === 'ADMIN') return adminDashboard();
  if (actor.role === 'PROJECT_MANAGER') return pmDashboard(actor);
  return developerDashboard(actor);
}

type Grouped<T extends string> = { _count: { _all: number } } & Record<T, string>;

/** Prisma omits statuses with no rows; the UI wants every key present. */
function toStatusMap(rows: Grouped<'status'>[]) {
  const base = { TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 0, DONE: 0 } as Record<string, number>;
  for (const row of rows) base[row.status] = row._count._all;
  return base;
}

function toCountMap<T extends string>(rows: Grouped<T>[], key: T) {
  const out: Record<string, number> = {};
  for (const row of rows) out[row[key]] = row._count._all;
  return out;
}
