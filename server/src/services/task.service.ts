import type { Priority, Prisma, TaskStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { logActivity, getActorName } from './activity.service';
import { broadcastActivity, statusChangedMessage, humanize } from '../realtime/broadcast';
import {
  taskScope,
  requireTaskAccess,
  requireProjectAccess,
  canManageTask,
  type Actor,
} from './scope';
import { notify } from './notification.service';
import { resyncUserRooms } from '../realtime/io';

export interface TaskFilters {
  status?: TaskStatus;
  // Priority, not Prisma.PriorityFilter: these are the values a client may
  // filter ON, and a filter object (equals/in/not) would let a caller smuggle
  // a query operator into the where clause.
  priority?: Priority;
  dueFrom?: Date;
  dueTo?: Date;
  projectId?: string;
  assigneeId?: string;
}

/**
 * Builds the task `where` clause by ANDing the caller's scope with the filters.
 *
 * Filters can only narrow what the scope already permits — they can never
 * widen it, because the scope is the first term of the AND and Prisma has no
 * way to let a later term override an earlier one. That property is what makes
 * ?assigneeId=<someone-else> harmless for a developer.
 */
export function buildTaskWhere(actor: Actor, filters: TaskFilters): Prisma.TaskWhereInput {
  const terms: Prisma.TaskWhereInput[] = [taskScope(actor)];

  if (filters.status) terms.push({ status: filters.status });
  if (filters.priority) terms.push({ priority: filters.priority });
  if (filters.projectId) terms.push({ projectId: filters.projectId });
  if (filters.assigneeId) terms.push({ assigneeId: filters.assigneeId });

  if (filters.dueFrom || filters.dueTo) {
    terms.push({
      dueDate: {
        ...(filters.dueFrom ? { gte: filters.dueFrom } : {}),
        ...(filters.dueTo ? { lte: filters.dueTo } : {}),
      },
    });
  }

  return { AND: terms };
}

/**
 * Ordering is fixed per role rather than client-supplied: developers get the
 * brief's "priority then due date", everyone else gets newest-first. Exposing
 * a sort parameter would be a SQL-injection-adjacent surface for no gain.
 */
export async function listTasks(actor: Actor, filters: TaskFilters) {
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    actor.role === 'DEVELOPER'
      ? [{ priority: 'desc' }, { dueDate: 'asc' }]
      : [{ createdAt: 'desc' }];

  return prisma.task.findMany({
    where: buildTaskWhere(actor, filters),
    orderBy,
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, name: true } },
    },
  });
}

export async function createTask(
  actor: Actor,
  input: {
    title: string;
    description?: string;
    projectId: string;
    assigneeId?: string | null;
    priority?: Priority;
    dueDate?: Date | null;
  },
) {
  // Must be a project this actor may manage (admin: any, PM: own; a developer
  // passing this gate still fails, since projectScope(developer) only matches
  // projects they already hold a task in — and they have no route here anyway).
  const project = await requireProjectAccess(actor, input.projectId);

  if (input.assigneeId) {
    const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId } });
    if (!assignee) throw Errors.notFound('Assignee');
  }

  const task = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      projectId: input.projectId,
      assigneeId: input.assigneeId ?? null,
      priority: input.priority ?? 'MEDIUM',
      dueDate: input.dueDate ?? null,
    },
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, name: true } },
    },
  });

  const actorName = await getActorName(actor.id);
  const created = await logActivity({
    type: 'TASK_CREATED',
    message: `${actorName} created task "${task.title}"`,
    projectId: task.projectId,
    actorId: actor.id,
    taskId: task.id,
  });
  broadcastActivity(created, { projectOwnerId: project.createdById });

  if (task.assigneeId) {
    const assigned = await logActivity({
      type: 'TASK_ASSIGNED',
      message: `${actorName} assigned "${task.title}" to ${task.assignee?.name ?? 'a developer'}`,
      projectId: task.projectId,
      actorId: actor.id,
      taskId: task.id,
      toValue: task.assigneeId,
    });
    broadcastActivity(assigned, { projectOwnerId: project.createdById });

    await notify({
      userId: task.assigneeId,
      message: `You were assigned "${task.title}" in ${task.project.name}`,
      link: `/tasks/${task.id}`,
      activityId: assigned.id,
    });
  }

  return task;
}

/**
 * Edits everything except status — status has its own endpoint so the
 * transition, its audit row and its notifications are one unit.
 */
export async function updateTask(
  actor: Actor,
  taskId: string,
  input: {
    title?: string;
    description?: string;
    assigneeId?: string | null;
    priority?: Priority;
    dueDate?: Date | null;
  },
) {
  const task = await requireTaskAccess(actor, taskId);
  if (!canManageTask(actor, task)) {
    // A developer can reach their own task but may not reshuffle it.
    throw Errors.notFound('Task');
  }

  if (input.assigneeId) {
    const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId } });
    if (!assignee) throw Errors.notFound('Assignee');
  }

  const previousAssigneeId = task.assigneeId;
  const assigneeChanged =
    input.assigneeId !== undefined && input.assigneeId !== previousAssigneeId;

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      // Editing the due date may clear an overdue flag; the next cron tick
      // re-evaluates it rather than guessing here.
      ...(input.dueDate !== undefined ? { isOverdue: false } : {}),
    },
    include: {
      assignee: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, name: true, createdById: true } },
    },
  });

  const actorName = await getActorName(actor.id);
  const activity = await logActivity({
    type: assigneeChanged ? 'TASK_ASSIGNED' : 'TASK_UPDATED',
    message: assigneeChanged
      ? `${actorName} reassigned "${updated.title}" to ${updated.assignee?.name ?? 'nobody'}`
      : `${actorName} updated "${updated.title}"`,
    projectId: updated.projectId,
    actorId: actor.id,
    taskId: updated.id,
    fromValue: assigneeChanged ? previousAssigneeId : null,
    toValue: assigneeChanged ? updated.assigneeId : null,
  });
  broadcastActivity(activity, {
    projectOwnerId: updated.project.createdById,
    previousAssigneeId,
  });

  if (assigneeChanged && updated.assigneeId) {
    await notify({
      userId: updated.assigneeId,
      message: `You were assigned "${updated.title}" in ${updated.project.name}`,
      link: `/tasks/${updated.id}`,
      activityId: activity.id,
    });
  }

  // The previous assignee's feed was scoped to this task a moment ago; rebuild
  // their room membership now so it reflects the hand-off immediately.
  if (assigneeChanged && previousAssigneeId) {
    await resyncUserRooms(previousAssigneeId);
  }

  return updated;
}

/**
 * The status transition — the event the whole real-time feed exists to carry.
 *
 * Authorization differs by role here: a developer may move their own task
 * (that is the one write they are given) but only their own, enforced by
 * requireTaskAccess using the developer-scoped predicate.
 */
export async function updateTaskStatus(actor: Actor, taskId: string, next: TaskStatus) {
  const task = await requireTaskAccess(actor, taskId);

  if (task.status === next) {
    // No-op rather than a duplicate audit row: the brief wants a history of
    // changes, and "changed to what it already was" is not one.
    return { task, changed: false };
  }

  const previousStatus = task.status;
  const actorName = await getActorName(actor.id);

  // Task update and audit row commit together, so the feed can never be
  // missing a transition the database already applied.
  const [updated, activity] = await prisma.$transaction(async (tx) => {
    const nextTask = await tx.task.update({
      where: { id: taskId },
      data: { status: next },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, createdById: true } },
      },
    });

    const row = await logActivity({
      type: 'STATUS_CHANGED',
      message: statusChangedMessage({
        actorName,
        taskTitle: nextTask.title,
        from: previousStatus,
        to: next,
      }),
      projectId: nextTask.projectId,
      actorId: actor.id,
      taskId: nextTask.id,
      fromValue: previousStatus,
      toValue: next,
      client: tx,
    });

    return [nextTask, row] as const;
  });

  broadcastActivity(activity, { projectOwnerId: updated.project.createdById });

  // The PM is told when work lands in their review queue — unless they are the
  // one who moved it, in which case the notification would be noise.
  if (next === 'IN_REVIEW' && updated.project.createdById !== actor.id) {
    await notify({
      userId: updated.project.createdById,
      message: `${actorName} moved "${updated.title}" to In Review`,
      link: `/tasks/${updated.id}`,
      activityId: activity.id,
    });
  }

  return { task: updated, changed: true };
}

export async function getTask(actor: Actor, taskId: string) {
  const task = await requireTaskAccess(actor, taskId);
  const history = await prisma.activityLog.findMany({
    where: { taskId },
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { id: true, name: true, role: true } } },
  });
  return { task, history };
}

export { humanize };
