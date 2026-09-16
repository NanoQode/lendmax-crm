/**
 * Merge fields.
 *
 * `Hi {first_name}, your mortgage matures on {maturity_date}.`
 *
 * THE RULE THIS MODULE EXISTS FOR: never fabricate a personalised fact.
 *
 * A template that renders "Hi , your mortgage matures on ." is embarrassing.
 * A template that renders "Hi there, I noticed your rate of 0%" is worse — it
 * is a false statement about somebody's mortgage, sent in a broker's name. So
 * an unresolved field does not render as blank and does not render as zero:
 * the SENTENCE CONTAINING IT IS DROPPED, and if the whole message would be
 * empty the render fails and the send does not happen.
 *
 * The registry is closed. A template referring to a field that does not exist
 * is caught when it is saved, not when it reaches a client — and a field that
 * is not on the list cannot be reached from a template at all, which is what
 * stops somebody adding `{password_hash}` to an email footer.
 */

export type MergeContext = { values: Record<string, unknown> };

export type FieldSpec = {
  name: string;
  label: string;
  /** How the value is rendered. */
  format?: 'text' | 'money' | 'date' | 'days' | 'percent' | 'url';
  example: string;
};

/**
 * Every field a template may use.
 *
 * Deliberately excludes everything sensitive: no date of birth, no income, no
 * identification, no credit detail. A merge field is a value that ends up in a
 * message, and a message is the least controlled place data goes.
 */
export const MERGE_FIELDS: FieldSpec[] = [
  { name: 'first_name', label: 'Client first name', example: 'Sarah' },
  { name: 'last_name', label: 'Client last name', example: 'Johnson' },
  { name: 'user_name', label: 'Your name', example: 'Michael Chen' },
  { name: 'user_first_name', label: 'Your first name', example: 'Michael' },
  { name: 'user_cell', label: 'Your mobile', example: '(416) 555-0142' },
  { name: 'signature', label: 'Your email signature', example: 'Michael Chen\nMortgage Agent\n(416) 555-0142' },
  { name: 'schedule_link', label: 'Your booking link', format: 'url',
    example: 'https://calendar.app.google/…' },
  { name: 'amount_requested', label: 'Mortgage requested', format: 'money', example: '$785,000' },
  { name: 'transaction_type_key', label: 'Transaction type', example: 'refinance' },
  { name: 'purpose', label: 'Purpose', example: 'Refinance' },
  { name: 'property_city', label: 'Property city', example: 'Toronto' },
  { name: 'property_province', label: 'Property province', example: 'ON' },
  { name: 'closing_date', label: 'Closing date', format: 'date', example: '15 Oct 2026' },
  { name: 'days_to_close', label: 'Days to close', format: 'days', example: '34' },
  { name: 'maturity_date', label: 'Maturity date', format: 'date', example: '30 Jun 2027' },
  { name: 'days_to_maturity', label: 'Days to maturity', format: 'days', example: '180' },
  { name: 'documents_outstanding', label: 'Documents outstanding', example: '2' },
  { name: 'percent_complete', label: 'Application completeness', format: 'percent', example: '78%' },
  { name: 'stage_label', label: 'Pipeline stage', example: 'Application' },
  { name: 'portal_reference', label: 'Application reference', example: 'LMX-A-202609-4471' },
  { name: 'application_link', label: 'Link to finish the application', format: 'url',
    example: 'https://apply.lendmax.ca/…' },
  { name: 'document_upload_link', label: 'Document upload link', format: 'url',
    example: 'https://lendmax.ca/crm/upload/…' },
  { name: 'calculator_link', label: 'Relevant calculator', format: 'url',
    example: 'https://rateshop.ca/…' },
  { name: 'calculator_name', label: 'Name of that calculator',
    example: 'Refinance vs Renew Calculator' },
  { name: 'organization_name', label: 'Brokerage name', example: 'Lendmax' },
  // Appointment emails only; anywhere else these have no value and their line is dropped.
  { name: 'appointment_date', label: 'Appointment date', example: 'Thursday, September 18, 2026' },
  { name: 'appointment_time', label: 'Appointment time', example: '2:30 p.m. EDT' },
  { name: 'appointment_type', label: 'Appointment type', example: 'Discovery call' },
  { name: 'appointment_duration', label: 'Appointment length', example: '30 minutes' },
  { name: 'appointment_where', label: 'Where / how to join',
    example: 'Join the video call: https://meet.google.com/abc-defg-hij' },
  { name: 'appointment_link', label: 'Video call link', format: 'url', example: 'https://meet.google.com/abc-defg-hij' },
  { name: 'appointment_host', label: 'Who the meeting is with', example: 'Priya Sandhu' },
];

export const MERGE_FIELD_NAMES = new Set(MERGE_FIELDS.map((f) => f.name));

const TOKEN = /\{([a-z0-9_]+)\}/gi;

export type RenderResult = {
  text: string;
  /** Fields the template asked for that had no value. */
  missing: string[];
  /** Sentences or lines dropped because a value was missing. */
  dropped: string[];
  /** True when nothing usable is left — the caller must not send. */
  empty: boolean;
};

const CAD = new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
});

function formatValue(value: unknown, format: FieldSpec['format']): string | null {
  if (value === null || value === undefined || value === '') return null;
  switch (format) {
    case 'money': {
      const n = Number(value);
      return Number.isFinite(n) ? CAD.format(n) : null;
    }
    case 'date': {
      const iso = String(value).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-CA', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      });
    }
    case 'days': {
      const n = Number(value);
      return Number.isFinite(n) ? String(Math.round(n)) : null;
    }
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? `${Math.round(n)}%` : null;
    }
    default:
      return String(value);
  }
}

/**
 * Render a template.
 *
 * Lines containing an unresolved field are dropped whole. A line is the unit
 * rather than a sentence because these messages are short and line-broken,
 * and dropping half a sentence reads worse than dropping the line.
 */
export function renderTemplate(template: string, context: MergeContext): RenderResult {
  const missing = new Set<string>();
  const dropped: string[] = [];
  const specByName = new Map(MERGE_FIELDS.map((f) => [f.name, f]));

  const lines = template.split('\n');
  const rendered: string[] = [];

  for (const line of lines) {
    let lineMissing = false;
    const out = line.replace(TOKEN, (match, name: string) => {
      const spec = specByName.get(name);
      if (!spec) {
        // An unknown field is left as written rather than silently deleted:
        // a broker seeing "{clietn_name}" in a preview fixes the typo, and a
        // blank teaches them nothing.
        missing.add(name);
        lineMissing = true;
        return match;
      }
      const formatted = formatValue(context.values[name], spec.format);
      if (formatted === null) {
        missing.add(name);
        lineMissing = true;
        return match;
      }
      return formatted;
    });

    if (lineMissing) {
      if (line.trim()) dropped.push(line.trim());
      continue;
    }
    rendered.push(out);
  }

  // Collapse the gaps left behind, so a dropped line does not leave three
  // blank ones where a paragraph was.
  const text = rendered.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    text,
    missing: [...missing],
    dropped,
    empty: text.length === 0,
  };
}

/** Which fields a template uses. Extracted at save time and validated. */
export function fieldsUsedBy(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(TOKEN)) found.add(match[1]!);
  return [...found];
}

export type TemplateIssue = { field: string; message: string };

/**
 * Checked when a template is saved, not when it is sent.
 *
 * A template referring to a field that does not exist would otherwise reach a
 * client with `{clietn_name}` in it, or — worse, before the drop rule — with a
 * gap where their name should be.
 */
export function validateTemplate(template: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  for (const field of fieldsUsedBy(template)) {
    if (!MERGE_FIELD_NAMES.has(field)) {
      const suggestion = closest(field);
      issues.push({
        field,
        message: `There is no merge field called {${field}}.` +
          (suggestion ? ` Did you mean {${suggestion}}?` : ''),
      });
    }
  }
  return issues;
}

/** A one-edit-away suggestion. Cheap, and it catches the typo that matters. */
function closest(name: string): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of MERGE_FIELD_NAMES) {
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = temp;
    }
  }
  return previous[b.length]!;
}

/** A preview with the example values, for the template editor. */
export function previewTemplate(template: string): RenderResult {
  const values: Record<string, unknown> = {};
  for (const field of MERGE_FIELDS) {
    // Reverse the formatting for the example so the preview goes through the
    // same code path a real send does.
    values[field.name] = field.format === 'money' ? 785000
      : field.format === 'date' ? '2026-10-15'
      : field.format === 'days' ? 34
      : field.format === 'percent' ? 78
      : field.example;
  }
  return renderTemplate(template, { values });
}
