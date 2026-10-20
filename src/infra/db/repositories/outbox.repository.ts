import { sql } from 'drizzle-orm';

import {
  OutboxStatus,
  REDACTED_OUTBOX_PAYLOAD,
} from '../../events/event.constants.js';
import type { DbClient } from '../client.js';

/**
 * Acceso a la outbox para el relay (worker separado, opcion B).
 *
 * `claimPending` reserva un lote con `FOR UPDATE SKIP LOCKED` para que dos
 * relays no publiquen lo mismo. El relay marca `sent` o reprograma con
 * backoff exponencial.
 *
 * Retencion del payload (minimizacion de exposicion): en los estados
 * terminales `sent` y `dead` el payload se REDACTA. Solo algunos eventos
 * (`PasswordResetRequested`) llevan secretos en el payload (el token en
 * claro, decision D1): una vez publicado o dado por muerto, la fila conserva
 * `event_id` y `correlation_id` para trazabilidad pero deja de retener el
 * token. Los reintentos NO se ven afectados: `reschedule` no toca el payload,
 * que permanece completo hasta llegar a un estado terminal. Compromiso
 * documentado: se pierde el forensic payload de filas terminales.
 */

export type PendingOutbox = {
  id: string;
  eventId: string;
  eventType: string;
  correlationId: string;
  payload: unknown;
  attempts: number;
};

export const makeOutboxRepository = (client: DbClient) => {
  const { db } = client;

  return {
    async claimPending(limit: number): Promise<PendingOutbox[]> {
      const rows = await db.execute(sql`
        SELECT id, event_id, event_type, correlation_id, payload, attempts
        FROM outbox
        WHERE status = ${OutboxStatus.PENDING} AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      const list = rows as unknown as Array<{
        id: string;
        event_id: string;
        event_type: string;
        correlation_id: string;
        payload: unknown;
        attempts: number;
      }>;
      return list.map((r) => ({
        id: r.id,
        eventId: r.event_id,
        eventType: r.event_type,
        correlationId: r.correlation_id,
        payload: r.payload,
        attempts: r.attempts,
      }));
    },

    async markSent(id: string): Promise<void> {
      await db.execute(sql`
        UPDATE outbox
        SET status = ${OutboxStatus.SENT},
            payload = ${REDACTED_OUTBOX_PAYLOAD}::jsonb,
            published_at = NOW()
        WHERE id = ${id}
      `);
    },

    async reschedule(
      id: string,
      attempts: number,
      delaySeconds: number,
    ): Promise<void> {
      await db.execute(sql`
        UPDATE outbox
        SET attempts = ${attempts},
            next_attempt_at = NOW() + (${delaySeconds} || ' seconds')::interval
        WHERE id = ${id}
      `);
    },

    /** Mensaje irreparable: deja de reintentarse y queda para revision manual. */
    async markDead(id: string): Promise<void> {
      await db.execute(sql`
        UPDATE outbox
        SET status = ${OutboxStatus.DEAD},
            payload = ${REDACTED_OUTBOX_PAYLOAD}::jsonb
        WHERE id = ${id}
      `);
    },
  };
};

export type OutboxRepository = ReturnType<typeof makeOutboxRepository>;
