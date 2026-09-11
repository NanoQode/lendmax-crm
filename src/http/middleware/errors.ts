/**
 * Error handling, and the shape of every failure this API returns.
 *
 * Two audiences, one response. The user gets a sentence they can act on; the
 * developer gets a correlation id they can grep the logs for. What the user
 * never gets in production is a stack trace, a SQL fragment, or the name of a
 * constraint — those are a map of the schema handed to whoever asked.
 */
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { env } from '../../config/env.ts';
import { log } from '../../lib/logger.ts';

/**
 * An error whose message is safe to show, because it was written to be shown.
 *
 * Fields are declared and assigned rather than written as constructor parameter
 * properties: this codebase runs under Node's type-stripping, which erases
 * types but does not synthesise code, and a parameter property is the one
 * TypeScript construct that needs code generated for it.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(message: string, status = 400, code = 'bad_request', detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const notFound = (what: string) => new AppError(`${what} not found.`, 404, 'not_found');
export const conflict = (message: string, detail?: unknown) =>
  new AppError(message, 409, 'conflict', detail);

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function asyncRoute<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req as T, res, next).catch(next);
  };
}

const PG_MESSAGES: Record<string, (constraint: string) => string> = {
  '23505': (c) =>
    c.includes('email')
      ? 'That email address is already in use.'
      : 'That record already exists.',
  '23503': () => 'That refers to something that no longer exists.',
  '23514': () => 'That value is not one this field accepts.',
};

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const correlationId = randomUUID();

  if (err instanceof ZodError) {
    // Field-level messages, because "invalid request" makes a person guess
    // which of eleven fields was wrong.
    const fields = err.issues.map((i) => ({
      field: i.path.join('.') || '(body)',
      message: i.message,
    }));
    res.status(422).json({
      ok: false,
      code: 'validation_failed',
      error: fields.length === 1
        ? `${fields[0]!.field}: ${fields[0]!.message}`
        : `${fields.length} fields need attention.`,
      fields,
      correlationId,
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      ok: false,
      code: err.code,
      error: err.message,
      detail: err.detail,
      correlationId,
    });
    return;
  }

  const pg = err as { code?: string; constraint?: string; message?: string };
  if (pg?.code && PG_MESSAGES[pg.code]) {
    log.warn('database constraint rejected a write', {
      correlationId, code: pg.code, constraint: pg.constraint, path: req.path,
    });
    res.status(409).json({
      ok: false,
      code: 'conflict',
      error: PG_MESSAGES[pg.code]!(pg.constraint ?? ''),
      correlationId,
    });
    return;
  }

  log.error('unhandled error', {
    correlationId,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    error: err,
  });

  res.status(500).json({
    ok: false,
    code: 'internal_error',
    error: 'Something went wrong at our end. Nothing was changed.',
    correlationId,
    // Never in production: a stack trace is a map of the codebase.
    ...(env.isProduction ? {} : { debug: err instanceof Error ? err.message : String(err) }),
  });
}
