import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tabla `auth_sessions` (opcion A: tabla unica con familias de refresh).
 *
 * - Una fila = un refresh token vigente o historico. Solo se guarda el
 *   hash SHA-256, nunca el valor crudo.
 * - `family_id`: todos los refresh de una misma cadena de rotacion
 *   comparten familia. Reutilizar un token `rotated` revoca la familia
 *   completa (robo), sin afectar otras sesiones del usuario.
 * - `status`: `active` | `rotated` | `revoked` (ver `AuthSessionStatus`).
 * - Instantes en `timestamptz`, como el resto del esquema. Sin FK a `users`
 *   a proposito: coherente con `outbox`, que tampoco usa FK.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),
    userId: uuid('user_id').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_sessions_refresh_hash_unique').on(t.refreshHash),
    index('auth_sessions_family_idx').on(t.familyId),
    index('auth_sessions_user_idx').on(t.userId, t.status),
  ],
);

export type AuthSessionRow = typeof authSessions.$inferSelect;
export type NewAuthSessionRow = typeof authSessions.$inferInsert;
