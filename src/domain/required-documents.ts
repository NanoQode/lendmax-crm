/**
 * The vocabulary of the required-documents module: the four purposes an
 * application can have, and the file formats a document can be asked for in.
 *
 * Purposes are the application portal's own four, because that is the answer
 * the client gives. Several CRM transaction types share one purpose (a
 * first-time buyer and a plain purchase are both "Purchase"), so the checklist
 * follows the purpose rather than the type.
 *
 * Formats are only ones the upload checker in domain/uploads.ts accepts —
 * `test/required-documents.test.ts` fails otherwise. Asking a client for a
 * format the uploader then refuses is a support call.
 */

export const PURPOSES = [
  { key: 'purchase', label: 'Purchase', portal: 'Purchase' },
  { key: 'renew', label: 'Renew', portal: 'Renew' },
  { key: 'refinance', label: 'Refinance', portal: 'Refinance' },
  { key: 'home_equity_line', label: 'Home Equity Line', portal: 'Home Equity Line' },
] as const;

export type PurposeKey = (typeof PURPOSES)[number]['key'];
export const PURPOSE_KEYS = PURPOSES.map((p) => p.key) as [PurposeKey, ...PurposeKey[]];

/**
 * An application's purpose, as the portal sends it ("Home Equity Line") or as
 * a key ("home_equity_line"), to a key. Unknown purposes are null, not guessed.
 */
export function purposeKey(value: string | null | undefined): PurposeKey | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const found = PURPOSES.find((p) => p.key === v || p.portal.toLowerCase() === v || p.label.toLowerCase() === v);
  return found?.key ?? null;
}

export const DOCUMENT_FORMATS = [
  { key: 'pdf', label: 'PDF', extensions: ['.pdf'], mime: 'application/pdf' },
  { key: 'jpg', label: 'JPG', extensions: ['.jpg'], mime: 'image/jpeg' },
  { key: 'jpeg', label: 'JPEG', extensions: ['.jpeg'], mime: 'image/jpeg' },
  { key: 'png', label: 'PNG', extensions: ['.png'], mime: 'image/png' },
  { key: 'heic', label: 'HEIC', extensions: ['.heic'], mime: 'image/heic' },
  { key: 'webp', label: 'WEBP', extensions: ['.webp'], mime: 'image/webp' },
  { key: 'tiff', label: 'TIFF', extensions: ['.tif', '.tiff'], mime: 'image/tiff' },
  { key: 'doc', label: 'DOC', extensions: ['.doc'], mime: 'application/msword' },
  { key: 'docx', label: 'DOCX', extensions: ['.docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { key: 'xls', label: 'XLS', extensions: ['.xls'], mime: 'application/vnd.ms-excel' },
  { key: 'xlsx', label: 'XLSX', extensions: ['.xlsx'],
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { key: 'csv', label: 'CSV', extensions: ['.csv'], mime: 'text/csv' },
] as const;

export type FormatKey = (typeof DOCUMENT_FORMATS)[number]['key'];
export const FORMAT_KEYS = DOCUMENT_FORMATS.map((f) => f.key) as [FormatKey, ...FormatKey[]];

/** What a new entry offers ticked: what most documents arrive as. */
export const DEFAULT_FORMATS: FormatKey[] = ['pdf', 'jpg', 'jpeg', 'png'];

/**
 * Does this file satisfy a document that accepts these formats? For the
 * upload step of the application, when it is built: a client asked for a PDF
 * who sends a Word file is told so before it is stored.
 */
export function fileMatchesFormats(filename: string, formats: readonly string[]): boolean {
  const lower = filename.toLowerCase();
  return DOCUMENT_FORMATS
    .filter((f) => formats.includes(f.key))
    .some((f) => f.extensions.some((ext) => lower.endsWith(ext)));
}

/** "PDF, JPG or PNG" — for the client-facing instruction. */
export function describeFormats(formats: readonly string[]): string {
  const labels = [...new Set(DOCUMENT_FORMATS.filter((f) => formats.includes(f.key)).map((f) => f.label))];
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

type Suggestion = {
  name: string; description: string; formats: FormatKey[]; required: boolean;
  per_applicant: boolean; category_key?: string;
};

const ID: Suggestion = { name: 'Government-issued photo ID', description: 'A driver’s licence or passport, both sides, clearly readable.', formats: ['pdf', 'jpg', 'jpeg', 'png', 'heic'], required: true, per_applicant: true, category_key: 'identification' };
const PAY: Suggestion = { name: 'Two most recent pay stubs', description: 'Showing your name, your employer and year-to-date earnings.', formats: ['pdf', 'jpg', 'jpeg', 'png'], required: true, per_applicant: true, category_key: 'pay_stubs' };
const LOE: Suggestion = { name: 'Letter of employment', description: 'On company letterhead, dated within the last 30 days: position, start date, salary or hourly rate, and whether you are permanent.', formats: ['pdf'], required: true, per_applicant: true, category_key: 'employment_letter' };
const NOA: Suggestion = { name: 'Notices of Assessment — last two years', description: 'From the CRA. Download them from CRA My Account.', formats: ['pdf'], required: true, per_applicant: true, category_key: 'notice_of_assessment' };
const TAX: Suggestion = { name: 'Most recent property tax bill', description: 'Or proof the taxes are paid through your mortgage.', formats: ['pdf', 'jpg', 'jpeg', 'png'], required: true, per_applicant: false, category_key: 'property_tax' };
const STATEMENT: Suggestion = { name: 'Current mortgage statement', description: 'From your current lender, dated within the last 60 days.', formats: ['pdf'], required: true, per_applicant: false, category_key: 'mortgage_statement' };

/**
 * A starting list per purpose, offered on an empty purpose and never added
 * without somebody pressing the button. It is a suggestion drawn from what a
 * Canadian lender typically asks for, not a compliance requirement; every
 * entry can be edited or removed.
 */
export const SUGGESTED: Record<PurposeKey, Suggestion[]> = {
  purchase: [
    ID, PAY, LOE, NOA,
    { name: 'Down payment — 90 days of bank statements', description: 'For every account the down payment comes from, showing your name and account number.', formats: ['pdf'], required: true, per_applicant: false, category_key: 'down_payment' },
    { name: 'Signed Agreement of Purchase and Sale', description: 'With all schedules, amendments and waivers.', formats: ['pdf'], required: true, per_applicant: false, category_key: 'purchase_agreement' },
    { name: 'MLS listing', description: 'The listing for the property you are buying.', formats: ['pdf', 'jpg', 'jpeg', 'png'], required: false, per_applicant: false, category_key: 'mls' },
    { name: 'Gift letter', description: 'Only if part of the down payment is a gift: signed by the person giving it, stating it does not have to be repaid.', formats: ['pdf'], required: false, per_applicant: false, category_key: 'gift_letter' },
  ],
  renew: [
    ID,
    { ...STATEMENT, name: 'Mortgage renewal statement', description: 'The renewal letter or latest statement from your current lender, showing the balance and maturity date.' },
    TAX,
    { ...PAY, required: false },
  ],
  refinance: [
    ID, STATEMENT, TAX, PAY, LOE, NOA,
    { name: 'Home insurance', description: 'The current policy declaration page.', formats: ['pdf'], required: false, per_applicant: false },
  ],
  home_equity_line: [ID, STATEMENT, TAX, PAY, NOA],
};
