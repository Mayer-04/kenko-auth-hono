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
 * Sesiones de refresh tokens del microservicio Authentication.
 *
 * - `id` UUID v7 (fila de sesion); `family_id` UUID v7 identifica la cadena
 *   de rotacion (el login crea la primera sesion de una familia nueva).
 * - `token_hash` es SHA-256 del refresh opaco (unico). El token en claro
 *   NUNCA se almacena.
 * - `status`: `active` / `rotated` / `revoked`. La rotacion y el reuse
 *   detection (revocar toda la familia al presentar un token ya usado)
 *   viven en el futuro endpoint de refresh; la tabla ya trae la estructura.
 * - Revocacion: el refresh se revoca en BD; un access JWT ya emitido sigue
 *   valido hasta su `exp` (15 min, decision aceptada).
 * - Instantes en `timestamptz`, nunca `timestamp` plano.
 */
export const refreshSessions = pgTable(
	"refresh_sessions",
	{
		id: uuid("id").primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		familyId: uuid("family_id").notNull(),
		tokenHash: text("token_hash").notNull(),
		status: text("status").notNull().default("active"),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		rotatedAt: timestamp("rotated_at", {
			withTimezone: true,
			mode: "string",
		}),
		revokedAt: timestamp("revoked_at", {
			withTimezone: true,
			mode: "string",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		correlationId: text("correlation_id").notNull(),
	},
	(t) => [
		uniqueIndex("refresh_sessions_token_hash_unique").on(t.tokenHash),
		index("refresh_sessions_family_idx").on(t.familyId),
		index("refresh_sessions_user_idx").on(t.userId),
	],
);

export type RefreshSessionRow = typeof refreshSessions.$inferSelect;
export type NewRefreshSessionRow = typeof refreshSessions.$inferInsert;
