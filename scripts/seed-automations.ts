/**
 * The default follow-up sequences.
 *
 * Seeded as DRAFTS, never active. An automation that starts texting clients
 * because somebody ran the seed is not a default, it is an accident — the
 * brokerage reads each one, edits the wording to sound like them, and
 * publishes it deliberately.
 *
 * Every one carries stop conditions. That is the point of shipping them: they
 * are worked examples of the thing that is easy to leave out and expensive to
 * leave out.
 */
import { pool } from '../src/db/pool.ts';
import { DefinitionSchema, validateDefinition } from '../src/domain/automation.ts';

type Seed = {
  key: string;
  name: string;
  description: string;
  purpose: 'transactional' | 'marketing' | 'service';
  allow_reenrollment?: boolean;
  cooldown_days?: number;
  definition: unknown;
};

const SEEDS: Seed[] = [
  {
    key: 'incomplete_application',
    name: 'Incomplete application follow-up',
    description:
      'Six touches over two weeks for an application that stalled. Stops the moment it is ' +
      'completed, the file is resolved, or the client asks us to.',
    purpose: 'transactional',
    definition: {
      trigger: { type: 'application.created', filters: [] },
      entry_conditions: [{ field: 'percent_complete', op: 'lt', value: 100 }],
      // The reason this sequence is safe to run unattended.
      stop_conditions: [
        { field: 'percent_complete', op: 'gte', value: 100,
          reason: 'The client finished the application' },
        { field: 'stage_category', op: 'in', value: ['won', 'lost'],
          reason: 'The file was resolved' },
        { field: 'future_appointments', op: 'gte', value: 1,
          reason: 'An appointment was booked, so a person has it' },
      ],
      start_node: 'wait_30m',
      nodes: [
        { key: 'wait_30m', type: 'wait', minutes: 30, next: 'nudge' },
        { key: 'nudge', type: 'send_email', purpose: 'transactional',
          subject: 'You were partway through your application',
          body:
            'Hi {first_name},\n\n' +
            'You got as far as {percent_complete} on your application and it is still open — ' +
            'nothing has been lost.\n\n' +
            'You can pick it up where you left off here:\n{application_link}\n\n' +
            'If something in it was unclear, reply and tell me which part.\n\n' +
            '{user_first_name}',
          next: 'wait_24h' },
        { key: 'wait_24h', type: 'wait', hours: 24, business_hours_only: true, next: 'day1' },
        { key: 'day1', type: 'send_email', purpose: 'transactional',
          subject: 'What is left on your application',
          body:
            'Hi {first_name},\n\n' +
            'Your application is {percent_complete} complete. The rest usually takes about ten ' +
            'minutes.\n\n' +
            '{application_link}\n\n' +
            'Or call me at {user_cell} and we can do it together.\n\n' +
            '{user_first_name}',
          next: 'wait_day2' },
        { key: 'wait_day2', type: 'wait', days: 1, business_hours_only: true, next: 'day2' },
        { key: 'day2', type: 'create_task',
          title: 'Call {first_name} — application stalled at {percent_complete}%',
          category: 'follow_up', priority: 'high', due_in_days: 0, assign_to: 'broker',
          next: 'wait_day4' },
        { key: 'wait_day4', type: 'wait', days: 2, business_hours_only: true, next: 'day4' },
        { key: 'day4', type: 'send_email', purpose: 'transactional',
          subject: 'A thought on your {purpose}',
          body:
            'Hi {first_name},\n\n' +
            'Our underwriting team had another look at what you sent for your {purpose} in ' +
            '{property_city}.\n\n' +
            'The part that usually decides the rate is the piece still missing, so it is worth ' +
            'ten minutes to finish:\n{application_link}\n\n' +
            '{user_first_name}',
          next: 'wait_day7' },
        { key: 'wait_day7', type: 'wait', days: 3, business_hours_only: true, next: 'day7' },
        { key: 'day7', type: 'send_email', purpose: 'transactional',
          subject: 'Still worth a look?',
          body:
            'Hi {first_name},\n\n' +
            'I will stop chasing after this one. If the timing has changed, that is completely ' +
            'fine — tell me when to come back and I will.\n\n' +
            'If it has not, the application is still here:\n{application_link}\n\n' +
            '{user_first_name}\n{user_cell}',
          next: 'wait_day14' },
        { key: 'wait_day14', type: 'wait', days: 7, business_hours_only: true, next: 'park' },
        { key: 'park', type: 'add_tag', tag: 'nurture', next: 'end' },
        { key: 'end', type: 'stop', reason: 'Active follow-up finished' },
      ],
    },
  },

  {
    key: 'application_submitted',
    name: 'Application submitted — confirm and hand over',
    description:
      'Confirms receipt, introduces the assigned broker and opens the underwriting review task.',
    purpose: 'transactional',
    definition: {
      trigger: { type: 'application.submitted', filters: [] },
      entry_conditions: [],
      stop_conditions: [
        { field: 'stage_category', op: 'eq', value: 'lost', reason: 'The file was lost' },
      ],
      start_node: 'confirm',
      nodes: [
        { key: 'confirm', type: 'send_email', purpose: 'transactional',
          subject: 'We have your application',
          body:
            'Hi {first_name},\n\n' +
            'Your application is in — reference {portal_reference}.\n\n' +
            'I am looking after it from here. The next thing is a quick review, and then I will ' +
            'come back to you with anything still needed.\n\n' +
            'If anything changes in the meantime, call me at {user_cell}.\n\n' +
            '{user_first_name}',
          next: 'task' },
        { key: 'task', type: 'create_task',
          title: 'Review {first_name}’s submitted application',
          category: 'application_review', priority: 'high', due_in_days: 1,
          assign_to: 'underwriter', next: 'notify' },
        { key: 'notify', type: 'notify_user', role: 'broker',
          title: '{first_name} submitted their application',
          body: 'Reference {portal_reference}.', next: 'end' },
        { key: 'end', type: 'stop' },
      ],
    },
  },

  {
    key: 'documents_outstanding',
    name: 'Outstanding document reminder',
    description:
      'Two reminders, then a task. Stops the moment nothing is outstanding, so a client who has ' +
      'already sent everything is never asked again.',
    purpose: 'transactional',
    allow_reenrollment: true,
    cooldown_days: 7,
    definition: {
      trigger: { type: 'document.requested', filters: [] },
      entry_conditions: [{ field: 'documents_outstanding', op: 'gt', value: 0 }],
      stop_conditions: [
        // The condition that stops the CRM asking for documents it already has.
        { field: 'documents_outstanding', op: 'lte', value: 0,
          reason: 'Everything requested has arrived' },
        { field: 'stage_category', op: 'in', value: ['won', 'lost'],
          reason: 'The file was resolved' },
      ],
      start_node: 'wait_24h',
      nodes: [
        { key: 'wait_24h', type: 'wait', hours: 24, business_hours_only: true, next: 'first' },
        { key: 'first', type: 'send_email', purpose: 'transactional',
          subject: 'A reminder about your documents',
          body:
            'Hi {first_name},\n\n' +
            'There {documents_outstanding} still to send for your application.\n\n' +
            'You can upload them here, and a photo from your phone is fine:\n' +
            '{document_upload_link}\n\n' +
            '{user_first_name}',
          next: 'wait_48h' },
        { key: 'wait_48h', type: 'wait', days: 2, business_hours_only: true, next: 'second' },
        { key: 'second', type: 'send_sms', purpose: 'transactional',
          body:
            'Hi {first_name}, still waiting on a couple of documents for your mortgage — ' +
            '{document_upload_link} — {user_first_name}, Lendmax',
          next: 'wait_task' },
        { key: 'wait_task', type: 'wait', days: 2, next: 'task' },
        { key: 'task', type: 'create_task',
          title: 'Chase {first_name} for documents',
          category: 'document_request', priority: 'high', due_in_days: 0,
          assign_to: 'broker', next: 'end' },
        { key: 'end', type: 'stop' },
      ],
    },
  },

  {
    key: 'no_show_rebooking',
    name: 'No-show rebooking',
    description:
      'Three attempts over three days. Stops the instant anything is booked — a client who ' +
      'rebooked must never be told they missed a meeting.',
    purpose: 'transactional',
    allow_reenrollment: true,
    cooldown_days: 14,
    definition: {
      trigger: { type: 'appointment.no_show', filters: [] },
      entry_conditions: [],
      stop_conditions: [
        { field: 'future_appointments', op: 'gte', value: 1,
          reason: 'They rebooked' },
        { field: 'stage_category', op: 'in', value: ['won', 'lost'],
          reason: 'The file was resolved' },
      ],
      start_node: 'wait_20m',
      nodes: [
        { key: 'wait_20m', type: 'wait', minutes: 20, next: 'sms' },
        { key: 'sms', type: 'send_sms', purpose: 'transactional',
          body:
            'Hi {first_name}, sorry we missed each other. Grab another time that suits you ' +
            'here: {schedule_link} — {user_first_name}, Lendmax',
          next: 'wait_next_day' },
        { key: 'wait_next_day', type: 'wait', days: 1, business_hours_only: true, next: 'email' },
        { key: 'email', type: 'send_email', purpose: 'transactional',
          subject: 'Another time?',
          body:
            'Hi {first_name},\n\n' +
            'We did not manage to connect yesterday. No problem at all — pick any slot that ' +
            'works:\n{schedule_link}\n\n' +
            'Or just call me at {user_cell}.\n\n' +
            '{user_first_name}',
          next: 'wait_day3' },
        { key: 'wait_day3', type: 'wait', days: 2, business_hours_only: true, next: 'final' },
        { key: 'final', type: 'create_task',
          title: 'Last rebooking attempt — {first_name}',
          category: 'appointment', priority: 'normal', due_in_days: 0,
          assign_to: 'broker', next: 'end' },
        { key: 'end', type: 'stop', reason: 'Rebooking attempts exhausted' },
      ],
    },
  },

  {
    key: 'renewal_lifecycle',
    name: 'Renewal — T-6 months, T-3 months, T-45 days',
    description:
      'The renewal conversation, started early. Stops when the renewal resolves or the client ' +
      'opts out.',
    purpose: 'service',
    allow_reenrollment: true,
    cooldown_days: 300,
    definition: {
      trigger: { type: 'maturity.approaching', offset_days: 180, filters: [] },
      entry_conditions: [{ field: 'maturity_date', op: 'is_set' }],
      stop_conditions: [
        { field: 'days_to_maturity', op: 'lt', value: 0, reason: 'The mortgage has matured' },
      ],
      start_node: 't6',
      nodes: [
        { key: 't6', type: 'send_email', purpose: 'service',
          subject: 'Your mortgage matures on {maturity_date}',
          body:
            'Hi {first_name},\n\n' +
            'Your mortgage matures on {maturity_date} — about six months away. It is early, and ' +
            'that is the point: the best options tend to be available to people who start now ' +
            'rather than in the last fortnight.\n\n' +
            'Worth a fifteen-minute review?\n{schedule_link}\n\n' +
            '{user_first_name}\n{user_cell}',
          next: 'wait_t3' },
        { key: 'wait_t3', type: 'wait', days: 90, business_hours_only: true, next: 't3' },
        { key: 't3', type: 'send_email', purpose: 'service',
          subject: 'Three months to your renewal',
          body:
            'Hi {first_name},\n\n' +
            'Three months until {maturity_date}.\n\n' +
            'This is the point where it is worth comparing what your current lender will offer ' +
            'against what is available elsewhere — they are often not the same number.\n\n' +
            '{schedule_link}\n\n' +
            '{user_first_name}',
          next: 'wait_t45' },
        { key: 'wait_t45', type: 'wait', days: 45, business_hours_only: true, next: 'task' },
        { key: 'task', type: 'create_task',
          title: 'Renewal at T-45: {first_name}, matures {maturity_date}',
          category: 'renewal', priority: 'high', due_in_days: 0, assign_to: 'broker',
          next: 't45' },
        { key: 't45', type: 'send_email', purpose: 'service',
          subject: 'Six weeks to your renewal',
          body:
            'Hi {first_name},\n\n' +
            'Your renewal is about six weeks out. Most lenders want a couple of weeks to get a ' +
            'switch done, so this is the last comfortable moment to look at it.\n\n' +
            '{schedule_link}\n\n' +
            'Or just call me at {user_cell}.\n\n' +
            '{user_first_name}',
          next: 'end' },
        { key: 'end', type: 'stop' },
      ],
    },
  },
];

async function main(): Promise<void> {
  const org = await pool.query<{ id: string }>(
    'SELECT id FROM organizations ORDER BY created_at LIMIT 1',
  );
  const orgId = org.rows[0]?.id;
  if (!orgId) {
    console.error('No organization. Run: npm run seed');
    process.exit(1);
  }

  let seeded = 0;
  for (const seed of SEEDS) {
    const parsed = DefinitionSchema.safeParse(seed.definition);
    if (!parsed.success) {
      console.error(`${seed.key}: the definition is not valid`);
      console.error(parsed.error.issues.slice(0, 3));
      process.exitCode = 1;
      continue;
    }
    const issues = validateDefinition(parsed.data);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      console.error(`${seed.key}: ${errors.map((e) => e.message).join('; ')}`);
      process.exitCode = 1;
      continue;
    }
    for (const warning of issues.filter((i) => i.level === 'warning')) {
      console.warn(`  ${seed.key}: ${warning.message}`);
    }

    // Drafts, never active. An automation that starts texting because somebody
    // ran the seed is not a default, it is an accident.
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM automations WHERE organization_id = $1 AND key = $2',
      [orgId, seed.key],
    );
    if (existing.rows[0]) continue;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO automations (organization_id, key, name, description, status, purpose,
                                allow_reenrollment, reenrollment_cooldown_days)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7) RETURNING id`,
      [orgId, seed.key, seed.name, seed.description, seed.purpose,
       seed.allow_reenrollment ?? false, seed.cooldown_days ?? null],
    );
    await pool.query(
      `INSERT INTO automation_versions (automation_id, version, definition, validation)
       VALUES ($1,1,$2::jsonb,$3::jsonb)`,
      [rows[0]!.id, JSON.stringify(parsed.data), JSON.stringify({ issues })],
    );
    seeded++;
  }

  console.log(`${seeded} automation(s) seeded as drafts. Review and publish each one.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exit(1);
});
