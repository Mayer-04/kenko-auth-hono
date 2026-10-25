import { and, eq, inArray, sql } from "drizzle-orm";

import type {
	RefreshSession,
	RefreshSessionStore,
} from "../../../features/login/login.port.js";
import type { DbClient } from "../client.js";
import { refreshSessions } from "../schema/index.js";

/**
 * Implementacion Drizzle de la persistencia de sesiones de refresh.
 *
 * `createLoginSession` inserta la primera sesion de una familia nueva.
 * `rotateSession` es atomica: marca la anterior como `rotated` (solo si
 * sigue `active`) y crea la sucesora en la MISMA transaccion; dos requests
 * concurrentes con el mismo token: solo uno ve una fila en el UPDATE
 * condicional (igual que el consumo del token de restablecimiento).
 * `revokeFamily` revoca todo lo no terminal de la familia (reuse
 * detection). `revokeAllUserSessions` revoca todo lo `active` del usuario
 * (logout y recuperacion de contrasena).
 */
export const makeRefreshSessionRepository = (
	client: DbClient,
): RefreshSessionStore => {
	const { db } = client;

	const toSession = (
		row: typeof refreshSessions.$inferSelect,
	): RefreshSession => ({
		id: row.id,
		userId: row.userId,
		familyId: row.familyId,
		tokenHash: row.tokenHash,
		status: row.status as RefreshSession["status"],
		expiresAt: row.expiresAt,
	});

	return {
		async createLoginSession({
			id,
			userId,
			familyId,
			tokenHash,
			status,
			expiresAt,
			correlationId,
		}) {
			await db.insert(refreshSessions).values({
				id,
				userId,
				familyId,
				tokenHash,
				status,
				expiresAt,
				correlationId,
			});
		},

		async findSessionByTokenHash(tokenHash: string) {
			const rows = await db
				.select()
				.from(refreshSessions)
				.where(eq(refreshSessions.tokenHash, tokenHash))
				.limit(1);
			const row = rows[0];
			if (row === undefined) return null;
			return toSession(row);
		},

		async rotateSession({ oldId, userId, newSession }) {
			return db.transaction(async (tx) => {
				const rotated = await tx
					.update(refreshSessions)
					.set({ status: "rotated", rotatedAt: sql`now()` })
					.where(
						and(
							eq(refreshSessions.id, oldId),
							eq(refreshSessions.userId, userId),
							eq(refreshSessions.status, "active"),
						),
					)
					.returning({ id: refreshSessions.id });
				if (rotated.length === 0) return false;

				await tx.insert(refreshSessions).values({
					id: newSession.id,
					userId,
					familyId: newSession.familyId,
					tokenHash: newSession.tokenHash,
					status: "active",
					expiresAt: newSession.expiresAt,
					correlationId: newSession.correlationId,
				});
				return true;
			});
		},

		async revokeFamily(familyId: string) {
			// Reuso detectado (familia comprometida): todo lo no terminal pasa
			// a `revoked`. A diferencia de `revokeAllUserSessions` (eventos
			// benignos que preservan la historia `rotated`), aqui el estado
			// terminal uniforme simplifica "familia muerta = sin `active`".
			await db
				.update(refreshSessions)
				.set({ status: "revoked", revokedAt: sql`now()` })
				.where(
					and(
						eq(refreshSessions.familyId, familyId),
						inArray(refreshSessions.status, ["active", "rotated"]),
					),
				);
		},

		async revokeAllUserSessions(userId: string) {
			await db
				.update(refreshSessions)
				.set({ status: "revoked", revokedAt: sql`now()` })
				.where(
					// Solo `active`: no se reescribe la historia (`rotated`/`revoked`).
					and(
						eq(refreshSessions.userId, userId),
						eq(refreshSessions.status, "active"),
					),
				);
		},
	};
};
