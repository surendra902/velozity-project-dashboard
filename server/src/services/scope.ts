import type { Prisma, Role } from '@prisma/client';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';

export interface Actor {
  id: string;
  role: Role;
}

/**
 * THE authorization choke point.
 *
 * Every read and write of a project, task or activity row is narrowed through
 * one of these predicates before it reaches Prisma. Because the filter is a
 * `where` clause rather than a post-fetch check, an unauthorised row is never
 * loaded into memory at all, and the same expression works whether the caller
 * is listing (findMany), reading one (findFirst) or mutating (updateMany).
 *
 * Scope is always derived from the database. A token's role picks the branch;
 * nothing else in the token is trusted.
 */

export function projectScope(actor: Actor): Prisma.ProjectWhereInput {
  switch (actor.role) {
    case 'ADMIN':
      return {};
    case 'PROJECT_MANAGER':
      // A PM sees only projects they created — never another PM's.
      return { createdById: actor.id };
    case 'DEVELOPER':
      // A developer sees a project only if at least one task in it is theirs.
      return { tasks: { some: { assigneeId: actor.id } } };
  }
}

export function taskScope(actor: Actor): Prisma.TaskWhereInput {
  switch (actor.role) {
    case 'ADMIN':
      return {};
    case 'PROJECT_MANAGER':
      return { project: { createdById: actor.id } };
    case 'DEVELOPER':
      return { assigneeId: actor.id };
  }
}

export function activityScope(actor: Actor): Prisma.ActivityLogWhereInput {
  switch (actor.role) {
    case 'ADMIN':
      return {};
    case 'PROJECT_MANAGER':
      return { project: { createdById: actor.id } };
    case 'DEVELOPER':
      // Activity attached to tasks assigned to them. Activity with no task
      // (project-level events) is therefore invisible to developers.
      return { task: { assigneeId: actor.id } };
  }
}

export function notificationScope(actor: Actor): Prisma.NotificationWhereInput {
  // Notifications are always personal.
  return { userId: actor.id };
}

/**
 * Loads a project the actor is allowed to see, or throws 404.
 *
 * 404 rather than 403 on purpose: answering "forbidden" would confirm that a
 * project with that id exists, which lets a developer enumerate a PM's
 * portfolio by probing ids.
 */
export async function requireProjectAccess(actor: Actor, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectScope(actor)] },
    include: { client: true },
  });
  if (!project) throw Errors.notFound('Project');
  return project;
}

/** Loads a task the actor is allowed to see, or throws 404. */
export async function requireTaskAccess(actor: Actor, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskScope(actor)] },
    include: {
      project: { select: { id: true, name: true, createdById: true } },
      assignee: { select: { id: true, name: true, email: true } },
    },
  });
  if (!task) throw Errors.notFound('Task');
  return task;
}

/** True when the actor may mutate the given task's assignment/priority/due date. */
export function canManageTask(actor: Actor, task: { project: { createdById: string } }): boolean {
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'PROJECT_MANAGER') return task.project.createdById === actor.id;
  return false; // developers may only change status, and only on their own tasks
}
