import {
  boolean,
  date,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tabla `users` del microservicio Authentication.
 *
 * - `id` UUID v7.
 * - `birth_date` es `date` (fecha de calendario, no instante).
 * - Instantes en `timestamptz`, nunca `timestamp` plano.
 * - Unicidad: `email` y par `(document_type, document_number)` como defensa
 *   final contra carreras concurrentes (el servicio chequea antes y mapea
 *   23505 a 409 generico).
 * - Enums como `text` sin check rigido para poder ampliar `male/female/other`
 *   y `CC/TI/CE/PA` sin migracion de tipo.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    documentType: text('document_type').notNull(),
    documentNumber: text('document_number').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    birthDate: date('birth_date').notNull(),
    gender: text('gender').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    phone: text('phone').notNull(),
    addressLine: text('address_line').notNull(),
    city: text('city').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_document_unique').on(t.documentType, t.documentNumber),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
