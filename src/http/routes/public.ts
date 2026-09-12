/**
 * The client-facing upload link.
 *
 * Reached with a token and no account, from a phone, usually while the client
 * is standing somewhere doing something else. Everything about it is therefore
 * different from the rest of the API:
 *
 *   · The token IS the credential. It is high-entropy, stored only as a hash,
 *     expires, and is compared in constant time.
 *   · It grants access to ONE request on ONE file and nothing else. There is
 *     no listing endpoint and no way to walk from it to another client.
 *   · It tells the client as little as the job allows: their first name, the
 *     documents asked for, and who asked. Not the mortgage amount, not the
 *     address, not what else is on the file — a link forwarded to the wrong
 *     person should disclose as close to nothing as possible.
 *   · Rate limited hard, because a token is guessable in principle and an
 *     unlimited endpoint is where that stops being theoretical.
 */
import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { env } from '../../config/env.ts';
import { log } from '../../lib/logger.ts';
import { checkUpload, putObject, scanObject, MAX_BYTES } from '../../services/storage.ts';
import { recordAudit, recordAuditSafely } from '../../services/audit.ts';
import { verifyUnsubscribeToken } from '../../services/unsubscribe.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { markItemReceived, refreshOutstanding } from './documents.ts';

export const publicRoutes: Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const lookupLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Wait a few minutes.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many uploads at once. Wait a few minutes and try again.' },
});

type RequestRow = {
  id: string; organization_id: string; application_id: string; customer_id: string;
  message: string | null; status: string; expires_at: Date; first_name: string | null;
  requested_by_name: string | null; organization_name: string;
};

async function findByToken(token: string): Promise<RequestRow | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  return queryOne<RequestRow>(
    `SELECT r.id, r.organization_id, r.application_id, r.customer_id, r.message, r.status,
            r.expires_at, c.first_name, u.name AS requested_by_name, o.name AS organization_name
       FROM document_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.token_hash = $1`,
    [hash],
  );
}

/**
 * What the client sees.
 *
 * An expired or cancelled link gets a plain explanation and a way forward
 * rather than a 404 — the person holding it has done nothing wrong, and
 * "not found" sends them to phone the office to be told the link expired.
 */
publicRoutes.get(
  '/api/upload/:token',
  lookupLimiter,
  asyncRoute(async (req, res) => {
    const token = z.string().min(20).max(200).parse(req.params.token);
    const request = await findByToken(token);

    if (!request) {
      res.status(404).json({
        ok: false, code: 'unknown',
        error: 'This upload link is not valid. Check the link in your email, or reply to it and ' +
               'we will send a new one.',
      });
      return;
    }
    if (request.status === 'cancelled') {
      res.status(410).json({
        ok: false, code: 'cancelled',
        error: 'This request has been cancelled. Reply to the email or text and we will let you ' +
               'know what is still needed.',
      });
      return;
    }
    if (new Date(request.expires_at).getTime() < Date.now()) {
      await query(`UPDATE document_requests SET status = 'expired' WHERE id = $1 AND status <> 'completed'`,
                  [request.id]);
      res.status(410).json({
        ok: false, code: 'expired',
        error: 'This upload link has expired. Reply to the email or text and we will send a new one.',
      });
      return;
    }

    await query(
      `UPDATE document_requests
          SET first_opened_at = COALESCE(first_opened_at, now()),
              last_opened_at = now(), open_count = open_count + 1
        WHERE id = $1`,
      [request.id],
    );

    const { rows: items } = await query(
      `SELECT i.id, i.label, i.description, i.required, i.status,
              COALESCE(a.first_name, '') AS applicant_first_name
         FROM document_request_items i
         LEFT JOIN application_applicants a ON a.id = i.applicant_id
        WHERE i.document_request_id = $1 ORDER BY i.position`,
      [request.id],
    );

    res.json({
      ok: true,
      // Deliberately minimal. Not the mortgage amount, not the address.
      client_first_name: request.first_name,
      organization: request.organization_name,
      requested_by: request.requested_by_name,
      message: request.message,
      completed: request.status === 'completed',
      items,
      max_bytes: MAX_BYTES,
    });
  }),
);

publicRoutes.post(
  '/api/upload/:token',
  uploadLimiter,
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const token = z.string().min(20).max(200).parse(req.params.token);
    const itemId = z.string().uuid().optional().parse(req.body?.item_id || undefined);
    const file = req.file;

    const request = await findByToken(token);
    if (!request || new Date(request.expires_at).getTime() < Date.now()
        || request.status === 'cancelled') {
      res.status(410).json({ ok: false, error: 'This upload link is no longer valid.' });
      return;
    }
    if (!file) {
      res.status(422).json({ ok: false, error: 'No file was attached.' });
      return;
    }

    const check = checkUpload(file.originalname, file.mimetype, file.size);
    if (!check.ok) {
      // The client reads this, so it says what to do rather than what failed.
      res.status(422).json({ ok: false, error: check.reason });
      return;
    }

    // The item has to belong to THIS request. Without the check, a valid token
    // plus somebody else's item id would file a document on another client.
    let item: { id: string; label: string } | null = null;
    if (itemId) {
      item = await queryOne<{ id: string; label: string }>(
        `SELECT id, label FROM document_request_items
          WHERE id = $1 AND document_request_id = $2`,
        [itemId, request.id],
      );
      if (!item) {
        res.status(422).json({ ok: false, error: 'That is not one of the documents requested here.' });
        return;
      }
    }

    const stored = await putObject(Readable.from(file.buffer), {
      filename: file.originalname, mimeType: file.mimetype,
    });
    const scan = await scanObject(stored.key);

    const documentId = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents
           (organization_id, application_id, customer_id, category_key, filename, display_label,
            mime_type, byte_size, sha256, storage_driver, storage_key, source, scan_status,
            scan_at, scan_detail, document_request_item_id)
         VALUES ($1,$2,$3,
                 (SELECT category_key FROM document_request_items WHERE id = $4),
                 $5,$6,$7,$8,$9,$10,$11,'client_upload',$12,now(),$13,$4)
         RETURNING id`,
        [
          request.organization_id, request.application_id, request.customer_id, itemId ?? null,
          file.originalname, item?.label ?? file.originalname, file.mimetype,
          stored.bytes, stored.sha256, stored.driver, stored.key, scan.status, scan.detail ?? null,
        ],
      );
      const id = rows[0]!.id;
      if (itemId) await markItemReceived(client, itemId);

      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_kind,
                               actor_name, summary, entity_type, entity_id)
         VALUES ($1,$2,$3,'document','client',$4,$5,'document',$6)`,
        [request.organization_id, request.application_id, request.customer_id,
         request.first_name ?? 'The client',
         `${request.first_name ?? 'The client'} uploaded ${item?.label ?? file.originalname}`, id],
      );
      await client.query(
        `UPDATE applications SET last_activity_at = now() WHERE id = $1`,
        [request.application_id],
      );
      await recordAudit(
        {
          organizationId: request.organization_id,
          actor: { kind: 'client', name: request.first_name ?? 'Client', ip: req.ip },
          action: 'document.client_upload',
          entityType: 'document',
          entityId: id,
          summary: `Client uploaded ${item?.label ?? file.originalname}`,
        },
        client,
      );
      return id;
    });

    await refreshOutstanding(request.application_id);
    await notifyAssigned(request, item?.label ?? file.originalname);

    const { rows: items } = await query(
      `SELECT id, label, required, status FROM document_request_items
        WHERE document_request_id = $1 ORDER BY position`,
      [request.id],
    );
    const outstanding = items.filter((i) => i.required && i.status === 'outstanding').length;

    res.status(201).json({
      ok: true,
      id: documentId,
      items,
      outstanding,
      // Confirmed plainly, because a client who is not sure it worked uploads
      // it three more times.
      message: outstanding === 0
        ? 'That is everything — thank you. Your broker has been notified.'
        : `Received. ${outstanding} document${outstanding === 1 ? '' : 's'} still to come.`,
    });
  }),
);

/**
 * Tell the people looking after the file.
 *
 * Deduplicated per request per day: a client uploading six documents in four
 * minutes should not ring the bell six times.
 */
async function notifyAssigned(request: RequestRow, label: string): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await query(
      // Both casts are load-bearing. `$3` is an application id used as a uuid
      // in the WHERE and as text in entity_id, and without them Postgres
      // refuses with "inconsistent types deduced for parameter $3".
      //
      // The ON CONFLICT predicate is load-bearing too: notifications_dedupe_key
      // is a PARTIAL unique index, and Postgres will not use one to arbitrate
      // unless the statement repeats its WHERE.
      `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type,
                                  entity_id, link, dedupe_key)
       SELECT $1, a.user_id, 'document',
              COALESCE(c.first_name || ' ' || c.last_name, 'A client') || ' uploaded a document',
              $2, 'application', $3::text, $4, $5
         FROM assignments a
         JOIN applications app ON app.id = a.application_id
         JOIN customers c ON c.id = app.customer_id
        WHERE a.application_id = $3::uuid AND a.unassigned_at IS NULL
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET at = now(), read_at = NULL`,
      [
        request.organization_id, label, request.application_id,
        `${env.BASE_PATH}/applications/${request.application_id}`,
        `docupload:${request.id}:${day}`,
      ],
    );
  } catch (err) {
    // A failed notification must not fail the client's upload.
    log.error('could not notify about a client upload', { error: err });
  }
}

/**
 * The upload page itself.
 *
 * Served as its own small HTML document rather than the CRM bundle: a client
 * should not download a mortgage CRM to send a photo of a pay stub, and the
 * page must work on an old phone on a bad connection. Camera capture is
 * offered because most of these are photographed, not scanned.
 */
publicRoutes.get(
  '/upload/:token',
  lookupLimiter,
  asyncRoute(async (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    // Its own policy, and a tight one. This page is a single self-contained
    // document with one inline script and one inline stylesheet; it loads
    // nothing, connects nowhere but here, and cannot be framed.
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; " +
        `script-src 'sha256-${uploadPageScriptHash()}'; ` +
        "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
        "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.send(UPLOAD_PAGE.replace(/__BASE__/g, env.BASE_PATH));
  }),
);

/**
 * The hash of the page's inline script, for its own CSP.
 *
 * Computed from the served text rather than pasted in, so editing the script
 * cannot leave a policy that silently blocks it — which has happened once in
 * this codebase already.
 */
let cachedScriptHash: string | null = null;
function uploadPageScriptHash(): string {
  if (cachedScriptHash) return cachedScriptHash;
  const page = UPLOAD_PAGE.replace(/__BASE__/g, env.BASE_PATH);
  const match = page.match(/<script>([\s\S]*?)<\/script>/);
  cachedScriptHash = createHash('sha256').update(match?.[1] ?? '', 'utf8').digest('base64');
  return cachedScriptHash;
}

const UPLOAD_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Upload your documents — Lendmax</title>
<style>
  :root{--bg:#f6f8fb;--card:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;
        --accent:#4f46e5;--ok:#10b981;--danger:#ef4444;--radius:12px}
  @media (prefers-color-scheme:dark){:root{--bg:#020617;--card:#0d1526;--text:#e8edf5;
        --muted:#94a3b8;--line:rgba(255,255,255,.1);--accent:#6366f1}}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
       background:var(--bg);color:var(--text);padding:20px 16px 48px}
  .wrap{max-width:560px;margin:0 auto}
  h1{font-size:21px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 22px;font-size:15px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
        padding:16px;margin-bottom:12px}
  .item{display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}
  .item:last-child{border-bottom:0}
  .item .name{font-weight:600}
  .item .desc{color:var(--muted);font-size:14px;margin-top:2px}
  .tick{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);flex:0 0 auto;
        display:grid;place-items:center;font-size:13px;margin-top:2px}
  .done .tick{background:var(--ok);border-color:var(--ok);color:#fff}
  .done .name{text-decoration:line-through;color:var(--muted)}
  .btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:9px;
       padding:11px 16px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;
       -webkit-tap-highlight-color:transparent}
  .btn:disabled{opacity:.55}
  .btn-sm{padding:8px 13px;font-size:14px}
  .msg{padding:12px 14px;border-radius:9px;margin-bottom:12px;font-size:15px}
  .msg-ok{background:rgba(16,185,129,.12);color:var(--ok)}
  .msg-err{background:rgba(239,68,68,.12);color:var(--danger)}
  .foot{color:var(--muted);font-size:13px;text-align:center;margin-top:22px;line-height:1.6}
  input[type=file]{display:none}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);
        border-top-color:#fff;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
  @keyframes s{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
</head><body>
<div class="wrap" id="root">
  <p class="sub">Loading…</p>
</div>
<script>
(function () {
  var token = location.pathname.split('/').pop();
  var api = '__BASE__/api/upload/' + encodeURIComponent(token);
  var root = document.getElementById('root');
  var state = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function notice(text, kind) {
    var el = document.getElementById('notice');
    if (!el) return;
    el.className = 'msg msg-' + kind;
    el.textContent = text;
    el.style.display = 'block';
  }

  function render() {
    if (!state) return;
    var outstanding = state.items.filter(function (i) {
      return i.required && i.status === 'outstanding';
    }).length;

    root.innerHTML =
      '<h1>' + (state.client_first_name ? 'Hi ' + esc(state.client_first_name) + ',' : 'Your documents') + '</h1>' +
      '<p class="sub">' +
        (state.message ? esc(state.message) : 'Please send us the documents below.') +
      '</p>' +
      '<div id="notice" style="display:none"></div>' +
      (outstanding === 0
        ? '<div class="msg msg-ok">That is everything — thank you. ' +
          (state.requested_by ? esc(state.requested_by) + ' has been notified.' : '') + '</div>'
        : '') +
      '<div class="card">' +
        state.items.map(function (item) {
          var done = item.status !== 'outstanding';
          return '<div class="item' + (done ? ' done' : '') + '">' +
            '<div class="tick">' + (done ? '&#10003;' : '') + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div class="name">' + esc(item.label) +
                (item.required ? '' : ' <span style="color:var(--muted);font-weight:400">(optional)</span>') +
              '</div>' +
              (item.description ? '<div class="desc">' + esc(item.description) + '</div>' : '') +
              (done ? '<div class="desc">Received</div>' : '') +
            '</div>' +
            (done ? '' :
              '<button class="btn btn-sm" data-item="' + esc(item.id) + '">Add</button>') +
          '</div>';
        }).join('') +
      '</div>' +
      '<p class="foot">' +
        'A photo from your phone is fine, as long as all four corners and the text are clear.<br>' +
        'PDF, JPG, PNG or an Office document, up to ' +
        Math.round(state.max_bytes / 1024 / 1024) + ' MB each.<br><br>' +
        'This link is private to you. Please do not forward it.' +
      '</p>';

    Array.prototype.forEach.call(root.querySelectorAll('button[data-item]'), function (button) {
      button.addEventListener('click', function () { pick(button.getAttribute('data-item'), button); });
    });
  }

  function pick(itemId, button) {
    var input = document.createElement('input');
    input.type = 'file';
    // Photographs are what most of these are, so the camera is offered first.
    input.accept = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv';
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) upload(itemId, input.files[0], button);
    });
    input.click();
  }

  function upload(itemId, file, button) {
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>';
    var form = new FormData();
    form.append('file', file);
    form.append('item_id', itemId);

    fetch(api, { method: 'POST', body: form })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || res.body.ok === false) {
          notice(res.body.error || 'That did not upload. Please try again.', 'err');
          button.disabled = false;
          button.textContent = 'Add';
          return;
        }
        state.items = res.body.items;
        render();
        notice(res.body.message, 'ok');
      })
      .catch(function () {
        notice('We could not reach the server. Check your connection and try again.', 'err');
        button.disabled = false;
        button.textContent = 'Add';
      });
  }

  fetch(api)
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok || res.body.ok === false) {
        root.innerHTML = '<h1>This link is not available</h1><p class="sub">' +
          esc(res.body.error || 'Please get in touch with your broker.') + '</p>';
        return;
      }
      state = res.body;
      render();
    })
    .catch(function () {
      root.innerHTML = '<h1>Could not load</h1>' +
        '<p class="sub">Check your connection and refresh the page.</p>';
    });
})();
</script>
</body></html>`;

// ── Unsubscribe ────────────────────────────────────────────────────────────

/**
 * The unsubscribe page.
 *
 * One click, no sign-in, no "are you sure" maze, and it works from a link in
 * an email a client kept for two years. What it does NOT do is unsubscribe
 * on a GET: mail clients and security scanners fetch every link in a
 * message, and a GET that changes state means a scanner silently
 * unsubscribes people who never touched it.
 *
 * The page distinguishes commercial mail from the messages about the
 * client's own mortgage, because a client who unsubscribes from rate updates
 * has not asked to stop hearing about their closing — and stopping those
 * would be a worse failure than the one being prevented.
 */
publicRoutes.get(
  '/u/:token',
  lookupLimiter,
  asyncRoute(async (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; " +
        `script-src 'sha256-${unsubscribePageScriptHash()}'; ` +
        "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
        "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.send(UNSUBSCRIBE_PAGE.replace(/__BASE__/g, env.BASE_PATH));
  }),
);

publicRoutes.get(
  '/api/u/:token',
  lookupLimiter,
  asyncRoute(async (req, res) => {
    const token = z.string().min(20).max(200).parse(req.params.token);
    const found = await resolveUnsubscribe(token);
    if (!found) {
      res.status(404).json({
        ok: false,
        error: 'This link is not valid. Reply to the email and we will take you off the list.',
      });
      return;
    }
    res.json({
      ok: true,
      first_name: found.first_name,
      organization_name: found.organization_name,
      already: found.already,
    });
  }),
);

publicRoutes.post(
  '/api/u/:token',
  lookupLimiter,
  asyncRoute(async (req, res) => {
    const token = z.string().min(20).max(200).parse(req.params.token);
    const scope = z.object({ scope: z.enum(['marketing', 'all']).default('marketing') })
      .parse(req.body ?? {}).scope;

    const found = await resolveUnsubscribe(token);
    if (!found) {
      res.status(404).json({ ok: false, error: 'This link is not valid.' });
      return;
    }

    await query(
      `INSERT INTO suppressions (organization_id, customer_id, address, channel, scope, reason,
                                 detail)
       VALUES ($1,$2,$3,'email',$4,'unsubscribe','Unsubscribed from a link in an email.')`,
      [found.organization_id, found.customer_id, found.address ?? '', scope]);

    // Recorded as a consent change too, so the client's own file shows it
    // rather than only the suppression list.
    await query(
      `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted,
                             source, consent_text)
       VALUES ($1,$2,'email','marketing','withdrawn',false,'unsubscribe_link',
               'Unsubscribed using the link in an email.')`,
      [found.organization_id, found.customer_id]);

    await query(
      `UPDATE campaign_recipients SET unsubscribed_at = now()
        WHERE customer_id = $1 AND unsubscribed_at IS NULL
          AND sent_at > now() - interval '90 days'`,
      [found.customer_id]);

    await query(
      `INSERT INTO domain_events (organization_id, event_type, customer_id, payload, dedupe_key)
       VALUES ($1,'consent.changed',$2,$3::jsonb,$4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [found.organization_id, found.customer_id,
       JSON.stringify({ change: 'unsubscribed', scope }),
       `unsubscribe:${found.customer_id}:${Date.now()}`]);

    recordAuditSafely({
      organizationId: found.organization_id,
      actor: { kind: 'client', name: `${found.first_name} (via an email link)`, ip: req.ip },
      action: 'consent.unsubscribe',
      entityType: 'customer',
      entityId: found.customer_id,
      summary: scope === 'all'
        ? 'Client asked to stop all email using the unsubscribe link'
        : 'Client unsubscribed from marketing email using the link',
    });

    res.json({
      ok: true,
      scope,
      message: scope === 'all'
        ? 'Done. We will not email you again.'
        : 'Done. You will not receive rate updates or news from us again. We will still '
          + 'email you about a mortgage you have asked us to arrange.',
    });
  }),
);

/**
 * Resolve a token without being told which organisation it belongs to.
 *
 * The signature is over the organisation and the customer together, so this
 * tries each organisation rather than trusting anything in the URL.
 */
async function resolveUnsubscribe(token: string): Promise<{
  organization_id: string; customer_id: string; first_name: string;
  organization_name: string; address: string | null; already: boolean;
} | null> {
  const { rows: organizations } = await query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations');
  for (const organization of organizations) {
    const customerId = verifyUnsubscribeToken(token, organization.id);
    if (!customerId) continue;
    const customer = await queryOne<{
      first_name: string; email: string | null; already: boolean;
    }>(
      `SELECT c.first_name, c.email,
              EXISTS (SELECT 1 FROM suppressions s
                       WHERE s.customer_id = c.id AND s.channel = 'email'
                         AND s.removed_at IS NULL) AS already
         FROM customers c WHERE c.id = $1 AND c.organization_id = $2`,
      [customerId, organization.id]);
    if (!customer) continue;
    return {
      organization_id: organization.id,
      customer_id: customerId,
      first_name: customer.first_name,
      organization_name: organization.name,
      address: customer.email,
      already: customer.already,
    };
  }
  return null;
}

let cachedUnsubscribeHash: string | null = null;
function unsubscribePageScriptHash(): string {
  if (cachedUnsubscribeHash) return cachedUnsubscribeHash;
  const page = UNSUBSCRIBE_PAGE.replace(/__BASE__/g, env.BASE_PATH);
  const match = page.match(/<script>([\s\S]*?)<\/script>/);
  cachedUnsubscribeHash = createHash('sha256').update(match?.[1] ?? '', 'utf8').digest('base64');
  return cachedUnsubscribeHash;
}

/**
 * Its own small document, like the upload page. A client should not download
 * a mortgage CRM to press one button, and this page has to work on an old
 * phone from a link in a two-year-old email.
 */
const UNSUBSCRIBE_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email preferences</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f8fafc; color: #0f172a;
  }
  .card {
    background: #fff; border-radius: 14px; padding: 28px; max-width: 480px; width: 100%;
    box-shadow: 0 10px 30px -10px rgba(15,23,42,.18);
  }
  h1 { font-size: 21px; margin: 0 0 10px; }
  p { margin: 0 0 14px; }
  button {
    width: 100%; padding: 13px; border-radius: 9px; border: 0; font-size: 16px;
    font-weight: 600; cursor: pointer; background: #4f46e5; color: #fff; margin-bottom: 9px;
  }
  button.secondary { background: #fff; color: #334155; border: 1px solid #cbd5e1; }
  button:disabled { opacity: .55; cursor: default; }
  .muted { color: #64748b; font-size: 14px; }
  .done { color: #065f46; }
  .error { color: #991b1b; }
  @media (prefers-color-scheme: dark) {
    body { background: #020617; color: #e8edf5; }
    .card { background: #0d1526; box-shadow: none; }
    button.secondary { background: transparent; color: #cbd5e1; border-color: #334155; }
    .muted { color: #94a3b8; }
    .done { color: #6ee7b7; } .error { color: #fca5a5; }
  }
</style>
</head><body>
<div class="card" id="card">
  <h1 id="title">One moment…</h1>
  <div id="body"></div>
</div>
<script>
(function () {
  var base = "__BASE__";
  var token = location.pathname.split("/u/")[1] || "";
  var title = document.getElementById("title");
  var body = document.getElementById("body");

  function text(tag, value, cls) {
    var el = document.createElement(tag);
    el.textContent = value;
    if (cls) el.className = cls;
    return el;
  }

  fetch(base + "/api/u/" + encodeURIComponent(token))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok) {
        title.textContent = "This link is not valid";
        body.appendChild(text("p", d.error || "Reply to the email and we will take you off the list."));
        return;
      }
      title.textContent = d.already
        ? "You are already unsubscribed"
        : "Stop receiving these emails?";
      body.appendChild(text("p",
        (d.first_name ? "Hi " + d.first_name + ". " : "") +
        (d.already
          ? "You are not on " + d.organization_name + "'s mailing list."
          : "One click and " + d.organization_name + " will stop sending you rate updates and news.")));

      if (d.already) return;

      var marketing = document.createElement("button");
      marketing.textContent = "Unsubscribe";
      var all = document.createElement("button");
      all.className = "secondary";
      all.textContent = "Stop all email from " + d.organization_name;

      function send(scope, button) {
        marketing.disabled = true; all.disabled = true;
        button.textContent = "Saving…";
        fetch(base + "/api/u/" + encodeURIComponent(token), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: scope })
        }).then(function (r) { return r.json(); }).then(function (result) {
          body.innerHTML = "";
          title.textContent = "Done";
          body.appendChild(text("p", result.message || "You have been unsubscribed.", "done"));
        }).catch(function () {
          body.appendChild(text("p", "That did not save. Please try again.", "error"));
          marketing.disabled = false; all.disabled = false;
        });
      }

      marketing.onclick = function () { send("marketing", marketing); };
      all.onclick = function () { send("all", all); };
      body.appendChild(marketing);
      body.appendChild(all);
      body.appendChild(text("p",
        "Unsubscribing from the mailing list does not stop emails about a mortgage you have "
        + "asked us to arrange.", "muted"));
    })
    .catch(function () {
      title.textContent = "Something went wrong";
      body.appendChild(text("p", "Please try again, or reply to the email.", "error"));
    });
})();
</script>
</body></html>`;
