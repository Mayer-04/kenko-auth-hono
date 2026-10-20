import {
  type EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import type winston from 'winston';

import { LogEvent } from '../../shared/log-events.js';
import type { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { normalizeDetail, toPutEventsEntry } from './eventbridge-publisher.js';
import {
  BACKOFF_FIRST_RETRY_SECONDS,
  BACKOFF_MAX_SECONDS,
  BACKOFF_SECOND_RETRY_SECONDS,
  BACKOFF_THIRD_RETRY_SECONDS,
  RELAY_BATCH_LIMIT,
  RELAY_INTERVAL_MS,
} from './relay.constants.js';

/**
 * Relay outbox -> EventBridge (worker separado, opcion B confirmada).
 *
 * - Reclama pendientes, normaliza el payload a objeto (ver `normalizeDetail`),
 *   publica en lotes de max 10 (limite PutEvents), marca `sent` o reprograma
 *   con backoff exponencial (5s, 30s, 5min, tope 1h).
 * - Payload irreparable -> estado `dead` (no se reintenta; revision manual).
 *   Estados: `pending` / `sent` / `dead`.
 * - Acepta duplicados y retrasos de segundos: consumidores idempotentes por
 *   `eventId`. Nunca se asume exactly-once.
 * - No se envia `TraceHeader`: debe ser un trace header X-Ray, no nuestro
 *   `correlationId` (ya viaja en `Detail.metadata`).
 * - Logs solo con IDs (`eventId`, `correlationId`); jamas PII del payload.
 */

export const backoffSeconds = (attempts: number): number => {
  if (attempts <= 0) return BACKOFF_FIRST_RETRY_SECONDS;
  if (attempts === 1) return BACKOFF_SECOND_RETRY_SECONDS;
  if (attempts === 2) return BACKOFF_THIRD_RETRY_SECONDS;
  return BACKOFF_MAX_SECONDS;
};

export type RelayDeps = {
  outbox: OutboxRepository;
  eventBridge: EventBridgeClient;
  eventBusName: string;
  logger: winston.Logger;
};

export type RelayOutcome = { published: number; failed: number; dead: number };

export const runRelayOnce = async (deps: RelayDeps): Promise<RelayOutcome> => {
  const pending = await deps.outbox.claimPending(RELAY_BATCH_LIMIT);
  let published = 0;
  let failed = 0;
  let dead = 0;

  for (const row of pending) {
    let detail: ReturnType<typeof normalizeDetail>;
    try {
      detail = normalizeDetail(row.payload);
    } catch (err) {
      dead += 1;
      await deps.outbox.markDead(row.id);
      deps.logger.error(LogEvent.OUTBOX_PAYLOAD_DEAD, {
        eventId: row.eventId,
        correlationId: row.correlationId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      continue;
    }
    if (typeof row.payload === 'string') {
      deps.logger.warn(LogEvent.OUTBOX_PAYLOAD_NORMALIZED, {
        eventId: row.eventId,
        correlationId: row.correlationId,
      });
    }

    // El payload normalizado ya es el `Detail` del contrato; el `DetailType`
    // sale del `eventType` de la fila (agnostico al tipo de evento).
    const entry = toPutEventsEntry(detail, row.eventType, deps.eventBusName);
    try {
      const res = await deps.eventBridge.send(
        new PutEventsCommand({ Entries: [entry] }),
      );
      const item = res.Entries?.[0];
      if (item?.ErrorCode !== undefined) {
        throw new Error(`EventBridge rechazo el evento: ${item.ErrorCode}`);
      }
      await deps.outbox.markSent(row.id);
      published += 1;
      deps.logger.info(LogEvent.OUTBOX_PUBLISHED, {
        eventId: row.eventId,
        correlationId: row.correlationId,
      });
    } catch (err) {
      failed += 1;
      const attempts = row.attempts + 1;
      await deps.outbox.reschedule(
        row.id,
        attempts,
        backoffSeconds(row.attempts),
      );
      deps.logger.warn(LogEvent.OUTBOX_PUBLISH_FAILED, {
        eventId: row.eventId,
        correlationId: row.correlationId,
        attempts,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return { published, failed, dead };
};

/** Bucle del worker. Termina con SIGINT/SIGTERM. */
export const startRelayLoop = async (
  deps: RelayDeps,
  options: { intervalMs?: number } = {},
): Promise<() => void> => {
  const intervalMs = options.intervalMs ?? RELAY_INTERVAL_MS;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runRelayOnce(deps);
    } catch (err) {
      deps.logger.error(LogEvent.RELAY_TICK_FAILED, {
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      if (!stopped) setTimeout(tick, intervalMs).unref?.();
    }
  };

  void tick();
  return () => {
    stopped = true;
  };
};
