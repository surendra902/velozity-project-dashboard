import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { logActivity, getActorName } from './activity.service';
import { broadcastActivity, humanize } from '../realtime/broadcast';
import { projectScope, type Actor } from './scope';
import type { Prisma } from '@prisma/client';

export async function listProjects(actor: Actor) {
  return prisma.project.findMany({
    where: projectScope(actor),
    orderBy: { createdAt: 'desc' },
    include: {
      client: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      _count: { select: { tasks: true } },
    },
  });
}

export async function getProject(actor: Actor, projectId: string) {
  // Scoped find: an unauthorised id yields null and becomes a 404, so a
  // developer probing ids cannot tell a real project from a nonexistent one.
  const project = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectScope(actor)] },
    include: {
      client: true,
      createdBy: { select: { id: true, name: true } },
      tasks: {
        include: { assignee: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!project) throw Errors.notFound('Project');
  return project;
}

export async function createProject(
  actor: Actor,
  input: { name: string; description?: string; clientId: string },
) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) throw Errors.notFound('Client');

  const project = await prisma.project.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      clientId: input.clientId,
      // Ownership is taken from the authenticated user, never from the request
      // body — otherwise a PM could create a project owned by someone else.
      createdById: actor.id,
    },
    include: { client: true },
  });

  const activity = await logActivity({
    type: 'PROJECT_CREATED',
    message: `${(await getActorName(actor.id))} created project "${project.name}"`,
    projectId: project.id,
    actorId: actor.id,
  });
  broadcastActivity(activity, { projectOwnerId: project.createdById });

  return project;
}

export async function updateProject(
  actor: Actor,
  projectId: string,
  input: { name?: string; description?: string; clientId?: string },
) {
  const existing = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectScope(actor)] },
  });
  if (!existing) throw Errors.notFound('Project');

  if (input.clientId) {
    const client = await prisma.client.findUnique({ where: { id: input.clientId } });
    if (!client) throw Errors.notFound('Client');
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    },
    include: { client: true },
  });

  const activity = await logActivity({
    type: 'PROJECT_UPDATED',
    message: `${await getActorName(actor.id)} updated project "${project.name}"`,
    projectId: project.id,
    actorId: actor.id,
  });
  broadcastActivity(activity, { projectOwnerId: project.createdById });

  return project;
}

export async function deleteProject(actor: Actor, projectId: string) {
  const existing = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectScope(actor)] },
  });
  if (!existing) throw Errors.notFound('Project');

  await prisma.project.delete({ where: { id: projectId } });
  return { id: projectId };
}

export async function listClients() {
  return prisma.client.findMany({ orderBy: { name: 'asc' } });
}

export async function createClient(input: { name: string }) {
  return prisma.client.create({ data: { name: input.name } });
}

export type ProjectListFilter = Prisma.ProjectWhereInput;
export { humanize };
