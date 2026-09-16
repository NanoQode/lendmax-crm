/**
 * The follow-up sequences the brokerage starts with.
 *
 * Every timing here is from docs/research/follow-up-and-content.md and is
 * defensible: the MIT / InsideSales lead-response study puts qualifying odds
 * ~21x higher at five minutes than at thirty, and finds ~93% of leads that
 * ever convert are reached within six attempts. So step one is immediate
 * rather than the half-hour in the original brief, and no sequence runs past
 * six touches.
 *
 * The voice rotates on Ali's instruction (brief §46): steps 1, 2, 4 and 5 are
 * the assigned broker writing as themselves; steps 3 and 6 come from the
 * Underwriting Team, which is what underwriting@lendmax.ca genuinely is
 * (answer 26) — no message claims a named person reviewed something unless
 * one did.
 *
 * Content follows the rules in the research note: one reason for the message,
 * a true fact about their file, contrast without disparagement, something of
 * value even if nothing closes, one call to action. Every line is
 * self-contained because the renderer drops a whole line whose merge field
 * cannot be resolved — a sentence split across two lines would otherwise lose
 * half of itself and still send.
 *
 * All of it is editable by Admin. None of it is load-bearing on a regulation;
 * the parts that are — consent, identification, unsubscribe — are enforced by
 * evaluateSend and the footer, not by the wording of a template.
 */
import type { AutomationDefinitionInput } from './automation.ts';

export type DefaultAutomation = {
  key: string;
  name: string;
  description: string;
  definition: AutomationDefinitionInput;
};

/** Stops that belong on every client-facing sequence. */
const UNIVERSAL_STOPS = [
  { field: 'stage_category', op: 'eq' as const, value: 'lost', reason: 'The file was marked Lost.' },
  { field: 'stage_category', op: 'eq' as const, value: 'won', reason: 'The file funded.' },
];

export const DEFAULT_AUTOMATIONS: DefaultAutomation[] = [
  // ── 1. The application was started and never finished ────────────────
  {
    key: 'incomplete_application',
    name: 'Incomplete application — 6 touches over 14 days',
    description:
      'Runs when an application is left unfinished. Stops the moment it completes. ' +
      'Timings follow the lead-response research: immediate, then 24h, 48h, day 4, day 7, day 14.',
    definition: {
      trigger: { type: 'application.abandoned', after_hours: 1, filters: [] },
      entry_conditions: [{ field: 'percent_complete', op: 'lt', value: 100 }],
      stop_conditions: [
        { field: 'percent_complete', op: 'gte', value: 100, reason: 'The application was completed.' },
        ...UNIVERSAL_STOPS,
      ],
      start_node: 'e1',
      nodes: [
        {
          key: 'e1', type: 'send_email', label: 'Immediate — you are most of the way there',
          purpose: 'transactional',
          subject: 'Your {purpose} application, {first_name}',
          body: [
            'Hi {first_name},',
            '',
            'You got {percent_complete} of the way through your application and it saved where you stopped, so nothing is lost.',
            'The rest takes about five minutes, and nothing is submitted anywhere until you say so.',
            '',
            'Pick up where you left off: {application_link}',
            '',
            'If something in it was unclear, reply and tell me which part — that is usually faster than guessing.',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'w1',
        },
        { key: 'w1', type: 'wait', label: 'To the next day', minutes: 0, hours: 24, days: 0, business_hours_only: true, next: 'e2' },
        {
          key: 'e2', type: 'send_email', label: 'Day 1 — what is actually left',
          purpose: 'transactional',
          subject: 'The part most people get stuck on',
          body: [
            'Hi {first_name},',
            '',
            'The section that stops most people is income, because it asks for the number on your documents rather than what you take home.',
            'You do not need the documents to hand to finish — an estimate is fine and we correct it later.',
            '',
            '{application_link}',
            '',
            'Or call me and we can do it together: {user_cell}',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'w2',
        },
        { key: 'w2', type: 'wait', label: 'To day 2', minutes: 0, hours: 24, days: 0, business_hours_only: true, next: 'e3' },
        {
          key: 'e3', type: 'send_email', label: 'Day 2 — Underwriting Team voice',
          purpose: 'service',
          subject: 'What we would look at on a {purpose} in {property_province}',
          body: [
            'Hi {first_name},',
            '',
            'This is the underwriting desk at {organization_name} rather than your broker.',
            'When a {purpose} comes to us, the first thing we check is whether the numbers still work under the qualifying rate rather than the contract rate — that gap is what decides most files.',
            '',
            'You can run it yourself here, no sign-up: {calculator_link}',
            '',
            'If the answer looks wrong to you, that is worth a conversation before you finish the application, not after.',
            '',
            'The Underwriting Team',
          ].join('\n'),
          next: 'w3',
        },
        { key: 'w3', type: 'wait', label: 'To day 4', minutes: 0, hours: 0, days: 2, business_hours_only: true, next: 'e4' },
        {
          key: 'e4', type: 'send_email', label: 'Day 4 — the reason this matters',
          purpose: 'marketing',
          subject: 'The difference between a rate and a mortgage',
          body: [
            'Hi {first_name},',
            '',
            'A bank employee can only offer that bank\'s products, and they are measured on selling them. That is not a criticism of them — it is the job they were hired to do.',
            'Our side of it is different: we are paid to find the lender that fits your file, and we are still here after it closes.',
            '',
            'On a {purpose}, the thing that usually costs people money is not the headline rate — it is the penalty terms nobody read.',
            'The {calculator_name} shows what that actually looks like: {calculator_link}',
            '',
            'Your application is still saved: {application_link}',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'w4',
        },
        { key: 'w4', type: 'wait', label: 'To day 7', minutes: 0, hours: 0, days: 3, business_hours_only: true, next: 'e5' },
        {
          key: 'e5', type: 'send_email', label: 'Day 7 — low pressure',
          purpose: 'marketing',
          subject: 'Still worth ten minutes?',
          body: [
            'Hi {first_name},',
            '',
            'I have not chased you because an unfinished application usually means the timing moved, not that you changed your mind.',
            '',
            'If it has moved, tell me roughly when and I will stop emailing until then.',
            'If it has not, ten minutes on the phone is usually faster than the form: {schedule_link}',
            '',
            '{user_first_name}',
            '{user_cell}',
          ].join('\n'),
          next: 'w5',
        },
        { key: 'w5', type: 'wait', label: 'To day 14', minutes: 0, hours: 0, days: 7, business_hours_only: true, next: 'e6' },
        {
          key: 'e6', type: 'send_email', label: 'Day 14 — last active touch',
          purpose: 'marketing',
          subject: 'Closing this off for now',
          body: [
            'Hi {first_name},',
            '',
            'I am going to stop following up on this one so it is not sitting in your inbox.',
            '',
            'Your application stays saved either way, and the desk keeps an eye on rates for {property_city} regardless: {calculator_link}',
            '',
            'When it is the right time, reply to this email and we pick it straight back up.',
            '',
            'The Underwriting Team, {organization_name}',
          ].join('\n'),
          next: 'done',
        },
        { key: 'done', type: 'stop', label: 'Sequence complete', reason: 'Fourteen-day sequence finished.', next: null },
      ],
    },
  },

  // ── 2. Application completed — confirm, introduce, ask for documents ──
  {
    key: 'application_completed',
    name: 'Application completed — confirmation and document request',
    description:
      'Confirms receipt, names who is handling it, and asks for what underwriting needs. ' +
      'Stops chasing documents the moment they arrive.',
    definition: {
      trigger: { type: 'application.completed', filters: [] },
      entry_conditions: [],
      stop_conditions: UNIVERSAL_STOPS,
      start_node: 'c1',
      nodes: [
        {
          key: 'c1', type: 'send_email', label: 'Immediate confirmation',
          purpose: 'transactional',
          subject: 'We have your application — {portal_reference}',
          body: [
            'Hi {first_name},',
            '',
            'Your application is in and your reference is {portal_reference}.',
            '',
            'What happens next: your file goes to our underwriting desk for a first read, and one of us comes back to you with either a question or an option. That is usually same or next business day.',
            '',
            'If anything changes in the meantime — income, the property, the timing — tell me early. It is much easier to adjust before a lender sees it than after.',
            '',
            '{user_first_name}',
            '{user_cell}',
          ].join('\n'),
          next: 'task1',
        },
        {
          key: 'task1', type: 'create_task', label: 'Underwriting first read',
          title: 'First read: {portal_reference}',
          description: 'New completed application. Confirm the numbers and decide what is missing.',
          category: 'underwriting', priority: 'high', due_in_days: 1, assign_to: 'underwriter',
          next: 'w1',
        },
        { key: 'w1', type: 'wait', label: 'A day', minutes: 0, hours: 24, days: 0, business_hours_only: true, next: 'b1' },
        {
          key: 'b1', type: 'branch', label: 'Anything outstanding?',
          match: 'all',
          conditions: [{ field: 'documents_outstanding', op: 'gt', value: 0 }],
          if_true: 'd1', if_false: 'done',
          next: null,
        },
        {
          key: 'd1', type: 'send_email', label: 'Documents still outstanding',
          purpose: 'transactional',
          subject: 'The documents we still need',
          body: [
            'Hi {first_name},',
            '',
            'We are {documents_outstanding} document(s) short of being able to send your file to a lender.',
            '',
            'You can upload them here — it takes a photo from your phone, nothing needs scanning: {document_upload_link}',
            '',
            'If one of them does not exist or is going to take a while, say so and we will work around it rather than waiting.',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'w2',
        },
        { key: 'w2', type: 'wait', label: 'Two more days', minutes: 0, hours: 0, days: 2, business_hours_only: true, next: 'b2' },
        {
          key: 'b2', type: 'branch', label: 'Still outstanding?',
          match: 'all',
          conditions: [{ field: 'documents_outstanding', op: 'gt', value: 0 }],
          if_true: 'd2', if_false: 'done',
          next: null,
        },
        {
          key: 'd2', type: 'send_email', label: 'Underwriting desk follows up',
          purpose: 'transactional',
          subject: 'Holding your file until we have these',
          body: [
            'Hi {first_name},',
            '',
            'Your file is sitting with us rather than with a lender, waiting on {documents_outstanding} outstanding item(s).',
            '',
            'We are not going to send an incomplete file — a lender that says no once is harder to go back to than one that has not seen it yet.',
            '',
            'Upload here when you can: {document_upload_link}',
            '',
            'The Underwriting Team, {organization_name}',
          ].join('\n'),
          next: 'task2',
        },
        {
          key: 'task2', type: 'create_task', label: 'Call about documents',
          title: 'Call {first_name} — documents outstanding',
          description: 'Two emails have gone without the documents arriving. A call usually resolves it.',
          category: 'follow_up', priority: 'high', due_in_days: 1, assign_to: 'broker',
          next: 'done',
        },
        { key: 'done', type: 'stop', label: 'Done', reason: 'Nothing outstanding.', next: null },
      ],
    },
  },

  // ── 3. Appointment reminders ─────────────────────────────────────────
  {
    key: 'appointment_reminders',
    name: 'Appointment — confirmation and reminders',
    description: 'Confirms on booking, reminds 24 hours and 2 hours before. Stops on cancellation or rebooking.',
    definition: {
      trigger: { type: 'appointment.booked', filters: [] },
      entry_conditions: [],
      stop_conditions: [
        { field: 'future_appointments', op: 'eq', value: 0, reason: 'The appointment was cancelled or has passed.' },
        ...UNIVERSAL_STOPS,
      ],
      start_node: 'a1',
      nodes: [
        {
          key: 'a1', type: 'send_email', label: 'Booking confirmation',
          purpose: 'transactional',
          subject: 'Confirmed — and what to have ready',
          body: [
            'Hi {first_name},',
            '',
            'That is booked, and a calendar invitation is on its way separately.',
            '',
            'Nothing to prepare. If you happen to have your most recent mortgage statement to hand it makes the numbers concrete, but we can talk without it.',
            '',
            'If the time stops working, move it rather than cancelling: {schedule_link}',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'done',
        },
        { key: 'done', type: 'stop', label: 'Reminders handled by the calendar service', reason: 'Confirmation sent.', next: null },
      ],
    },
  },

  // ── 4. No show ───────────────────────────────────────────────────────
  {
    key: 'no_show_rebooking',
    name: 'No show — rebooking',
    description:
      'Runs when an appointment is marked no-show. Three touches then stops: same day, next business day, day 3.',
    definition: {
      trigger: { type: 'appointment.no_show', filters: [] },
      entry_conditions: [],
      stop_conditions: [
        { field: 'future_appointments', op: 'gt', value: 0, reason: 'They rebooked.' },
        ...UNIVERSAL_STOPS,
      ],
      start_node: 'n1',
      nodes: [
        {
          key: 'n1', type: 'send_email', label: '20 minutes later — assume nothing',
          purpose: 'transactional',
          subject: 'Missed you just now',
          body: [
            'Hi {first_name},',
            '',
            'We had a call booked and I could not reach you — no problem at all, these things move.',
            '',
            'Grab whatever slot suits: {schedule_link}',
            '',
            'Or reply with two times that work and I will send an invitation.',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'w1',
        },
        { key: 'w1', type: 'wait', label: 'Next business day', minutes: 0, hours: 0, days: 1, business_hours_only: true, next: 'n2' },
        {
          key: 'n2', type: 'send_email', label: 'Next day',
          purpose: 'transactional',
          subject: 'Worth another go?',
          body: [
            'Hi {first_name},',
            '',
            'Still happy to go through your {purpose} whenever it suits — it is a ten minute conversation, not a pitch.',
            '',
            '{schedule_link}',
            '',
            '{user_first_name}',
            '{user_cell}',
          ].join('\n'),
          next: 'w2',
        },
        { key: 'w2', type: 'wait', label: 'To day 3', minutes: 0, hours: 0, days: 2, business_hours_only: true, next: 'n3' },
        {
          key: 'n3', type: 'send_email', label: 'Day 3 — last rebooking attempt',
          purpose: 'marketing',
          subject: 'Leaving this with you',
          body: [
            'Hi {first_name},',
            '',
            'I will stop chasing the call. If it becomes relevant again, reply here and we will pick it up.',
            '',
            'In the meantime this is the calculator that does most of the work on a {purpose}: {calculator_link}',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'done',
        },
        { key: 'done', type: 'stop', label: 'Moved to nurture', reason: 'Three rebooking attempts made.', next: null },
      ],
    },
  },

  // ── 5. Renewal ───────────────────────────────────────────────────────
  {
    key: 'renewal_runway',
    name: 'Renewal — 120 days out',
    description:
      'Starts four months before maturity, which is when a lender\'s own renewal letter usually has not arrived yet.',
    definition: {
      trigger: { type: 'maturity.approaching', offset_days: 120, filters: [] },
      entry_conditions: [],
      stop_conditions: UNIVERSAL_STOPS,
      start_node: 'r1',
      nodes: [
        {
          key: 'r1', type: 'send_email', label: '120 days — the early one',
          purpose: 'marketing',
          subject: 'Your mortgage matures {maturity_date}',
          body: [
            'Hi {first_name},',
            '',
            'Your mortgage matures on {maturity_date}, which is {days_to_maturity} days away.',
            '',
            'I am flagging it now rather than at the end because your current lender will send a renewal offer close to the date, when there is no time left to compare it. An offer you cannot check is not really an offer.',
            '',
            'This compares staying against moving, including the cost of moving: {calculator_link}',
            '',
            'No action needed today. If you want me to look at it properly, reply and I will.',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'task1',
        },
        {
          key: 'task1', type: 'create_task', label: 'Renewal review',
          title: 'Renewal review: {first_name} {last_name} — matures {maturity_date}',
          description: 'Renewal runway started. Pull the current terms and prepare options.',
          category: 'renewal', priority: 'normal', due_in_days: 7, assign_to: 'broker',
          next: 'done',
        },
        { key: 'done', type: 'stop', label: 'Handed to the broker', reason: 'Renewal review task created.', next: null },
      ],
    },
  },

  // ── 6. Lost-client reactivation ──────────────────────────────────────
  {
    key: 'lost_reactivation',
    name: 'Lost file — long-term nurture',
    description:
      'For files marked Lost without suppression. Deliberately slow and useful; the point is to still be there later.',
    definition: {
      trigger: { type: 'stage.changed', filters: [{ field: 'stage_category', op: 'eq', value: 'lost' }] },
      entry_conditions: [],
      stop_conditions: [
        { field: 'stage_category', op: 'eq', value: 'open', reason: 'The file reopened.' },
      ],
      start_node: 'l1',
      nodes: [
        { key: 'l1', type: 'wait', label: 'Let it settle — 30 days', minutes: 0, hours: 0, days: 30, business_hours_only: true, next: 'l2' },
        {
          key: 'l2', type: 'send_email', label: '30 days — no pitch',
          purpose: 'marketing',
          subject: 'No agenda, just the numbers',
          body: [
            'Hi {first_name},',
            '',
            'We did not end up working together on this one, which is completely fine.',
            '',
            'You are on my list for one thing only: if something changes in the market that would matter to someone in {property_city}, I will tell you. That is the whole arrangement.',
            '',
            'This is the calculator worth keeping: {calculator_link}',
            '',
            '{user_first_name}',
          ].join('\n'),
          next: 'done',
        },
        { key: 'done', type: 'stop', label: 'In long-term nurture', reason: 'Reactivation touch sent.', next: null },
      ],
    },
  },
];
