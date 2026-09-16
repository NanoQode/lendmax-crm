/**
 * Everything collected from the client so far, in one place, for the
 * Compliance tab.
 *
 * A reviewer's first question is "what do we actually have from this person",
 * and the answer is spread over the application form, the documents, the
 * consent record and the identity checks. This gathers it, section by
 * section, with what state each is in — nothing here is new data, and nothing
 * here writes.
 *
 * The form's sections are read through `getApplicationForm`, so the same
 * rules apply as on the Application tab: a file the reader is not on and
 * cannot see is not readable here either, and income, assets and liabilities
 * stay hidden without the financials permission.
 */
import { query, queryOne } from '../db/pool.ts';
import { flatRoot, SECTIONS, sectionPath, validateSection } from '../domain/application-form.ts';
import { getApplicationForm, type Scope } from './applications.ts';

export type SectionState = 'complete' | 'declared' | 'started' | 'not_started' | 'hidden';

export type Collected = {
  contact: {
    name: string | null; email: string | null; phone: string | null; date_of_birth: string | null;
    address: string | null; lead_source: string | null;
  };
  application: {
    reference: string | null; percent_complete: number | null; started_at: string;
    submitted_at: string | null;
  };
  /** `missing`: required answers still to come, for a section that is partly filled. */
  sections: Array<{ id: string; title: string; state: SectionState; entries: number | null; missing: number | null }>;
  hidden_reason: string | null;
  documents: Array<{
    id: string; label: string; category_key: string | null; source: string;
    review_status: string; uploaded_at: string;
  }>;
  consents: Array<{
    channel: string; purpose: string; basis: string; granted: boolean;
    source: string | null; collected_at: string; consent_version: string | null;
  }>;
  identities: number;
  totals: { collected: number; outstanding: number };
};

/** The upload section is the documents list below; it is not counted twice. */
const NOT_A_FORM_SECTION = new Set(['documents']);

export async function collectedFromClient(scope: Scope, applicationId: string): Promise<Collected> {
  const form = await getApplicationForm(scope, applicationId);

  const app = (await queryOne<{
    customer_id: string; created_at: string; submitted_at: string | null;
    first_name: string | null; last_name: string | null; email: string | null; phone_e164: string | null;
    date_of_birth: string | null; address: string | null; lead_source: string | null;
  }>(
    `SELECT app.customer_id, app.created_at, app.submitted_at,
            c.first_name, c.last_name, c.email, c.phone_e164,
            to_char(c.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
            NULLIF(concat_ws(', ', NULLIF(concat_ws(' ', c.address_line1, c.address_line2), ''),
                             c.city, c.province, c.postal_code), '') AS address,
            c.lead_source
       FROM applications app JOIN customers c ON c.id = app.customer_id
      WHERE app.id = $1`, [applicationId]))!;

  const root = flatRoot(form.answers);
  const meta = (form.answers.meta ?? {}) as Record<string, Record<string, unknown>>;
  const hidden = new Set(form.hidden_sections);

  const sections: Collected['sections'] = [];
  // Hidden sections are named, not dropped: "we have it, you cannot read it"
  // is different from "we do not have it".
  for (const section of SECTIONS) {
    if (NOT_A_FORM_SECTION.has(section.id)) continue;
    if (hidden.has(section.id)) {
      sections.push({ id: section.id, title: section.title, state: 'hidden', entries: null, missing: null });
      continue;
    }
    if (section.id === 'review') {
      sections.push({ id: section.id, title: section.title,
                      state: app.submitted_at ? 'complete' : 'not_started', entries: null, missing: null });
      continue;
    }
    const value = form.answers[sectionPath(section.id)];
    const entries = Array.isArray(value) ? value.length : null;
    const hasAnything = Array.isArray(value)
      ? value.length > 0
      : !!value && typeof value === 'object'
        && Object.values(value as Record<string, unknown>).some((v) => v !== '' && v !== null && v !== undefined);
    const sectionMeta = meta[section.id] ?? {};
    // "No, this is my only property" answers the section. The portal has
    // stored that answer both as 'no' and as false.
    const gatedOut = !!section.gate && [false, 'no'].includes(sectionMeta[section.gate.n] as never);
    const result = validateSection(section.id, value, root, sectionMeta);
    const state: SectionState = result.declared || gatedOut ? 'declared'
      : result.complete && hasAnything ? 'complete'
      : hasAnything ? 'started' : 'not_started';
    sections.push({ id: section.id, title: section.title, state, entries,
                    missing: state === 'started' ? Object.keys(result.errors).length : null });
  }

  const [documents, consents, identities] = await Promise.all([
    query<Collected['documents'][number]>(
      `SELECT id, COALESCE(display_label, filename) AS label, category_key, source, review_status, uploaded_at
         FROM documents
        WHERE application_id = $1 AND archived_at IS NULL AND review_status <> 'superseded'
        ORDER BY uploaded_at DESC`, [applicationId]),
    // The consent in force for each channel and purpose — the latest record
    // wins, a withdrawal included.
    query<Collected['consents'][number]>(
      `SELECT DISTINCT ON (channel, purpose) channel, purpose, basis, granted, source,
              collected_at, consent_version
         FROM consents WHERE customer_id = $1
        ORDER BY channel, purpose, collected_at DESC`, [app.customer_id]),
    queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_verifications WHERE application_id = $1`, [applicationId]),
  ]);

  const readable = sections.filter((s) => s.state !== 'hidden');
  const collected = readable.filter((s) => s.state === 'complete' || s.state === 'declared').length;

  return {
    contact: {
      name: [app.first_name, app.last_name].filter(Boolean).join(' ') || null,
      email: app.email, phone: app.phone_e164, date_of_birth: app.date_of_birth,
      address: app.address, lead_source: app.lead_source,
    },
    application: {
      reference: form.application.reference, percent_complete: form.application.percent_complete,
      started_at: app.created_at, submitted_at: app.submitted_at,
    },
    sections,
    hidden_reason: form.hidden_reason,
    documents: documents.rows,
    consents: consents.rows,
    identities: identities?.n ?? 0,
    totals: { collected, outstanding: readable.length - collected },
  };
}
