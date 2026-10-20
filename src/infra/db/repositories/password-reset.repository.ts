import { and, eq, isNull, sql } from 'drizzle-orm';

import type {
  PasswordResetRepository,
  PasswordResetUserReader,
} from '../../../features/passwordreset/passwordreset.port.js';
import { newId } from '../../../shared/ids.js';
import {
  OutboxStatus,
  USER_AGGREGATE_TYPE,
} from '../../events/event.constants.js';
import type { DbClient } from '../client.js';
import { outbox, passwordResetTokens, users } from '../schema/index.js';

/**
 * Implementacion Drizzle de la persistencia de recuperacion de contrasena.
 *
 * Tambien implementa `PasswordResetUserReader`: las lecturas de `users` que
 * este feature necesita (contacto por documento e hash por id), con
 * proyecciones minimas. La tabla `users` es del mismo microservicio; el
 * dueño del dominio sigue siendo `features/user`.
 *
 * Atomicidad (criterio de aceptacion):
 * - `createTokenWithOutbox`: invalida tokens anteriores + inserta token +
 *   fila outbox pending en UNA transaccion.
 * - `consumeTokenAndUpdatePassword`: UPDATE condicional del token (activo),
 *   UPDATE del hash de contrasena e invalidacion de los demas tokens en UNA
 *   transaccion. Dos requests concurrentes con el mismo token: solo uno
 *   ve una fila en el UPDATE condicional.
 *
 * Punto de extension (fuera de alcance hoy): cuando existan sesiones y
 * refresh tokens (login/MFA), su revocacion debe ocurrir dentro de
 * `consumeTokenAndUpdatePassword`, en esta misma transaccion.
 */

export const makePasswordResetRepository = (
  client: DbClient,
): PasswordResetRepository & PasswordResetUserReader => {
  const { db } = client;

  return {
    async findByDocument(type: string, number: string) {
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
        })
        .from(users)
        .where(
          and(eq(users.documentType, type), eq(users.documentNumber, number)),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { id: row.id, email: row.email, firstName: row.firstName };
    },

    async findUserById(id: string) {
      const rows = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { id: row.id, passwordHash: row.passwordHash };
    },

    async createTokenWithOutbox({ token, outbox: event }) {
      await db.transaction(async (tx) => {
        // Invalida cualquier token pendiente previo del usuario.
        await tx
          .update(passwordResetTokens)
          .set({ invalidatedAt: sql`now()` })
          .where(
            and(
              eq(passwordResetTokens.userId, token.userId),
              isNull(passwordResetTokens.usedAt),
              isNull(passwordResetTokens.invalidatedAt),
            ),
          );
        await tx.insert(passwordResetTokens).values({
          id: token.id,
          userId: token.userId,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
          correlationId: token.correlationId,
        });
        await tx.insert(outbox).values({
          id: newId(),
          eventId: event.eventId,
          aggregateType: USER_AGGREGATE_TYPE,
          aggregateId: token.userId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          correlationId: event.correlationId,
          payload: event.payload,
          status: OutboxStatus.PENDING,
          attempts: 0,
        });
      });
    },

    async findActiveTokenByHash(tokenHash: string) {
      const rows = await db
        .select({ userId: passwordResetTokens.userId })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            isNull(passwordResetTokens.invalidatedAt),
            // `now()` de la BD: la expiracion se evalua contra el reloj de
            // la base de datos, no contra el reloj de la aplicacion.
            sql`${passwordResetTokens.expiresAt} > now()`,
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { userId: row.userId };
    },

    async consumeTokenAndUpdatePassword({ tokenHash, userId, passwordHash }) {
      return db.transaction(async (tx) => {
        const consumed = await tx
          .update(passwordResetTokens)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash),
              eq(passwordResetTokens.userId, userId),
              isNull(passwordResetTokens.usedAt),
              isNull(passwordResetTokens.invalidatedAt),
              sql`${passwordResetTokens.expiresAt} > now()`,
            ),
          )
          .returning({ id: passwordResetTokens.id });
        if (consumed.length === 0) return false;

        await tx
          .update(users)
          .set({ passwordHash, updatedAt: sql`now()` })
          .where(eq(users.id, userId));

        // Invalida el resto de tokens pendientes del usuario en la MISMA
        // transaccion. Punto de extension: revocar sesiones/refresh tokens
        // aqui, cuando esas features existan.
        await tx
          .update(passwordResetTokens)
          .set({ invalidatedAt: sql`now()` })
          .where(
            and(
              eq(passwordResetTokens.userId, userId),
              isNull(passwordResetTokens.usedAt),
              isNull(passwordResetTokens.invalidatedAt),
            ),
          );

        return true;
      });
    },
  };
};

export type PasswordResetPersistence = ReturnType<
  typeof makePasswordResetRepository
>;
