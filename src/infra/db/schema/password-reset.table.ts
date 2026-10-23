import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

import { users } from "./user.table.js";

/**
 * Tokens de restablecimiento de contrasena.
 *
 * - `token_hash` es SHA-256 del token opaco (unico). El token en claro NUNCA
 *   se almacena; la validacion es una busqueda por hash.
 * - `used_at` marca el consumo (un solo uso); `invalid_at` marca la
 *   invalidacion (solicitud nueva o consumo que limpia los demas).
 * - Un token esta activo si `used_at IS NULL AND invalidated_at IS NULL
 *   AND expires_at > now()`. Esa condicion es la clausula del UPDATE
 *   condicional atomico del consumo.
 * - Instantes en `timestamptz`; `correlation_id` para trazabilidad.
 */
export const passwordResetTokens = pgTable(
	"password_reset_tokens",
	{
		id: uuid("id").primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
		invalidatedAt: timestamp("invalidated_at", {
			withTimezone: true,
			mode: "string",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		correlationId: text("correlation_id").notNull(),
	},
	(t) => [
		uniqueIndex("password_reset_tokens_hash_unique").on(t.tokenHash),
		index("password_reset_tokens_user_idx").on(t.userId),
	],
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetTokenRow = typeof passwordResetTokens.$inferInsert;
