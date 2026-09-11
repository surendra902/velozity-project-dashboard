import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError, Errors } from '../lib/errors';

/**
 * Terminal error handler. Guarantees one response shape for every failure:
 *
 *   { error: { code: string, message: string, details?: unknown } }
 *
 * Stack traces never reach the client — they are logged server-side instead.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = Errors.validation(
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Surface the two constraint failures a client can actually cause;
    // everything else is an internal fault and gets a generic 500.
    if (err.code === 'P2002') {
      appError = Errors.conflict('A record with those unique values already exists');
    } else if (err.code === 'P2025') {
      appError = Errors.notFound();
    } else {
      appError = Errors.internal();
    }
  } else {
    appError = Errors.internal();
  }

  if (appError.status >= 500) {
    console.error('[error]', err);
  }

  // The stack is never serialised onto the response — gating it on `!isProd`
  // leaked it under NODE_ENV=test and would leak it in any non-production
  // deployment. It goes to the server log above and nowhere else.
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  });
}

/** Wraps an async handler so a rejected promise reaches errorHandler. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(Errors.notFound(`Route ${req.method} ${req.originalUrl}`));
}
