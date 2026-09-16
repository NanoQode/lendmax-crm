/**
 * Recording a domain event — the thing an automation trigger listens for.
 *
 * Every module that does something an automation might start from calls this,
 * inside its own transaction where it has one, so an event is recorded if and
 * only if the change it describes happened. The automation engine drains the
 * table on its own tick (`processEvents`); nothing here runs a workflow.
 *
 * The dedupe key is required. The engine consumes each key once, so a retried
 * request, a double click or a replayed webhook cannot enrol somebody twice.
 */
import type pg from 'pg';
import { pool } from '../db/pool.ts';

export type DomainEvent = {
  organizationId: string;
  type: string;
  customerId: string | null;
  applicationId?: string | null;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  dedupeKey: string;
};

export async function emitEvent(
  event: DomainEvent,
  client: Pick<pg.PoolClient, 'query'> = pool,
): Promise<void> {
  await client.query(
    `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                payload, actor_user_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [event.organizationId, event.type, event.customerId, event.applicationId ?? null,
     JSON.stringify(event.payload ?? {}), event.actorUserId ?? null, event.dedupeKey],
  );
}
