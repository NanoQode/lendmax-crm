/**
 * Segments: who a campaign goes to, and who it does not.
 *
 * A segment is STRUCTURE, never SQL. It is stored as a document, rendered to
 * a parameterised query by this module, and explained back to a person in
 * words on the screen. Three reasons, in order of how much they matter:
 *
 *   A stored SQL string is an injection surface that a marketing screen
 *   should not have.
 *
 *   A structured filter can be explained. "Everyone in Ontario whose mortgage
 *   matures in the next 180 days" is a sentence; a WHERE clause is not, and a
 *   campaign nobody can read the audience of is a campaign nobody should send.
 *
 *   It can be re-evaluated and counted before it is sent, which is where the
 *   consent arithmetic below happens.
 *
 * THE CONSENT ARITHMETIC IS THE POINT OF THIS FILE. A marketing campaign's
 * real audience is not "everyone who matches" — it is everyone who matches
 * AND has a basis to be sent commercial messages AND is not suppressed AND
 * has an address. The difference between those two numbers is often half,
 * and a screen that shows only the first sets up a brokerage to believe it
 * reached four thousand people when it reached two.
 */

export type Operator =
  | 'eq' | 'ne' | 'in' | 'not_in'
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'is_set' | 'is_empty'
  | 'within_days' | 'older_than_days';

export type Criterion = { field: string; op: Operator; value?: unknown };

export type Segment = {
  match?: 'all' | 'any';
  criteria?: Criterion[];
  /** Customers to leave out whatever else matches. */
  exclude_customer_ids?: string[];
};

/**
 * The fields a segment may filter on.
 *
 * A closed list, mapped to real columns. Anything not on it is refused when
 * the segment is saved rather than producing an empty audience at send time.
 */
type FieldSpec = {
  label: string;
  sql: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'enum' | 'stage' | 'pipeline';
  options?: string[];
  help?: string;
};

export const SEGMENT_FIELDS: Record<string, FieldSpec> = {
  province: {
    label: 'Property province', sql: 'app.property_province', type: 'text',
  },
  city: { label: 'Property city', sql: 'app.property_city', type: 'text' },
  pipeline: { label: 'Pipeline', sql: 'pl.key', type: 'pipeline' },
  stage_key: { label: 'Pipeline stage', sql: 'app.stage_key', type: 'stage' },
  stage_category: {
    label: 'Stage category', sql: "COALESCE(ps.category,'open')", type: 'enum',
    options: ['open', 'parked', 'won', 'lost'],
  },
  transaction_type: {
    label: 'Transaction type', sql: 'app.transaction_type_key', type: 'text',
  },
  amount_requested: {
    label: 'Amount requested', sql: 'app.amount_requested', type: 'number',
  },
  days_to_maturity: {
    label: 'Days to maturity', sql: '(ren.maturity_date - CURRENT_DATE)', type: 'number',
    help: 'From a renewal record — a mortgage we funded, or one the client told us about.',
  },
  days_to_close: {
    label: 'Days to closing', sql: '(app.closing_date - CURRENT_DATE)', type: 'number',
  },
  lead_source: { label: 'Lead source', sql: 'c.lead_source', type: 'text' },
  tag: { label: 'Tag', sql: 'c.tags', type: 'text', help: 'Matches any one of the client’s tags.' },
  last_contacted: {
    label: 'Last contacted', sql: 'c.last_contacted_at', type: 'date',
    help: 'Use "not contacted in the last N days" to find people who have gone quiet.',
  },
  created: { label: 'Client added', sql: 'c.created_at', type: 'date' },
  funded: {
    label: 'Has ever funded with us', sql: 'fund.confirmed', type: 'boolean',
  },
  assigned_to: { label: 'Assigned broker', sql: 'assign.user_id', type: 'text' },
};

export type SegmentIssue = { field?: string; message: string };

export function validateSegment(segment: Segment): SegmentIssue[] {
  const issues: SegmentIssue[] = [];
  for (const criterion of segment.criteria ?? []) {
    const spec = SEGMENT_FIELDS[criterion.field];
    if (!spec) {
      issues.push({ field: criterion.field, message: `There is no filter called "${criterion.field}".` });
      continue;
    }
    const needsValue = criterion.op !== 'is_set' && criterion.op !== 'is_empty';
    if (needsValue && (criterion.value === undefined || criterion.value === null
                       || criterion.value === '')) {
      issues.push({
        field: criterion.field,
        message: `"${spec.label}" has no value to compare against.`,
      });
    }
    if ((criterion.op === 'in' || criterion.op === 'not_in') && !Array.isArray(criterion.value)) {
      issues.push({ field: criterion.field, message: `"${spec.label}" needs a list of values.` });
    }
    if ((criterion.op === 'within_days' || criterion.op === 'older_than_days')
        && spec.type !== 'date') {
      issues.push({
        field: criterion.field,
        message: `"${spec.label}" is not a date, so "in the last N days" does not apply to it.`,
      });
    }
  }
  return issues;
}

export type BuiltSegment = { where: string; params: unknown[]; describe: string[] };

/**
 * Turn a segment into a WHERE fragment and its parameters.
 *
 * `startAt` is the number of parameters the caller has already bound, so this
 * can be dropped into a larger query without renumbering anything.
 */
export function buildSegment(segment: Segment, startAt = 0): BuiltSegment {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const describe: string[] = [];
  const next = () => `$${startAt + params.length}`;

  for (const criterion of segment.criteria ?? []) {
    const spec = SEGMENT_FIELDS[criterion.field];
    if (!spec) continue;
    const column = spec.sql;

    switch (criterion.op) {
      case 'is_set':
        clauses.push(`${column} IS NOT NULL`);
        describe.push(`${spec.label} has a value`);
        break;
      case 'is_empty':
        clauses.push(`${column} IS NULL`);
        describe.push(`${spec.label} is empty`);
        break;
      case 'in':
      case 'not_in': {
        params.push((criterion.value as unknown[]).map(String));
        const operator = criterion.op === 'in' ? '=' : '<>';
        clauses.push(`${column}::text ${operator} ANY(${next()}::text[])`);
        describe.push(`${spec.label} is ${criterion.op === 'in' ? '' : 'not '}one of `
          + `${(criterion.value as unknown[]).join(', ')}`);
        break;
      }
      case 'contains':
        if (criterion.field === 'tag') {
          // Tags are an array, so "contains" means membership rather than a
          // substring — a substring match on a tag list would make "renew"
          // match "do-not-renew".
          params.push(String(criterion.value));
          clauses.push(`${next()} = ANY(${column})`);
          describe.push(`tagged "${String(criterion.value)}"`);
        } else {
          params.push(`%${String(criterion.value)}%`);
          clauses.push(`${column}::text ILIKE ${next()}`);
          describe.push(`${spec.label} contains "${String(criterion.value)}"`);
        }
        break;
      case 'within_days':
        params.push(Number(criterion.value));
        clauses.push(`${column} >= now() - (${next()} || ' days')::interval`);
        describe.push(`${spec.label} within the last ${Number(criterion.value)} days`);
        break;
      case 'older_than_days':
        params.push(Number(criterion.value));
        // NULL counts: somebody never contacted is the clearest case of
        // "not contacted in ninety days", and excluding them is the bug.
        clauses.push(`(${column} IS NULL OR ${column} < now() - (${next()} || ' days')::interval)`);
        describe.push(`${spec.label} more than ${Number(criterion.value)} days ago, or never`);
        break;
      default: {
        const operator = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[
          criterion.op as 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'];
        if (spec.type === 'number' || spec.type === 'boolean') {
          params.push(criterion.value);
          clauses.push(`${column} ${operator} ${next()}`);
        } else {
          params.push(String(criterion.value));
          clauses.push(`${column}::text ${operator} ${next()}`);
        }
        const word = { eq: 'is', ne: 'is not', lt: 'is under', lte: 'is at most',
                       gt: 'is over', gte: 'is at least' }[
          criterion.op as 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'];
        describe.push(`${spec.label} ${word} ${String(criterion.value)}`);
      }
    }
  }

  if (segment.exclude_customer_ids?.length) {
    params.push(segment.exclude_customer_ids);
    clauses.push(`c.id <> ALL(${next()}::uuid[])`);
    describe.push(`${segment.exclude_customer_ids.length} client(s) excluded by hand`);
  }

  const join = (segment.match ?? 'all') === 'any' ? ' OR ' : ' AND ';
  return {
    where: clauses.length ? `(${clauses.join(join)})` : 'TRUE',
    params,
    describe,
  };
}

/** The segment in a sentence, for the screen. */
export function describeSegment(segment: Segment): string {
  const { describe } = buildSegment(segment);
  if (!describe.length) return 'Every client.';
  const join = (segment.match ?? 'all') === 'any' ? ', or ' : ', and ';
  return `Clients where ${describe.join(join)}.`;
}

// ── The audience arithmetic ────────────────────────────────────────────────

export type AudienceCount = {
  matched: number;
  /** Broken out by why they will not receive it. */
  suppressed: Array<{ reason: string; count: number }>;
  sendable: number;
};

/**
 * The sentence the campaign screen shows above the send button.
 *
 * Deliberately leads with the number that will actually be sent, then says
 * where the rest went. The failure this exists to prevent is a brokerage
 * believing a campaign reached four thousand people when it reached two
 * thousand and the other two were suppressed for good reasons nobody saw.
 */
export function describeAudience(count: AudienceCount, channel: 'email' | 'sms'): string {
  if (count.matched === 0) return 'Nobody matches this segment.';
  if (count.sendable === 0) {
    return `${count.matched} client(s) match, and none of them can be sent this. `
      + count.suppressed.map((s) => `${s.count} ${s.reason}`).join('; ') + '.';
  }
  const held = count.matched - count.sendable;
  if (held === 0) {
    return `${count.sendable} client(s) will receive this ${channel === 'sms' ? 'text' : 'email'}.`;
  }
  return `${count.sendable} of ${count.matched} matching client(s) will receive this. `
    + `The other ${held} will not: `
    + count.suppressed.map((s) => `${s.count} ${s.reason}`).join(', ') + '.';
}
