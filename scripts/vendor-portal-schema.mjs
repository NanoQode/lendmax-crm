/**
 * Turn the portal's own form definition into a data module this CRM can import.
 *
 * `apply.lendmax.ca` keeps the application form in one file — `lib/schema.js`,
 * which its browser renders from, its server validates against and its Scarlett
 * client maps out of. The CRM's detail page has to ask the same questions, in
 * the same order, under the same conditions, or a broker correcting a client's
 * answer is filling in a different form from the one the client filled in.
 *
 * So the schema is not re-typed here. A copy of the portal's file lives in
 * `vendor/portal-schema.js`, byte-identical to the deployed one, and this
 * script calls its `publicSchema()` and writes the result out as TypeScript
 * data. Byte-identical matters: refreshing it is a copy and a re-run, and a
 * diff against the server says whether it has drifted.
 *
 *   1. copy /srv/lendmax-portal/lib/schema.js over vendor/portal-schema.js
 *   2. node scripts/vendor-portal-schema.mjs
 *   3. npm test — the schema tests say what changed
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'vendor', 'portal-schema.js');
const target = path.join(here, '..', 'src', 'integrations', 'portal-schema.ts');

const raw = readFileSync(source, 'utf8');
const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);

// Imported as a module rather than parsed: the file is the authority on its own
// shape, and a parser here would be a second, worse copy of its semantics.
const schema = await import(`file://${source}`);
const published = schema.publicSchema();

const header = `/**
 * The application form, as apply.lendmax.ca defines it.
 *
 * GENERATED — do not edit. Run \`node scripts/vendor-portal-schema.mjs\` after
 * copying a newer \`lib/schema.js\` into \`vendor/portal-schema.js\`.
 *
 * Source: /srv/lendmax-portal/lib/schema.js
 * sha256: ${hash} (first 16)
 * Sections: ${published.sections.length}
 *
 * Why it is vendored rather than re-typed: the portal's copy is the single
 * source of truth for what the form asks, when each question appears and what
 * it accepts. A second hand-written copy here would drift, and the day it did,
 * a broker would be correcting a client's answer on a form that no longer
 * matched the one the client filled in.
 */
`;

const body = `export const PORTAL_SCHEMA = ${JSON.stringify(published, null, 2)} as const;

export type PortalSchema = typeof PORTAL_SCHEMA;
`;

writeFileSync(target, `${header}\n${body}`);
console.log(`wrote ${path.relative(path.join(here, '..'), target)} — ` +
  `${published.sections.length} sections, sha256 ${hash}`);
