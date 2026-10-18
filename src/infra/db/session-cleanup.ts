import { LoginLimits } from '../../features/login/login.limits.js';
import type { SessionStore } from '../../features/login/login.port.js';

/**
 * Purga periodica de `auth_sessions`, ejecutada por el worker del relay.
 *
 * - `runIfDue` corre como mucho una vez por `intervalMs`; entre ticks es un
 *   no-op barato (comparar fechas). Guarda `lastRunMs` en memoria: si el
 *   worker reinicia, la proxima purga ocurre en el siguiente tick.
 * - Cada purga borra por lotes hasta agotar (`purgeStale` devuelve menos
 *   del lote cuando ya no queda nada). Idempotente: re-ejecutar no dana.
 * - `nowMs` inyectable para pruebas deterministas.
 */

export type SessionCleanupOptions = {
  retentionDays?: number;
  batchLimit?: number;
  intervalMs?: number;
  nowMs?: () => number;
};

export type SessionCleanup = {
  runIfDue(): Promise<{ ran: boolean; deleted: number }>;
};

export const makeSessionCleanup = (
  sessions: SessionStore,
  options: SessionCleanupOptions = {},
): SessionCleanup => {
  const retentionDays =
    options.retentionDays ?? LoginLimits.SESSION_RETENTION_DAYS;
  const batchLimit =
    options.batchLimit ?? LoginLimits.SESSION_CLEANUP_BATCH_LIMIT;
  const intervalMs =
    options.intervalMs ?? LoginLimits.SESSION_CLEANUP_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  let lastRunMs: number | null = null;

  return {
    async runIfDue() {
      const now = nowMs();
      if (lastRunMs !== null && now - lastRunMs < intervalMs) {
        return { ran: false, deleted: 0 };
      }
      let deleted = 0;
      for (;;) {
        const batch = await sessions.purgeStale(retentionDays, batchLimit);
        deleted += batch;
        if (batch < batchLimit) break;
      }
      lastRunMs = now;
      return { ran: true, deleted };
    },
  };
};
