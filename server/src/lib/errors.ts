/**
 * Every failure that reaches the client goes through AppError, so the response
 * shape is identical across the whole API. The error middleware is the only
 * place that formats them.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace?.(this, AppError);
  }
}

export const Errors = {
  unauthorized: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHORIZED', message),

  invalidToken: (message = 'Invalid or expired token') =>
    new AppError(401, 'INVALID_TOKEN', message),

  // For authorisation failures on a resource the caller is not allowed to see,
  // prefer notFound() — returning 403 confirms the row exists.
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),

  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),

  badRequest: (message = 'Invalid request', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),

  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details),

  conflict: (message = 'Resource already exists') => new AppError(409, 'CONFLICT', message),

  internal: (message = 'Internal server error') =>
    new AppError(500, 'INTERNAL_ERROR', message),
};
