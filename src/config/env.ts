/**
 * Environment, read once, validated once.
 *
 * The rule here is that the process refuses to start rather than start wrong.
 * A CRM that boots with an unset SESSION_SECRET and discovers it when the first
 * broker's cookie fails to verify has already lost the morning; a CRM that
 * refuses to boot has lost thirty seconds.
 *
 * Validation is deliberately *contextual*: SESSION_SECRET may be absent in
 * development (a per-boot random one is generated and logged as such) and may
 * not be absent in production. Integrations are optional everywhere — an
 * unconfigured integration is a disabled integration, not a boot failure, and
 * `describeIntegrations()` is what the admin's Integrations page reads so the
 * reason a thing is off is visible rather than mysterious.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const RawEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3400),
  BASE_PATH: z.string().default('/crm'),
  PUBLIC_URL: z.string().url().default('http://localhost:3400/crm'),
  BROKERAGE_TIMEZONE: z.string().default('America/Toronto'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().positive().default(168),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  DOCUMENT_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ca-central-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  PORTAL_BASE_URL: z.string().optional(),
  PORTAL_INTERNAL_API_KEY: z.string().optional(),
  PORTAL_WEBHOOK_SECRET: z.string().optional(),

  SCARLETT_BASE_URL: z.string().optional(),
  SCARLETT_API_KEY: z.string().optional(),
  SCARLETT_PARTNER_ID: z.string().optional(),
  SCARLETT_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  VOIPMS_API_USER: z.string().optional(),
  VOIPMS_API_PASSWORD: z.string().optional(),
  VOIPMS_DEFAULT_DID: z.string().optional(),
  VOIPMS_WEBHOOK_SECRET: z.string().optional(),

  EMAIL_DRIVER: z.enum(['smtp', 'resend', 'postmark', 'console']).default('console'),
  EMAIL_FROM: z.string().default('Lendmax <noreply@lendmax.ca>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  POSTMARK_API_KEY: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  AI_ENABLED: bool,
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof RawEnv> & {
  SESSION_SECRET: string;
  isProduction: boolean;
  isTest: boolean;
};

function load(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat "" as absent. A variable present-but-empty in a .env file is the
  // single most common way a secret goes missing, and z.string().optional()
  // would otherwise accept it as a real value.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && v.trim() !== '') cleaned[k] = v;
  }

  const parsed = RawEnv.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Environment is not usable:\n${lines.join('\n')}\n\nSee .env.example.`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  let secret = env.SESSION_SECRET;
  if (!secret) {
    if (isProduction) {
      throw new Error(
        'SESSION_SECRET is required in production. Generate one with: openssl rand -base64 48',
      );
    }
    // Development only. Sessions do not survive a restart, which is correct:
    // the alternative is a well-known default secret, and well-known default
    // secrets reach production.
    secret = randomBytes(48).toString('base64');
  }
  if (isProduction && secret.length < 32) {
    throw new Error('SESSION_SECRET is too short — use at least 32 characters.');
  }

  if (isProduction && env.SCARLETT_MODE === 'live' && !env.SCARLETT_API_KEY) {
    throw new Error('SCARLETT_MODE=live without SCARLETT_API_KEY — refusing to start.');
  }
  // The opposite mistake matters more: pushing test deals into a live broker
  // network is not undoable from here.
  if (!isProduction && env.SCARLETT_MODE === 'live') {
    throw new Error(
      `SCARLETT_MODE=live with NODE_ENV=${env.NODE_ENV}. A non-production box must not create ` +
        'live Scarlett deals. Set SCARLETT_MODE=sandbox.',
    );
  }

  return { ...env, SESSION_SECRET: secret, isProduction, isTest: env.NODE_ENV === 'test' };
}

export const env: Env = load();
export const loadEnvFrom = load; // exported for tests

/**
 * What is configured and what is not — the source of truth for the admin's
 * Integrations page. An integration that is off says why it is off.
 */
export type IntegrationStatus = {
  id: string;
  name: string;
  configured: boolean;
  mode?: string;
  missing: string[];
};

export function describeIntegrations(e: Env = env): IntegrationStatus[] {
  const need = (vars: Array<[string, unknown]>) =>
    vars.filter(([, v]) => !v).map(([k]) => k);

  return [
    {
      id: 'portal',
      name: 'apply.lendmax.ca (application portal)',
      configured: Boolean(e.PORTAL_BASE_URL && e.PORTAL_INTERNAL_API_KEY),
      missing: need([
        ['PORTAL_BASE_URL', e.PORTAL_BASE_URL],
        ['PORTAL_INTERNAL_API_KEY', e.PORTAL_INTERNAL_API_KEY],
      ]),
    },
    {
      id: 'scarlett',
      name: 'Scarlett Mortgage',
      configured: Boolean(e.SCARLETT_BASE_URL && e.SCARLETT_API_KEY),
      mode: e.SCARLETT_MODE,
      missing: need([
        ['SCARLETT_BASE_URL', e.SCARLETT_BASE_URL],
        ['SCARLETT_API_KEY', e.SCARLETT_API_KEY],
      ]),
    },
    {
      id: 'voipms',
      name: 'VoIP.ms (SMS / MMS)',
      configured: Boolean(e.VOIPMS_API_USER && e.VOIPMS_API_PASSWORD && e.VOIPMS_DEFAULT_DID),
      missing: need([
        ['VOIPMS_API_USER', e.VOIPMS_API_USER],
        ['VOIPMS_API_PASSWORD', e.VOIPMS_API_PASSWORD],
        ['VOIPMS_DEFAULT_DID', e.VOIPMS_DEFAULT_DID],
      ]),
    },
    {
      id: 'email',
      name: `Email (${e.EMAIL_DRIVER})`,
      configured:
        e.EMAIL_DRIVER === 'console' ||
        (e.EMAIL_DRIVER === 'smtp' && Boolean(e.SMTP_HOST)) ||
        (e.EMAIL_DRIVER === 'resend' && Boolean(e.RESEND_API_KEY)) ||
        (e.EMAIL_DRIVER === 'postmark' && Boolean(e.POSTMARK_API_KEY)),
      mode: e.EMAIL_DRIVER,
      missing: [],
    },
    {
      id: 'google',
      name: 'Google Calendar',
      configured: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REDIRECT_URI),
      missing: need([
        ['GOOGLE_CLIENT_ID', e.GOOGLE_CLIENT_ID],
        ['GOOGLE_CLIENT_SECRET', e.GOOGLE_CLIENT_SECRET],
        ['GOOGLE_REDIRECT_URI', e.GOOGLE_REDIRECT_URI],
      ]),
    },
    {
      id: 'ai',
      name: 'AI assist',
      configured: Boolean(e.AI_ENABLED && e.ANTHROPIC_API_KEY),
      mode: e.AI_ENABLED ? 'enabled' : 'disabled',
      missing: e.AI_ENABLED ? need([['ANTHROPIC_API_KEY', e.ANTHROPIC_API_KEY]]) : [],
    },
  ];
}
