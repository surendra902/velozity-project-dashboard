import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { Errors } from '../lib/errors';

type Source = 'body' | 'query' | 'params';

/**
 * Server-side validation for every input the API accepts. Applied at the route
 * so a controller can treat req.body/query as already-correct.
 *
 * Parsed output is written back onto the request: query values arrive as
 * strings and are coerced, so controllers read numbers/booleans, not strings.
 */
export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        Errors.validation(
          result.error.issues.map((i) => ({
            path: [source, ...i.path].join('.'),
            message: i.message,
          })),
        ),
      );
    }
    // req.query is a getter on Express 5 and rejects direct assignment.
    if (source === 'query') {
      Object.defineProperty(req, 'query', {
        value: result.data as Record<string, unknown>,
        writable: true,
        configurable: true,
      });
    } else {
      req[source] = result.data as never;
    }
    next();
  };
}

export type Infer<T extends ZodTypeAny> = z.infer<T>;

/**
 * Reads a route parameter as a plain string.
 *
 * Express 5 types params as `string | string[]` because a pattern can repeat a
 * named group. None of our routes do, but the union still has to be narrowed
 * before the value reaches a service.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
