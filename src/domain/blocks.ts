/**
 * Campaign content: typed blocks, rendered by one renderer.
 *
 * A campaign is an ordered list of typed blocks, never raw pasted HTML. The
 * reason is not tidiness: HTML pasted from a designer's tool is the single
 * most reliable way to produce an email that renders correctly in the
 * preview and is unreadable on a phone, and it makes the unsubscribe link
 * something a person has to remember to include.
 *
 * So: blocks in, HTML and plain text out, both from here. A block type that
 * gains a feature gains it everywhere at once, and the footer — physical
 * address and unsubscribe, which CASL requires on commercial messages — is
 * appended by the renderer rather than being somebody's job to remember.
 */
import { z } from 'zod';
import { renderTemplate, type MergeContext } from './merge-fields.ts';

const Base = z.object({ id: z.string().optional() });

export const BlockSchema = z.discriminatedUnion('type', [
  Base.extend({ type: z.literal('heading'), text: z.string(), level: z.union([
    z.literal(1), z.literal(2), z.literal(3)]).default(2) }),
  Base.extend({ type: z.literal('text'), text: z.string() }),
  Base.extend({
    type: z.literal('button'),
    label: z.string(),
    href: z.string(),
  }),
  Base.extend({ type: z.literal('divider') }),
  Base.extend({ type: z.literal('spacer'), size: z.number().int().min(4).max(96).default(24) }),
  Base.extend({
    type: z.literal('image'),
    src: z.string(),
    alt: z.string(),
    href: z.string().optional(),
  }),
  Base.extend({
    type: z.literal('columns'),
    columns: z.array(z.object({ heading: z.string().optional(), text: z.string() })).min(2).max(3),
  }),
  Base.extend({
    type: z.literal('rate_table'),
    caption: z.string().optional(),
    rows: z.array(z.object({
      term: z.string(), rate: z.string(), note: z.string().optional(),
    })).default([]),
  }),
  Base.extend({ type: z.literal('signature') }),
]);
export type Block = z.infer<typeof BlockSchema>;

export type Footer = {
  organizationName: string;
  /** Required on a commercial message. */
  physicalAddress: string | null;
  unsubscribeUrl: string;
  brokerageLicence?: string | null;
};

export type RenderedCampaign = {
  html: string;
  text: string;
  /** Merge fields the content asked for that had no value. */
  missing: string[];
  /** Blocks dropped because every line in them was unresolved. */
  dropped: string[];
  problems: string[];
};

/**
 * What a campaign cannot be sent without.
 *
 * Checked before sending rather than at save time, because a draft is
 * allowed to be half-finished.
 */
export function sendBlockers(
  blocks: Block[],
  options: { channel: 'email' | 'sms'; purpose: string; subject?: string | null;
             footer: Footer },
): string[] {
  const problems: string[] = [];
  if (!blocks.length) problems.push('There is nothing in it.');
  if (options.channel === 'email' && !options.subject?.trim()) {
    problems.push('It has no subject line.');
  }
  if (options.purpose === 'marketing') {
    // CASL requires an identification of the sender and an unsubscribe
    // mechanism on a commercial electronic message. The unsubscribe is added
    // by the renderer; the mailing address has to be configured.
    if (!options.footer.physicalAddress) {
      problems.push(
        'A commercial message must carry the brokerage’s mailing address, and none is '
        + 'configured. Set it under Settings → Brokerage.');
    }
  }
  for (const block of blocks) {
    if (block.type === 'button' && !block.href.trim()) {
      problems.push(`The button "${block.label}" has no link.`);
    }
    if (block.type === 'image' && !block.alt.trim()) {
      // An image with no alt text is an email that reads as blank with
      // images off, which is how most clients read it.
      problems.push('An image has no alt text.');
    }
  }
  return problems;
}

/** Render one campaign for one recipient. */
export function renderCampaign(
  blocks: Block[],
  context: MergeContext,
  footer: Footer,
  options: { channel: 'email' | 'sms'; purpose: string; preheader?: string | null } = {
    channel: 'email', purpose: 'marketing',
  },
): RenderedCampaign {
  const missing = new Set<string>();
  const dropped: string[] = [];
  const problems: string[] = [];
  const html: string[] = [];
  const text: string[] = [];

  const merge = (source: string): string | null => {
    const result = renderTemplate(source, context);
    for (const field of result.missing) missing.add(field);
    for (const line of result.dropped) dropped.push(line);
    return result.empty ? null : result.text;
  };

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const value = merge(block.text);
        if (value === null) break;
        html.push(`<h${block.level} style="${HEADING[block.level]}">${escape(value)}</h${block.level}>`);
        text.push(`\n${value.toUpperCase()}\n`);
        break;
      }
      case 'text': {
        const value = merge(block.text);
        if (value === null) break;
        for (const paragraph of value.split(/\n{2,}/)) {
          html.push(`<p style="${P}">${escape(paragraph).replace(/\n/g, '<br>')}</p>`);
          text.push(paragraph);
        }
        break;
      }
      case 'button': {
        const label = merge(block.label);
        const href = merge(block.href);
        if (label === null || href === null) {
          // A button whose link did not resolve is dropped rather than
          // rendered pointing nowhere.
          dropped.push(`Button: ${block.label}`);
          break;
        }
        html.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0">`
          + `<tr><td style="${BUTTON_CELL}">`
          + `<a href="${escapeAttr(href)}" style="${BUTTON}">${escape(label)}</a>`
          + `</td></tr></table>`);
        text.push(`${label}: ${href}`);
        break;
      }
      case 'divider':
        html.push(`<hr style="${HR}">`);
        text.push('\n———\n');
        break;
      case 'spacer':
        html.push(`<div style="height:${block.size}px;line-height:${block.size}px">&nbsp;</div>`);
        break;
      case 'image': {
        const href = block.href ? merge(block.href) : null;
        const img = `<img src="${escapeAttr(block.src)}" alt="${escapeAttr(block.alt)}"`
          + ` style="max-width:100%;height:auto;display:block;border:0">`;
        html.push(href ? `<a href="${escapeAttr(href)}">${img}</a>` : img);
        // The alt text is what most people actually read, so it goes into
        // the plain-text part rather than being dropped.
        text.push(`[${block.alt}]${href ? ` ${href}` : ''}`);
        break;
      }
      case 'columns': {
        const cells = block.columns.map((column) => ({
          heading: column.heading ? merge(column.heading) : null,
          text: merge(column.text),
        })).filter((cell) => cell.text !== null);
        if (!cells.length) break;
        const width = Math.floor(100 / cells.length);
        html.push(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`
          + cells.map((cell) =>
            `<td width="${width}%" valign="top" style="padding:0 8px 0 0">`
            + (cell.heading ? `<h3 style="${HEADING[3]}">${escape(cell.heading)}</h3>` : '')
            + `<p style="${P}">${escape(cell.text!)}</p></td>`).join('')
          + `</tr></table>`);
        for (const cell of cells) {
          if (cell.heading) text.push(cell.heading.toUpperCase());
          text.push(cell.text!);
        }
        break;
      }
      case 'rate_table': {
        if (!block.rows.length) break;
        html.push(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${TABLE}">`
          + (block.caption ? `<caption style="${CAPTION}">${escape(block.caption)}</caption>` : '')
          + block.rows.map((row) =>
            `<tr><td style="${TD}">${escape(row.term)}</td>`
            + `<td style="${TD};text-align:right;font-weight:600">${escape(row.rate)}</td>`
            + (row.note ? `<td style="${TD};color:#64748b">${escape(row.note)}</td>` : '')
            + `</tr>`).join('')
          + `</table>`);
        if (block.caption) text.push(block.caption);
        for (const row of block.rows) {
          text.push(`  ${row.term}: ${row.rate}${row.note ? ` (${row.note})` : ''}`);
        }
        break;
      }
      case 'signature': {
        // The sender's own signature, when they have one. It was rendered
        // from escaped text by domain/signature.ts, so it is safe to place
        // as HTML here.
        const own = context.values.user_signature_html;
        const ownText = context.values.signature;
        if (typeof own === 'string' && own && typeof ownText === 'string' && ownText) {
          html.push(own);
          text.push(`\n${ownText}`);
          break;
        }
        const name = merge('{user_name}');
        if (name === null) {
          problems.push('The signature block has no name to sign with.');
          break;
        }
        const cell = merge('{user_cell}');
        html.push(`<p style="${P}">${escape(name)}<br>${escape(footer.organizationName)}`
          + (cell ? `<br>${escape(cell)}` : '') + `</p>`);
        text.push(`\n${name}\n${footer.organizationName}${cell ? `\n${cell}` : ''}`);
        break;
      }
    }
  }

  // The footer is appended here rather than being a block somebody can
  // forget to add or delete.
  const needsFooter = options.purpose === 'marketing' || options.purpose === 'service';
  if (needsFooter) {
    html.push(`<hr style="${HR}">`);
    html.push(`<p style="${FOOTER}">`
      + escape(footer.organizationName)
      + (footer.brokerageLicence ? ` &middot; ${escape(footer.brokerageLicence)}` : '')
      + (footer.physicalAddress ? `<br>${escape(footer.physicalAddress)}` : '')
      + `<br><a href="${escapeAttr(footer.unsubscribeUrl)}" style="color:#64748b">`
      + `Unsubscribe from these messages</a></p>`);
    text.push('\n———');
    text.push(footer.organizationName
      + (footer.brokerageLicence ? ` · ${footer.brokerageLicence}` : ''));
    if (footer.physicalAddress) text.push(footer.physicalAddress);
    text.push(`Unsubscribe: ${footer.unsubscribeUrl}`);
  }

  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">`
      + `${escape(options.preheader)}</div>`
    : '';

  return {
    html: DOCUMENT(preheader + html.join('\n')),
    text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    missing: [...missing],
    dropped,
    problems,
  };
}

/** The SMS body: the text blocks only, footered with the stop instruction. */
export function renderSms(
  blocks: Block[],
  context: MergeContext,
  options: { purpose: string } = { purpose: 'marketing' },
): { text: string; missing: string[] } {
  const rendered = renderCampaign(blocks, context, {
    organizationName: '', physicalAddress: null, unsubscribeUrl: '',
  }, { channel: 'sms', purpose: 'transactional' });
  const body = rendered.text.trim();
  return {
    // CRTC: a commercial text carries a way to stop it, and STOP is the one
    // every carrier already honours.
    text: options.purpose === 'marketing' ? `${body}\n\nReply STOP to opt out.` : body,
    missing: rendered.missing,
  };
}

// ── Styles, inline because that is what email clients read ─────────────────

const P = 'margin:0 0 14px;font-size:15px;line-height:1.6;color:#0f172a';
const HEADING: Record<number, string> = {
  1: 'margin:0 0 14px;font-size:24px;line-height:1.3;color:#0f172a;font-weight:650',
  2: 'margin:22px 0 10px;font-size:19px;line-height:1.35;color:#0f172a;font-weight:640',
  3: 'margin:18px 0 8px;font-size:16px;line-height:1.4;color:#0f172a;font-weight:620',
};
const HR = 'border:0;border-top:1px solid #e2e8f0;margin:22px 0';
const BUTTON_CELL = 'border-radius:8px;background:#4f46e5';
const BUTTON = 'display:inline-block;padding:11px 22px;color:#ffffff;text-decoration:none;'
  + 'font-size:15px;font-weight:600';
const TABLE = 'border-collapse:collapse;margin:14px 0';
const CAPTION = 'text-align:left;font-size:13px;color:#64748b;padding-bottom:6px';
const TD = 'padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:14px';
const FOOTER = 'margin:0;font-size:12px;line-height:1.6;color:#64748b';

const DOCUMENT = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1">`
  + `</head><body style="margin:0;padding:0;background:#f8fafc">`
  + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`
  + ` style="background:#f8fafc;padding:24px 12px"><tr><td align="center">`
  + `<table role="presentation" width="600" cellpadding="0" cellspacing="0"`
  + ` style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;padding:28px;`
  + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`
  + `<tr><td>${body}</td></tr></table></td></tr></table></body></html>`;

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  // A javascript: or data: URL in an email is either blocked or dangerous,
  // and in a campaign builder it is somebody pasting the wrong thing.
  const safe = /^(https?:|mailto:|tel:)/i.test(value.trim()) ? value.trim() : '#';
  return escape(safe);
}
