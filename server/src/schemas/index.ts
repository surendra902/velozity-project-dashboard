import { z } from 'zod';

/**
 * Every request body and query string is validated here before a controller
 * sees it. Shapes are declared once and reused, so a field added to a resource
 * cannot be silently accepted by one endpoint and rejected by another.
 */

const cuid = z.string().min(1, 'Required');
const dateish = z.coerce.date();

export const roleSchema = z.enum(['ADMIN', 'PROJECT_MANAGER', 'DEVELOPER']);
export const taskStatusSchema = z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']);
export const prioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

// ---- auth ----

export const loginSchema = z.object({
  email: z.string().email('Must be a valid email'),
  // Length only on login: the stored hash is the real authority, and rejecting
  // on composition here would leak the password policy.
  password: z.string().min(1, 'Password is required'),
});

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  email: z.string().email('Must be a valid email').max(200),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password is too long'),
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  role: roleSchema,
  teamId: cuid.nullish(),
});

// ---- projects & clients ----

export const createProjectSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(160),
  description: z.string().max(2000).optional(),
  clientId: cuid,
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    clientId: cuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const createClientSchema = z.object({
  name: z.string().trim().min(2).max(160),
});

// ---- tasks ----

export const createTaskSchema = z.object({
  title: z.string().trim().min(2, 'Title must be at least 2 characters').max(200),
  description: z.string().max(5000).optional(),
  projectId: cuid,
  assigneeId: cuid.nullish(),
  status: taskStatusSchema.optional(),
  priority: prioritySchema.optional(),
  dueDate: dateish.nullish(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    assigneeId: cuid.nullish(),
    priority: prioritySchema.optional(),
    dueDate: dateish.nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const updateStatusSchema = z.object({
  status: taskStatusSchema,
});

/**
 * Task list filters. These exist so a filtered view is a shareable URL.
 *
 * Empty strings are coerced to undefined: a URL of `?status=&priority=` is what
 * a browser sends when a select is cleared, and it should mean "no filter"
 * rather than failing validation.
 */
const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

/**
 * A due-date range arrives from a date input as `YYYY-MM-DD` and means *the
 * day*, not the instant midnight. Coercing both ends to midnight puts every
 * task due later that day outside `lte: dueTo`, so "due 12 Sep" would vanish
 * from a "from 12 Sep to 12 Sep" filter. `dueFrom` keeps midnight; `dueTo`
 * is pushed to the last millisecond of the day.
 *
 * Only bare dates are widened — a caller passing a full ISO timestamp is
 * asking for that instant and gets it.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const endOfDay = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return new Date(new Date(`${v}T00:00:00.000Z`).getTime() + DAY_MS - 1);
};

export const taskQuerySchema = z.object({
  status: z.preprocess(emptyToUndefined, taskStatusSchema.optional()),
  priority: z.preprocess(emptyToUndefined, prioritySchema.optional()),
  projectId: z.preprocess(emptyToUndefined, cuid.optional()),
  assigneeId: z.preprocess(emptyToUndefined, cuid.optional()),
  dueFrom: z.preprocess(emptyToUndefined, dateish.optional()),
  dueTo: z.preprocess((v) => endOfDay(emptyToUndefined(v)), dateish.optional()),
});

export const activityQuerySchema = z.object({
  // ISO timestamp cursor for missed-event catch-up.
  since: z.preprocess(emptyToUndefined, dateish.optional()),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const idParamSchema = z.object({ id: cuid });
