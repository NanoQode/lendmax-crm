/**
 * Live updates to the browser, over Server-Sent Events.
 *
 * Why SSE and not a WebSocket: this needs to carry events one way, from the
 * server to an open tab. SSE is that, it is in Node and in every browser with
 * no dependency, it reconnects on its own when a laptop wakes up, and it rides
 * the ordinary HTTP proxy in front of this service. A WebSocket would add a
 * package and an nginx `Upgrade` block to deliver the same thing.
 *
 * Two things this deliberately does NOT do:
 *
 *   IT IS NOT A DELIVERY GUARANTEE. Everything sent here is also readable from
 *   the database, and the client reconciles on reconnect. A dropped event
 *   costs a refresh, never a message.
 *
 *   IT DOES NOT SPAN PROCESSES. Subscribers live in this process's memory, so
 *   two HTTP instances behind a load balancer would each only reach their own
 *   tabs. That is correct for this deployment — one process, per
 *   `deploy/lendmax-brokerage-crm.service` — and the fix when that changes is
 *   Postgres LISTEN/NOTIFY behind `publish()`, which is why every caller goes
 *   through it rather than touching the map.
 */
import type { Response } from 'express';
import { log } from '../lib/logger.ts';

export type RealtimeEvent = { type: string; [key: string]: unknown };

type Subscriber = {
  id: number;
  userId: string;
  organizationId: string;
  res: Response;
};

let nextId = 1;
const byUser = new Map<string, Set<Subscriber>>();

/**
 * Comments keep the connection open through anything that times out an idle
 * one — nginx's `proxy_read_timeout` is 120s in front of this service, and a
 * mobile network's is shorter still.
 */
const HEARTBEAT_MS = 25_000;
let heartbeat: NodeJS.Timeout | null = null;

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const set of byUser.values()) {
      for (const sub of set) {
        try { sub.res.write(': ping\n\n'); } catch { drop(sub); }
      }
    }
  }, HEARTBEAT_MS);
  // Without this a test process, and `npm start` on a quiet night, would never
  // be able to exit.
  heartbeat.unref();
}

function drop(sub: Subscriber): void {
  const set = byUser.get(sub.userId);
  if (!set) return;
  set.delete(sub);
  if (set.size === 0) byUser.delete(sub.userId);
  if (byUser.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/**
 * Take over a request as an event stream. Returns the teardown, which the
 * route wires to the socket closing.
 */
export function subscribe(
  userId: string,
  organizationId: string,
  res: Response,
): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Understood by nginx even when the site config has not been told to stop
    // buffering this path. Without one or the other, events sit in a proxy
    // buffer and "live" means "a minute later".
    'X-Accel-Buffering': 'no',
  });
  // Flushing the headers matters: the browser's EventSource does not consider
  // itself open until something arrives, and a `retry` sets how long it waits
  // before coming back.
  res.write('retry: 3000\n\n');
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  const sub: Subscriber = { id: nextId++, userId, organizationId, res };
  let set = byUser.get(userId);
  if (!set) byUser.set(userId, (set = new Set()));
  set.add(sub);
  startHeartbeat();
  log.debug('realtime subscriber joined', { userId, open: set.size });

  return () => drop(sub);
}

/** Send one event to every open tab of every one of these people. */
export function publish(userIds: Iterable<string>, event: RealtimeEvent): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const set = byUser.get(userId);
    if (!set) continue;
    for (const sub of set) {
      try {
        sub.res.write(payload);
      } catch (err) {
        log.debug('realtime write failed; dropping subscriber', { userId, error: err });
        drop(sub);
      }
    }
  }
}

/**
 * Who has a tab open right now.
 *
 * Used to decide whether a message also needs to ring the notification bell:
 * somebody watching the conversation has already been told, and a bell entry
 * for what is on their screen is noise.
 */
export function isConnected(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

export function connectionCount(): number {
  let n = 0;
  for (const set of byUser.values()) n += set.size;
  return n;
}

/** Close every stream — shutdown, and between tests. */
export function closeAll(): void {
  for (const set of [...byUser.values()]) {
    for (const sub of [...set]) {
      try { sub.res.end(); } catch { /* already gone */ }
      drop(sub);
    }
  }
  byUser.clear();
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}
