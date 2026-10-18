import { eq, inArray, sql } from 'drizzle-orm';

import type { SessionStore } from '../../../features/login/login.port.js';
import { AuthSessionStatus } from '../../../features/login/login.types.js';
import type { DbClient } from '../client.js';
import { authSessions } from '../schema/index.js';

/**
 * Persistencia de `auth_sessions`.
 *
 * - `rotate` es atomica: bloquea la fila (`FOR UPDATE`), exige estado
 *   `active`, la marca `rotated` e inserta la nueva en la misma transaccion.
 *   Si dos renovaciones concurrentes compiten, una gana y la otra ve `stale`.
 * - `revokeFamily` invalida toda la familia (respuesta ante reutilizacion de
 *   un token rotado); `revokeSession` solo una fila (logout normal).
 */
export const makeSessionRepository = (client: DbClient): SessionStore => {
  const { db } = client;

  return {
    async create(input) {
      await db.insert(authSessions).values({
        id: input.id,
        familyId: input.familyId,
        userId: input.userId,
        refreshHash: input.refreshHash,
        status: AuthSessionStatus.ACTIVE,
        expiresAt: input.expiresAt,
      });
    },

    async findByRefreshHash(hash) {
      const rows = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshHash, hash))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        familyId: row.familyId,
        userId: row.userId,
        refreshHash: row.refreshHash,
        status: row.status,
        expiresAt: row.expiresAt,
      };
    },

    async rotate({ sessionId, newSession, nowIso }) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(authSessions)
          .where(eq(authSessions.id, sessionId))
          .for('update');
        const current = rows[0];
        if (
          current === undefined ||
          current.status !== AuthSessionStatus.ACTIVE
        ) {
          return 'stale' as const;
        }
        await tx
          .update(authSessions)
          .set({ status: AuthSessionStatus.ROTATED, lastUsedAt: nowIso })
          .where(eq(authSessions.id, sessionId));
        await tx.insert(authSessions).values({
          id: newSession.id,
          familyId: newSession.familyId,
          userId: newSession.userId,
          refreshHash: newSession.refreshHash,
          status: AuthSessionStatus.ACTIVE,
          expiresAt: newSession.expiresAt,
        });
        return 'rotated' as const;
      });
    },

    async revokeSession(id) {
      await db
        .update(authSessions)
        .set({ status: AuthSessionStatus.REVOKED })
        .where(eq(authSessions.id, id));
    },

    async revokeFamily(familyId) {
      await db
        .update(authSessions)
        .set({ status: AuthSessionStatus.REVOKED })
        .where(eq(authSessions.familyId, familyId));
    },

    async purgeStale(retentionDays, limit) {
      const stale = (await db.execute(sql`
        SELECT id FROM auth_sessions
        WHERE (status IN (${AuthSessionStatus.ROTATED}, ${AuthSessionStatus.REVOKED})
               AND last_used_at < NOW() - (${retentionDays} || ' days')::interval)
           OR (expires_at < NOW() - (${retentionDays} || ' days')::interval)
        ORDER BY last_used_at ASC
        LIMIT ${limit}
      `)) as unknown as Array<{ id: string }>;
      const ids = stale.map((row) => row.id);
      if (ids.length === 0) return 0;
      await db.delete(authSessions).where(inArray(authSessions.id, ids));
      return ids.length;
    },
  };
};
