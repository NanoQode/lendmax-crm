/**
 * Integration configuration: what is connected, with what credentials.
 *
 * Every adapter asks this module rather than reading `process.env` directly, so
 * there is exactly one answer to "where do the Scarlett credentials come from"
 * and one place to change it.
 *
 * RESOLUTION ORDER: the database wins, the environment is the fallback.
 *
 * That order matters. An existing deployment keeps working through this change
 * with nothing in the database; a developer keeps a local `.env`; and the
 * moment a technical admin saves a value on screen, that is the value used —
 * without a deploy, at 7pm, when VoIP.ms has just rotated a password.
 *
 * The cache is short and invalidated on write. An integration whose credentials
 * were corrected thirty seconds ago and is still failing because the old ones
 * are cached is a support call that should never happen.
 */
import { env } from '../config/env.ts';
import { query, queryOne } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import {
  decryptSecrets, encryptSecrets, mergeSecrets, previewOf, SecretsUnavailable,
} from '../lib/secrets.ts';

export type IntegrationKey = 'portal' | 'scarlett' | 'voipms' | 'email' | 'google' | 'ai' | 'storage';

export const INTEGRATION_KEYS: IntegrationKey[] = [
  'portal', 'scarlett', 'voipms', 'email', 'google', 'ai', 'storage',
];

/**
 * The shape of each integration: which fields are configuration, which are
 * secrets, and which are required before it can be called "configured".
 *
 * Declared as data so the settings screen renders itself from the same
 * definition the resolver validates against — a screen that lists a field the
 * backend ignores is how an admin ends up certain they have configured
 * something that is not configured.
 */
export type FieldSpec = {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  type?: 'text' | 'password' | 'url' | 'select' | 'boolean' | 'number';
  options?: Array<{ value: string; label: string }>;
  help?: string;
  placeholder?: string;
  /** The .env variable this falls back to, shown on screen so the two are traceable. */
  envVar?: string;
};

export type IntegrationSpec = {
  key: IntegrationKey;
  name: string;
  summary: string;
  /** What breaks while this is off — so switching it off is an informed choice. */
  whenOff: string;
  fields: FieldSpec[];
  testable: boolean;
};

export const INTEGRATION_SPECS: Record<IntegrationKey, IntegrationSpec> = {
  portal: {
    key: 'portal',
    name: 'apply.lendmax.ca',
    summary:
      'The application portal. It owns the application and pushes every change here as it is ' +
      'filled in — from the first answer, not on submit.',
    whenOff: 'Applications stop arriving. Nothing else in the CRM has anything to work on.',
    testable: true,
    fields: [
      { name: 'base_url', label: 'Portal URL', type: 'url', required: true,
        placeholder: 'http://127.0.0.1:3200', envVar: 'PORTAL_BASE_URL',
        help: 'Used to stream a document back rather than holding a second copy of it. Use the ' +
              'loopback address, not https://apply.lendmax.ca — nginx returns 404 for ' +
              '/api/internal/ from the internet on both machines, so the public hostname fails ' +
              'every document fetch. Both sides are on this server.' },
      { name: 'internal_api_key', label: 'Internal API key', secret: true, required: true,
        envVar: 'PORTAL_INTERNAL_API_KEY',
        help: 'The portal’s INTERNAL_API_KEY. Used when the CRM calls the portal.' },
      { name: 'webhook_secret', label: 'Inbound mirror key', secret: true, required: true,
        envVar: 'PORTAL_WEBHOOK_SECRET',
        help: 'What the portal sends in x-internal-key when it pushes an application here. ' +
              'Compared in constant time.' },
    ],
  },

  scarlett: {
    key: 'scarlett',
    name: 'Scarlett Network',
    summary:
      'Where a deal goes once the file is ready for a lender. One API key, sent in the body of ' +
      'every call — there is no token to refresh and nothing that expires.',
    whenOff: 'Push to Scarlett is unavailable and files cannot leave the Scarlett stage.',
    testable: true,
    fields: [
      { name: 'api_key', label: 'API key', secret: true, required: true, envVar: 'SCARLETT_API_KEY',
        help: 'Created in Scarlett under Settings → API Access. Shown once, so keep a copy. ' +
              'Sent as APIKey in the request body, not as a header.' },
      { name: 'firm_code', label: 'Firm code', required: true, envVar: 'SCARLETT_FIRM_CODE',
        help: 'Identifies the brokerage on a deal push.' },
      { name: 'expert_login', label: 'Expert login', required: true, envVar: 'SCARLETT_EXPERT_LOGIN',
        help: 'The Scarlett user a pushed deal is filed under.' },
      { name: 'db_name', label: 'Database name', envVar: 'SCARLETT_DB_NAME',
        help: 'Only where Scarlett has told you to set one. Left blank otherwise.' },
      { name: 'pipeline_stage_id', label: 'Pipeline stage ID',
        help: 'Which stage a pushed deal lands on in Scarlett. Blank uses their default.' },
      { name: 'notification_flag', label: 'Notify the expert on push', type: 'boolean' },
      { name: 'mode', label: 'Mode', type: 'select', required: true, envVar: 'SCARLETT_MODE',
        options: [
          { value: 'sandbox', label: 'Sandbox — nothing is sent' },
          { value: 'live', label: 'Live — creates real deals' },
        ],
        help: 'Live mode is refused outright on a non-production server. A test deal in a real ' +
              'broker network cannot be taken back from here.' },
      { name: 'auto_push', label: 'Push automatically when a file is ready', type: 'boolean',
        help: 'Off by default, at Ali’s instruction — a broker may want to hold a file back, ' +
              'and an automatic push removes that choice.' },
    ],
  },

  voipms: {
    key: 'voipms',
    name: 'VoIP.ms (SMS / MMS)',
    summary: 'Two-way texting with clients.',
    whenOff: 'SMS cannot be sent or received. Email-only automations still run.',
    testable: true,
    fields: [
      { name: 'api_user', label: 'API username', required: true, envVar: 'VOIPMS_API_USER',
        help: 'The API user, not your account email — enable API access in the VoIP.ms portal first.' },
      { name: 'api_password', label: 'API password', secret: true, required: true,
        envVar: 'VOIPMS_API_PASSWORD' },
      { name: 'default_did', label: 'Sending number (DID)', required: true, envVar: 'VOIPMS_DEFAULT_DID',
        placeholder: '4165550142',
        help: 'Digits only, as VoIP.ms stores it. Replies come back to this number.' },
      { name: 'webhook_secret', label: 'Inbound callback key', secret: true,
        envVar: 'VOIPMS_WEBHOOK_SECRET',
        help: 'Appended to the SMS callback URL in VoIP.ms and compared in constant time.' },
      { name: 'daily_limit', label: 'Daily send limit', type: 'number',
        help: 'A ceiling on outbound messages per day. Protects against an automation loop ' +
              'texting the whole database; A2P rules make that expensive as well as embarrassing.' },
      { name: 'segment_limit', label: 'Maximum segments per message', type: 'number',
        help: 'A long text is billed per 153-character segment. The composer warns past this.' },
    ],
  },

  email: {
    key: 'email',
    name: 'Email',
    summary: 'Everything the CRM sends to a client that is not a text message.',
    whenOff: 'Nothing is emailed. Messages queue rather than being lost.',
    testable: true,
    fields: [
      { name: 'driver', label: 'Provider', type: 'select', required: true, envVar: 'EMAIL_DRIVER',
        options: [
          { value: 'smtp', label: 'SMTP' },
          { value: 'resend', label: 'Resend' },
          { value: 'postmark', label: 'Postmark' },
          { value: 'console', label: 'Console — writes to the log, sends nothing' },
        ] },
      { name: 'from', label: 'From address', required: true, envVar: 'EMAIL_FROM',
        placeholder: 'Lendmax <noreply@lendmax.ca>',
        help: 'The domain must be verified with the provider, with SPF, DKIM and DMARC set, ' +
              'or the mail lands in spam.' },
      { name: 'reply_to', label: 'Reply-to', help: 'Usually left blank so replies go to the sender.' },
      { name: 'smtp_host', label: 'SMTP host', envVar: 'SMTP_HOST' },
      { name: 'smtp_port', label: 'SMTP port', type: 'number', envVar: 'SMTP_PORT' },
      { name: 'smtp_user', label: 'SMTP username', envVar: 'SMTP_USER' },
      { name: 'smtp_password', label: 'SMTP password', secret: true, envVar: 'SMTP_PASSWORD' },
      { name: 'api_key', label: 'Provider API key', secret: true,
        envVar: 'RESEND_API_KEY', help: 'For Resend or Postmark.' },
    ],
  },

  google: {
    key: 'google',
    name: 'Google Calendar',
    summary: 'Appointments in the CRM appear in the assigned user’s calendar, with a Meet link.',
    whenOff: 'Appointments are held in the CRM only and no calendar invitation is sent.',
    testable: false,
    fields: [
      { name: 'client_id', label: 'Client ID', required: true, envVar: 'GOOGLE_CLIENT_ID' },
      { name: 'client_secret', label: 'Client secret', secret: true, required: true,
        envVar: 'GOOGLE_CLIENT_SECRET' },
      { name: 'redirect_uri', label: 'Redirect URI', type: 'url', required: true,
        envVar: 'GOOGLE_REDIRECT_URI',
        help: 'Must match the authorised redirect URI in the Google Cloud console exactly.' },
    ],
  },

  ai: {
    key: 'ai',
    name: 'AI assist',
    summary:
      'Drafting and summarising only. It never decides suitability, compliance or priority, and ' +
      'the fields it is allowed to see are filtered before anything leaves this server.',
    whenOff: 'Draft and summarise buttons are hidden. Nothing else changes.',
    testable: true,
    fields: [
      { name: 'enabled', label: 'Enabled', type: 'boolean', envVar: 'AI_ENABLED' },
      { name: 'api_key', label: 'Anthropic API key', secret: true, envVar: 'ANTHROPIC_API_KEY' },
      { name: 'model', label: 'Model', envVar: 'AI_MODEL' },
      { name: 'send_financials', label: 'May see financial detail', type: 'boolean',
        help: 'Off by default. With it off, income, balances and liabilities are stripped before ' +
              'a prompt is built. Identification numbers and credit files are never sent either way.' },
    ],
  },

  storage: {
    key: 'storage',
    name: 'Document storage',
    summary: 'Where uploaded documents are kept.',
    whenOff: 'Uploads fail. Documents already stored are unaffected.',
    testable: true,
    fields: [
      { name: 'driver', label: 'Driver', type: 'select', required: true, envVar: 'STORAGE_DRIVER',
        options: [
          { value: 'local', label: 'Local disk' },
          { value: 's3', label: 'S3-compatible' },
        ] },
      { name: 'local_dir', label: 'Local directory', envVar: 'STORAGE_LOCAL_DIR' },
      { name: 'bucket', label: 'Bucket', envVar: 'S3_BUCKET' },
      { name: 'region', label: 'Region', envVar: 'S3_REGION',
        help: 'Keep this in Canada unless counsel has said otherwise.' },
      { name: 'endpoint', label: 'Endpoint', type: 'url', envVar: 'S3_ENDPOINT' },
      { name: 'access_key_id', label: 'Access key ID', secret: true, envVar: 'S3_ACCESS_KEY_ID' },
      { name: 'secret_access_key', label: 'Secret access key', secret: true,
        envVar: 'S3_SECRET_ACCESS_KEY' },
    ],
  },
};

/** The .env fallbacks, by integration and field. */
const ENV_FALLBACK: Record<IntegrationKey, Record<string, unknown>> = {
  portal: {
    base_url: env.PORTAL_BASE_URL,
    internal_api_key: env.PORTAL_INTERNAL_API_KEY,
    webhook_secret: env.PORTAL_WEBHOOK_SECRET,
  },
  scarlett: {
    api_key: env.SCARLETT_API_KEY,
    firm_code: env.SCARLETT_FIRM_CODE,
    expert_login: env.SCARLETT_EXPERT_LOGIN,
    db_name: env.SCARLETT_DB_NAME,
    mode: env.SCARLETT_MODE,
  },
  voipms: {
    api_user: env.VOIPMS_API_USER,
    api_password: env.VOIPMS_API_PASSWORD,
    default_did: env.VOIPMS_DEFAULT_DID,
    webhook_secret: env.VOIPMS_WEBHOOK_SECRET,
  },
  email: {
    driver: env.EMAIL_DRIVER,
    from: env.EMAIL_FROM,
    smtp_host: env.SMTP_HOST,
    smtp_port: env.SMTP_PORT,
    smtp_user: env.SMTP_USER,
    smtp_password: env.SMTP_PASSWORD,
    api_key: env.RESEND_API_KEY ?? env.POSTMARK_API_KEY,
  },
  google: {
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
  },
  ai: {
    enabled: env.AI_ENABLED,
    api_key: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL,
  },
  storage: {
    driver: env.STORAGE_DRIVER,
    local_dir: env.STORAGE_LOCAL_DIR,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    access_key_id: env.S3_ACCESS_KEY_ID,
    secret_access_key: env.S3_SECRET_ACCESS_KEY,
  },
};

export type ResolvedIntegration = {
  key: IntegrationKey;
  enabled: boolean;
  /** Every field, database over environment. Secrets included — server-side only. */
  values: Record<string, unknown>;
  /** Which fields required for this integration have no value anywhere. */
  missing: string[];
  configured: boolean;
  source: Record<string, 'database' | 'environment' | 'unset'>;
  decryptFailed: boolean;
};

type Row = {
  integration_key: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets_encrypted: Buffer | null;
  decrypt_failed: boolean;
};

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: ResolvedIntegration }>();

export function invalidateIntegrationCache(organizationId?: string, key?: IntegrationKey): void {
  if (organizationId && key) cache.delete(`${organizationId}:${key}`);
  else cache.clear();
}

/**
 * Everything an adapter needs to make a call. Secrets are decrypted here and
 * must not be logged or returned to a browser — `describeForAdmin` is what the
 * settings screen reads.
 */
export async function resolveIntegration(
  organizationId: string,
  key: IntegrationKey,
): Promise<ResolvedIntegration> {
  const cacheKey = `${organizationId}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const row = await queryOne<Row>(
    `SELECT integration_key, enabled, config, secrets_encrypted, decrypt_failed
       FROM integration_settings WHERE organization_id = $1 AND integration_key = $2`,
    [organizationId, key],
  );

  let secrets: Record<string, string> = {};
  let decryptFailed = false;
  if (row?.secrets_encrypted) {
    try {
      secrets = decryptSecrets(row.secrets_encrypted);
    } catch (err) {
      decryptFailed = true;
      // Loud, and recorded, because the failure mode otherwise looks exactly
      // like "not configured" and sends somebody to re-enter credentials that
      // are in fact still there.
      log.error('integration credentials could not be decrypted', {
        integration: key,
        error: err instanceof SecretsUnavailable ? err.message : err,
      });
      await query(
        `UPDATE integration_settings SET decrypt_failed = true
          WHERE organization_id = $1 AND integration_key = $2`,
        [organizationId, key],
      ).catch(() => {});
    }
  }

  const spec = INTEGRATION_SPECS[key];
  const fallback = ENV_FALLBACK[key] ?? {};
  const values: Record<string, unknown> = {};
  const source: Record<string, 'database' | 'environment' | 'unset'> = {};

  for (const field of spec.fields) {
    const fromDb = field.secret ? secrets[field.name] : (row?.config ?? {})[field.name];
    const fromEnv = fallback[field.name];
    if (fromDb !== undefined && fromDb !== null && fromDb !== '') {
      values[field.name] = fromDb;
      source[field.name] = 'database';
    } else if (fromEnv !== undefined && fromEnv !== null && fromEnv !== '') {
      values[field.name] = fromEnv;
      source[field.name] = 'environment';
    } else {
      source[field.name] = 'unset';
    }
  }

  const missing = spec.fields
    .filter((f) => f.required && (values[f.name] === undefined || values[f.name] === ''))
    .map((f) => f.name);

  // A row that exists decides enabled; with no row, an integration is on when
  // the environment has everything it needs. That keeps an existing deployment
  // working with an empty table.
  const enabled = row ? row.enabled : missing.length === 0;

  const resolved: ResolvedIntegration = {
    key,
    enabled,
    values,
    missing,
    configured: missing.length === 0 && !decryptFailed,
    source,
    decryptFailed,
  };
  cache.set(cacheKey, { at: Date.now(), value: resolved });
  return resolved;
}

/** True only when the integration is both switched on and fully configured. */
export async function integrationReady(
  organizationId: string,
  key: IntegrationKey,
): Promise<{ ready: boolean; reason?: string; values: Record<string, unknown> }> {
  const resolved = await resolveIntegration(organizationId, key);
  if (resolved.decryptFailed) {
    return {
      ready: false,
      reason: `${INTEGRATION_SPECS[key].name}: stored credentials could not be decrypted. ` +
        'Re-enter them under Settings → Integrations.',
      values: {},
    };
  }
  if (!resolved.enabled) {
    return {
      ready: false,
      reason: `${INTEGRATION_SPECS[key].name} is switched off. ${INTEGRATION_SPECS[key].whenOff}`,
      values: resolved.values,
    };
  }
  if (resolved.missing.length) {
    const labels = resolved.missing
      .map((name) => INTEGRATION_SPECS[key].fields.find((f) => f.name === name)?.label ?? name);
    return {
      ready: false,
      reason: `${INTEGRATION_SPECS[key].name} is missing ${labels.join(', ')}.`,
      values: resolved.values,
    };
  }
  return { ready: true, values: resolved.values };
}

/**
 * What the settings screen is given. No secret value ever appears here — only
 * whether each is set, and its last four characters.
 */
export async function describeForAdmin(organizationId: string): Promise<Array<{
  spec: IntegrationSpec;
  enabled: boolean;
  configured: boolean;
  missing: string[];
  config: Record<string, unknown>;
  secrets: Record<string, { set: boolean; last4: string }>;
  source: Record<string, string>;
  decryptFailed: boolean;
  lastTest: { at: string | null; ok: boolean | null; message: string | null };
}>> {
  const { rows } = await query<{
    integration_key: string; enabled: boolean; config: Record<string, unknown>;
    secrets_preview: Record<string, { set: boolean; last4: string }>;
    last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null;
    decrypt_failed: boolean;
  }>(
    `SELECT integration_key, enabled, config, secrets_preview,
            last_test_at, last_test_ok, last_test_message, decrypt_failed
       FROM integration_settings WHERE organization_id = $1`,
    [organizationId],
  );
  const byKey = new Map(rows.map((r) => [r.integration_key, r]));

  const out = [];
  for (const key of INTEGRATION_KEYS) {
    const spec = INTEGRATION_SPECS[key];
    const row = byKey.get(key);
    const resolved = await resolveIntegration(organizationId, key);

    // Secret previews come from the stored preview where there is one, and are
    // otherwise derived from the environment fallback — so a value inherited
    // from .env is visibly present rather than looking unset.
    const secrets: Record<string, { set: boolean; last4: string }> = {};
    for (const field of spec.fields.filter((f) => f.secret)) {
      const stored = row?.secrets_preview?.[field.name];
      if (stored) {
        secrets[field.name] = stored;
      } else {
        const value = String(resolved.values[field.name] ?? '');
        secrets[field.name] = previewOf({ [field.name]: value })[field.name]!;
      }
    }

    const config: Record<string, unknown> = {};
    for (const field of spec.fields.filter((f) => !f.secret)) {
      config[field.name] = resolved.values[field.name] ?? '';
    }

    out.push({
      spec,
      enabled: resolved.enabled,
      configured: resolved.configured,
      missing: resolved.missing,
      config,
      secrets,
      source: resolved.source,
      decryptFailed: resolved.decryptFailed,
      lastTest: {
        at: row?.last_test_at ?? null,
        ok: row?.last_test_ok ?? null,
        message: row?.last_test_message ?? null,
      },
    });
  }
  return out;
}

/** Save. Blank secret fields mean "leave alone"; `__clear__` means remove. */
export async function saveIntegration(
  organizationId: string,
  key: IntegrationKey,
  input: { enabled?: boolean; config?: Record<string, unknown>; secrets?: Record<string, string> },
  actorId: string,
): Promise<void> {
  const spec = INTEGRATION_SPECS[key];
  const row = await queryOne<Row>(
    `SELECT integration_key, enabled, config, secrets_encrypted, decrypt_failed
       FROM integration_settings WHERE organization_id = $1 AND integration_key = $2`,
    [organizationId, key],
  );

  let existingSecrets: Record<string, string> = {};
  if (row?.secrets_encrypted && !row.decrypt_failed) {
    try {
      existingSecrets = decryptSecrets(row.secrets_encrypted);
    } catch {
      // Unreadable: the submitted values replace them wholesale rather than
      // being merged into something we cannot read.
      existingSecrets = {};
    }
  }

  // Only fields this integration actually declares. An unknown key in the body
  // is dropped rather than stored, so the table cannot accumulate junk that no
  // screen shows and no adapter reads.
  const allowedSecrets = new Set(spec.fields.filter((f) => f.secret).map((f) => f.name));
  const allowedConfig = new Set(spec.fields.filter((f) => !f.secret).map((f) => f.name));

  const submittedSecrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (allowedSecrets.has(name)) submittedSecrets[name] = String(value);
  }
  const nextSecrets = mergeSecrets(existingSecrets, submittedSecrets);

  const nextConfig: Record<string, unknown> = { ...(row?.config ?? {}) };
  for (const [name, value] of Object.entries(input.config ?? {})) {
    if (allowedConfig.has(name)) nextConfig[name] = value;
  }

  await query(
    `INSERT INTO integration_settings
       (organization_id, integration_key, enabled, config, secrets_encrypted,
        secrets_preview, decrypt_failed, updated_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,false,$7)
     ON CONFLICT (organization_id, integration_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       config = EXCLUDED.config,
       secrets_encrypted = EXCLUDED.secrets_encrypted,
       secrets_preview = EXCLUDED.secrets_preview,
       decrypt_failed = false,
       updated_by = EXCLUDED.updated_by`,
    [
      organizationId, key,
      input.enabled ?? row?.enabled ?? false,
      JSON.stringify(nextConfig),
      Object.keys(nextSecrets).length ? encryptSecrets(nextSecrets) : null,
      JSON.stringify(previewOf(nextSecrets)),
      actorId,
    ],
  );
  invalidateIntegrationCache(organizationId, key);
}

export async function recordTestResult(
  organizationId: string,
  key: IntegrationKey,
  ok: boolean,
  message: string,
): Promise<void> {
  await query(
    `INSERT INTO integration_settings (organization_id, integration_key, last_test_at, last_test_ok, last_test_message)
     VALUES ($1,$2,now(),$3,$4)
     ON CONFLICT (organization_id, integration_key) DO UPDATE SET
       last_test_at = now(), last_test_ok = EXCLUDED.last_test_ok,
       last_test_message = EXCLUDED.last_test_message`,
    [organizationId, key, ok, message.slice(0, 500)],
  );
  invalidateIntegrationCache(organizationId, key);
}
