import { Router, type Request, type Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validate, param } from '../middleware/validate';
import { createTaskSchema, updateTaskSchema, updateStatusSchema, taskQuerySchema, idParamSchema } from '../schemas';
import {
  listTasks,
  createTask,
  updateTask,
  updateTaskStatus,
  getTask,
} from '../services/task.service';
import type { TaskFilters } from '../services/task.service';

export const taskRouter = Router();

taskRouter.use(authenticate);

/**
 * Filters arrive as query parameters so a filtered view is a URL you can paste
 * to a colleague, and they are narrowed by the caller's scope inside the
 * service — passing ?assigneeId=<someone else> cannot widen what you see.
 */
taskRouter.get(
  '/',
  validate(taskQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const filters = req.query as unknown as TaskFilters;
    res.json({ tasks: await listTasks(req.user!, filters) });
  }),
);

taskRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getTask(req.user!, param(req, 'id')));
  }),
);

taskRouter.post(
  '/',
  requireRole('ADMIN', 'PROJECT_MANAGER'),
  validate(createTaskSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ task: await createTask(req.user!, req.body) });
  }),
);

taskRouter.patch(
  '/:id',
  requireRole('ADMIN', 'PROJECT_MANAGER'),
  validate(idParamSchema, 'params'),
  validate(updateTaskSchema),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ task: await updateTask(req.user!, param(req, 'id'), req.body) });
  }),
);

/**
 * Status transition. Deliberately open to all three roles: moving a task is the
 * one write a developer holds, and requireTaskAccess already limits them to
 * their own tasks. An admin or the owning PM may move anything in scope.
 */
taskRouter.patch(
  '/:id/status',
  validate(idParamSchema, 'params'),
  validate(updateStatusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await updateTaskStatus(req.user!, param(req, 'id'), req.body.status);
    res.json(result);
  }),
);
