/**
 * Structured logging. One line of JSON per event in production, something a
 * person can read in development.
 *
 * `redact` is not decoration. This CRM handles income, liabilities, dates of
 * birth and government identification; a stack trace or a request body landing
 * in a log aggregator is a privacy incident, not a debugging convenience. The
 * deny-list below is applied to every logged object, at every depth.
 */
import { env } from '../config/env.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

/** Keys whose values never reach a log, whatever the level. */
const SENSITIVE = new Set([
  'password', 'password_hash', 'passwordhash', 'token', 'access_token', 'refresh_token',
  'secret', 'api_key', 'apikey', 'authorization', 'cookie', 'session', 'sin',
  'social_insurance_number', 'dob', 'date_of_birth', 'account_number', 'card_number',
  'credit_score', 'annual_income', 'balance', 'session_secret',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: env.isProduction ? undefined : value.stack };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const record = {
    at: new Date().toISOString(),
    level,
    message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };
  const line = env.isProduction
    ? JSON.stringify(record)
    : `${record.at} ${level.toUpperCase().padEnd(5)} ${message}` +
      (context ? ` ${JSON.stringify(redact(context))}` : '');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
  /** A child logger that stamps every line with the same context. */
  child(base: Record<string, unknown>) {
    return {
      debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, { ...base, ...c }),
      info: (m: string, c?: Record<string, unknown>) => emit('info', m, { ...base, ...c }),
      warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, { ...base, ...c }),
      error: (m: string, c?: Record<string, unknown>) => emit('error', m, { ...base, ...c }),
    };
  },
};
