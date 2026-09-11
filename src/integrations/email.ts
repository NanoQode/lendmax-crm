/**
 * Email, behind one interface.
 *
 * Four drivers: SMTP, Resend, Postmark, and `console` which writes to the log
 * and sends nothing. The abstraction is not architecture astronomy — a
 * brokerage changes email provider roughly once, and when it does, the change
 * should be a dropdown rather than a search through the codebase for every
 * place that sends.
 *
 * `console` is the default deliberately. A development box that silently
 * emails real clients because somebody copied a production .env is a bad
 * afternoon; a development box that logs is not.
 */
import nodemailer from 'nodemailer';
import { log } from '../lib/logger.ts';
import { integrationReady } from '../services/integrations.ts';

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Provider-side idempotency where the provider supports it. */
  idempotencyKey?: string;
};

export type SendResult = {
  ok: boolean;
  providerMessageId?: string;
  provider: string;
  /** An operational sentence, not a status code. */
  error?: string;
  /** True when retrying might work. A bad address is not worth retrying. */
  retryable?: boolean;
};

const TIMEOUT_MS = 20_000;

/** A fetch that cannot hang forever. An email send that never returns wedges a worker. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendEmail(
  organizationId: string,
  message: OutboundEmail,
): Promise<SendResult> {
  const { ready, reason, values } = await integrationReady(organizationId, 'email');
  const driver = String(values.driver ?? 'console');

  // The console driver works whether or not the integration is "configured" —
  // that is the point of it.
  if (!ready && driver !== 'console') {
    return { ok: false, provider: driver, error: reason ?? 'Email is not configured.', retryable: false };
  }

  const from = String(values.from ?? 'Lendmax <noreply@lendmax.ca>');
  const replyTo = message.replyTo ?? (values.reply_to ? String(values.reply_to) : undefined);

  try {
    switch (driver) {
      case 'console':
        log.info('email (console driver — not sent)', {
          to: message.to, subject: message.subject, from,
          preview: message.text.slice(0, 160),
        });
        return { ok: true, provider: 'console', providerMessageId: `console-${Date.now()}` };

      case 'smtp': {
        const transport = nodemailer.createTransport({
          host: String(values.smtp_host),
          port: Number(values.smtp_port ?? 587),
          // 465 is implicit TLS; everything else starts plain and upgrades.
          secure: Number(values.smtp_port ?? 587) === 465,
          auth: values.smtp_user
            ? { user: String(values.smtp_user), pass: String(values.smtp_password ?? '') }
            : undefined,
          connectionTimeout: TIMEOUT_MS,
        });
        const info = await transport.sendMail({
          from, to: message.to, subject: message.subject,
          text: message.text, html: message.html, replyTo,
        });
        return { ok: true, provider: 'smtp', providerMessageId: info.messageId };
      }

      case 'resend': {
        const res = await fetchWithTimeout('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${String(values.api_key)}`,
            'content-type': 'application/json',
            ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from, to: [message.to], subject: message.subject,
            text: message.text, html: message.html, reply_to: replyTo,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (!res.ok) {
          return {
            ok: false, provider: 'resend',
            error: body.message ?? `Resend rejected the message (HTTP ${res.status}).`,
            // 4xx is our fault and will stay our fault; 5xx and 429 may not be.
            retryable: res.status >= 500 || res.status === 429,
          };
        }
        return { ok: true, provider: 'resend', providerMessageId: body.id };
      }

      case 'postmark': {
        const res = await fetchWithTimeout('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: {
            'X-Postmark-Server-Token': String(values.api_key),
            'content-type': 'application/json', accept: 'application/json',
          },
          body: JSON.stringify({
            From: from, To: message.to, Subject: message.subject,
            TextBody: message.text, HtmlBody: message.html, ReplyTo: replyTo,
            MessageStream: 'outbound',
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string };
        if (!res.ok) {
          return {
            ok: false, provider: 'postmark',
            error: body.Message ?? `Postmark rejected the message (HTTP ${res.status}).`,
            retryable: res.status >= 500 || res.status === 429,
          };
        }
        return { ok: true, provider: 'postmark', providerMessageId: body.MessageID };
      }

      default:
        return { ok: false, provider: driver, error: `Unknown email driver "${driver}".`, retryable: false };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // A network fault or a timeout is worth trying again; the queue's backoff
    // decides when.
    return { ok: false, provider: driver, error, retryable: true };
  }
}

/** Settings → Integrations → Test. */
export async function testEmail(organizationId: string, to: string): Promise<SendResult> {
  return sendEmail(organizationId, {
    to,
    subject: 'Lendmax CRM — test email',
    text:
      'This is a test from the Lendmax CRM.\n\n' +
      'If you are reading it, the email integration is configured correctly and ' +
      'client messages will go out through it.\n',
  });
}
