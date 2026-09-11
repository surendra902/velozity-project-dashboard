import { Router, type Request, type Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validate, param } from '../middleware/validate';
import {
  createProjectSchema,
  updateProjectSchema,
  createClientSchema,
  activityQuerySchema,
  idParamSchema,
} from '../schemas';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listClients,
  createClient,
} from '../services/project.service';
import { listActivity } from '../services/activity.service';
import { activityScope, requireProjectAccess } from '../services/scope';

export const projectRouter = Router();
export const clientRouter = Router();

// Every route below requires a session. Row-level filtering happens in the
// service layer via projectScope() — this is only the coarse gate.
projectRouter.use(authenticate);

projectRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ projects: await listProjects(req.user!) });
  }),
);

projectRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ project: await getProject(req.user!, param(req, 'id')) });
  }),
);

/** Per-project feed — the activity stream shown while viewing one project. */
projectRouter.get(
  '/:id/activity',
  validate(idParamSchema, 'params'),
  validate(activityQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.user!;
    // Confirms the actor may see this project at all (404 otherwise), then the
    // general activity scope narrows further for developers.
    const projectId = param(req, 'id');
    await requireProjectAccess(actor, projectId);

    const { since, limit } = req.query as unknown as { since?: Date; limit: number };
    const scope = activityScope(actor);

    const items = await listActivity({
      scopeWhere: { AND: [scope, { projectId }] },
      since,
      limit,
    });
    res.json({ items, serverTime: new Date().toISOString() });
  }),
);

// Only an admin or a PM may create; a PM's scope then limits it to their own.
projectRouter.post(
  '/',
  requireRole('ADMIN', 'PROJECT_MANAGER'),
  validate(createProjectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ project: await createProject(req.user!, req.body) });
  }),
);

projectRouter.patch(
  '/:id',
  requireRole('ADMIN', 'PROJECT_MANAGER'),
  validate(idParamSchema, 'params'),
  validate(updateProjectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ project: await updateProject(req.user!, param(req, 'id'), req.body) });
  }),
);

projectRouter.delete(
  '/:id',
  requireRole('ADMIN', 'PROJECT_MANAGER'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await deleteProject(req.user!, param(req, 'id')));
  }),
);

// Clients are read by anyone who can create a project (the create form needs
// the list); only an admin may add one.
clientRouter.use(authenticate);

clientRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ clients: await listClients() });
  }),
);

clientRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(createClientSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ client: await createClient(req.body) });
  }),
);
