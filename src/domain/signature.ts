/**
 * Email signatures.
 *
 * A signature is written as a few lines of text, not as HTML. Three reasons:
 *   · A broker can write one without knowing HTML, and cannot paste in
 *     something that breaks in Outlook or carries a tracking pixel.
 *   · Every character a person types is escaped before it becomes HTML, so a
 *     signature cannot inject markup into a client's inbox.
 *   · The same source gives the HTML part and the plain-text part, so the two
 *     never disagree.
 *
 * What a line may contain:
 *   {name} {first_name} {title} {brokerage} {licence} {mobile} {direct}
 *   {office} {email} {booking_link}  — filled from the profile, so a new
 *                                      phone number reaches every signature
 *   **bold**                         — the only formatting
 *   a URL or an email address        — linked automatically
 *
 * A line whose field has no value is left out entirely, the same rule as
 * every message template: "Direct: " with nothing after it looks like a
 * mistake in front of a client.
 */

export type SignatureProfile = {
  name: string;
  title?: string | null;
  licence_number?: string | null;
  licence_province?: string | null;
  mobile_phone?: string | null;
  direct_phone?: string | null;
  office_phone?: string | null;
  email?: string | null;
  booking_url?: string | null;
  organization_name?: string | null;
};

export const SIGNATURE_FIELDS: Array<{ token: string; label: string }> = [
  { token: 'name', label: 'Full name' },
  { token: 'first_name', label: 'First name' },
  { token: 'title', label: 'Title' },
  { token: 'brokerage', label: 'Brokerage' },
  { token: 'licence', label: 'Licence' },
  { token: 'mobile', label: 'Mobile' },
  { token: 'direct', label: 'Direct line' },
  { token: 'office', label: 'Office' },
  { token: 'email', label: 'Email' },
  { token: 'booking_link', label: 'Booking link' },
];

/** The standard signature — what everybody has until they write their own. */
export const STANDARD_SIGNATURE = [
  '**{name}**',
  '{title}',
  '{brokerage}',
  'Licence {licence}',
  'Mobile {mobile}',
  'Direct {direct}',
  'Office {office}',
  '{email}',
  'Book a time with me: {booking_link}',
].join('\n');

export const SIGNATURE_LIMITS = { characters: 1000, lines: 15 };

/** (416) 555-0142 from +14165550142; anything else as it was stored. */
export function formatPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

function values(p: SignatureProfile): Record<string, string | null> {
  const licence = p.licence_number
    ? `${p.licence_number}${p.licence_province ? ` (${p.licence_province})` : ''}`
    : null;
  const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    name: blank(p.name),
    first_name: blank(p.name?.split(/\s+/)[0]),
    title: blank(p.title),
    brokerage: blank(p.organization_name),
    licence,
    mobile: formatPhone(blank(p.mobile_phone)),
    direct: formatPhone(blank(p.direct_phone)),
    office: formatPhone(blank(p.office_phone)),
    email: blank(p.email),
    booking_link: blank(p.booking_url),
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const LINK = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const TOKEN = /\{([a-z_]+)\}/g;
const PHONE_TOKENS = new Set(['mobile', 'direct', 'office']);

/**
 * One line of signature source to HTML. Escaped first, then the only three
 * things that become markup: bold, links, and phone numbers from the profile
 * as tap-to-call links.
 */
function lineToHtml(line: string, v: Record<string, string | null>, dial: Record<string, string>): string {
  // Tokens are swapped for placeholders before escaping, so a phone number
  // can become a tel: link without the profile value being trusted as HTML.
  const slots: string[] = [];
  const withSlots = line.replace(TOKEN, (_m, token: string) => {
    const value = v[token] ?? '';
    const html = PHONE_TOKENS.has(token) && value
      ? `<a href="tel:${escapeHtml(dial[token] ?? value.replace(/[^\d+]/g, ''))}" style="color:inherit;text-decoration:none">${escapeHtml(value)}</a>`
      : null;
    slots.push(html ?? '');
    return html ? `\u0000${slots.length - 1}\u0000` : value;
  });

  let html = escapeHtml(withSlots)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(LINK, (match) => {
      const href = match.includes('@') && !match.startsWith('http') ? `mailto:${match}` : match;
      return `<a href="${href}" style="color:#4f46e5;text-decoration:none">${match}</a>`;
    });
  html = html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
  return html;
}

export type RenderedSignature = { html: string; text: string; problems: string[] };

export function renderSignature(source: string, profile: SignatureProfile): RenderedSignature {
  const v = values(profile);
  // What a phone taps through to: the stored number, country code and all,
  // not the formatted one that is shown.
  const dial: Record<string, string> = {};
  for (const [token, stored] of [['mobile', profile.mobile_phone], ['direct', profile.direct_phone],
                                  ['office', profile.office_phone]] as const) {
    if (stored) dial[token] = stored.replace(/[^\d+]/g, '');
  }
  const problems: string[] = [];
  const trimmed = source.replace(/\r\n?/g, '\n').trim();

  if (trimmed.length > SIGNATURE_LIMITS.characters) {
    problems.push(`A signature can be at most ${SIGNATURE_LIMITS.characters} characters.`);
  }
  const unknown = new Set<string>();
  for (const [, token] of trimmed.matchAll(TOKEN)) if (!(token! in v)) unknown.add(token!);
  if (unknown.size) {
    problems.push(`${[...unknown].map((t) => `{${t}}`).join(', ')} ${unknown.size === 1 ? 'is not a field' : 'are not fields'}. ` +
      `The fields are ${SIGNATURE_FIELDS.map((f) => `{${f.token}}`).join(' ')}.`);
  }

  const kept: string[] = [];
  for (const raw of trimmed.split('\n')) {
    const line = raw.trimEnd();
    const tokens = [...line.matchAll(TOKEN)].map((m) => m[1]!);
    // A line with a field that has no value is dropped, not printed half-empty.
    if (tokens.some((t) => !v[t])) continue;
    // Blank lines are kept as spacing, but never two in a row or at the ends.
    if (!line.trim() && (!kept.length || !kept[kept.length - 1]!.trim())) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();

  if (kept.length > SIGNATURE_LIMITS.lines) {
    problems.push(`A signature can be at most ${SIGNATURE_LIMITS.lines} lines.`);
  }

  const text = kept
    .map((line) => line.replace(TOKEN, (_m, t: string) => v[t] ?? '').replace(/\*\*(.+?)\*\*/g, '$1'))
    .join('\n');
  const html = kept.length
    ? '<div class="lmx-signature" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;' +
      'line-height:1.5;color:#334155;margin-top:16px">' +
      kept.map((line) => (line.trim() ? lineToHtml(line, v, dial) : '&nbsp;')).join('<br>') +
      '</div>'
    : '';

  return { html, text, problems };
}

/**
 * A plain-text email body as HTML, for when a signature is appended to a
 * message that was written as text. Escaped, paragraphs kept, links linked.
 */
export function textToHtml(body: string): string {
  return body.replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 12px">${escapeHtml(para).replace(LINK, (m) => {
      const href = m.includes('@') && !m.startsWith('http') ? `mailto:${m}` : m;
      return `<a href="${href}">${m}</a>`;
    }).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
