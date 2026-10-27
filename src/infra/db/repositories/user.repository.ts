import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type {
	AccountReader,
	EmailChangeStore,
	PasswordChangeStore,
} from "../../../features/account/account.port.js";
import type { UserRepository } from "../../../features/user/user.port.js";
import { newId } from "../../../shared/ids.js";
import {
	OutboxStatus,
	USER_AGGREGATE_TYPE,
} from "../../events/event.constants.js";
import type { DbClient } from "../client.js";
import {
	outbox,
	passwordResetTokens,
	refreshSessions,
	users,
} from "../schema/index.js";

/**
 * Implementacion Drizzle de `UserRepository`.
 *
 * `createWithOutbox` es atomica: inserta `users` + `outbox(pending)` en una
 * transaccion. Un 23505 (UNIQUE en email o documento) lo mapea el servicio
 * a 409 generico.
 *
 * Metodos extra para `account` (invisibles para `register`):
 * `findAccountById`, `changePasswordAndRevokeOthers` (hash nuevo +
 * revocacion de otras familias + invalidacion de resets pendientes en UNA
 * transaccion) y `updateEmailWithOutbox` (email nuevo + `EmailChanged`).
 */
export const makeUserRepository = (
	client: DbClient,
): UserRepository & AccountReader & PasswordChangeStore & EmailChangeStore => {
	const { db } = client;

	return {
		async findByEmail(email: string) {
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.email, email))
				.limit(1);
			const row = rows[0];
			if (row === undefined) return null;
			return {
				id: row.id,
				email: row.email,
				documentType: row.documentType,
				documentNumber: row.documentNumber,
				passwordHash: row.passwordHash,
			};
		},

		async findByDocument(type: string, number: string) {
			const rows = await db
				.select()
				.from(users)
				.where(
					and(eq(users.documentType, type), eq(users.documentNumber, number)),
				)
				.limit(1);
			const row = rows[0];
			if (row === undefined) return null;
			return {
				id: row.id,
				email: row.email,
				documentType: row.documentType,
				documentNumber: row.documentNumber,
				passwordHash: row.passwordHash,
			};
		},

		async createWithOutbox({ user, outbox: event }) {
			await db.transaction(async (tx) => {
				await tx.insert(users).values({
					id: user.id,
					documentType: user.documentType,
					documentNumber: user.documentNumber,
					firstName: user.firstName,
					lastName: user.lastName,
					birthDate: user.birthDate,
					gender: user.gender,
					email: user.email,
					emailVerified: false,
					phone: user.phone,
					addressLine: user.addressLine,
					city: user.city,
					passwordHash: user.passwordHash,
				});
				await tx.insert(outbox).values({
					id: newId(),
					eventId: event.eventId,
					aggregateType: USER_AGGREGATE_TYPE,
					aggregateId: user.id,
					eventType: event.eventType,
					eventVersion: event.eventVersion,
					correlationId: event.correlationId,
					payload: event.payload,
					status: OutboxStatus.PENDING,
					attempts: 0,
				});
			});
		},

		async findAccountById(id: string) {
			const rows = await db
				.select({
					id: users.id,
					email: users.email,
					firstName: users.firstName,
					lastName: users.lastName,
					passwordHash: users.passwordHash,
				})
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			const row = rows[0];
			if (row === undefined) return null;
			return {
				id: row.id,
				email: row.email,
				firstName: row.firstName,
				lastName: row.lastName,
				passwordHash: row.passwordHash,
			};
		},

		async changePasswordAndRevokeOthers({
			userId,
			passwordHash,
			keepFamilyId,
		}) {
			return db.transaction(async (tx) => {
				const updated = await tx
					.update(users)
					.set({ passwordHash, updatedAt: sql`now()` })
					.where(eq(users.id, userId))
					.returning({ id: users.id });
				if (updated.length === 0) return false;

				// Revoca sesiones `active` de otras familias. Sin
				// `keepFamilyId` (token pre-`sid`) revoca todo.
				const sessionFilter =
					keepFamilyId === undefined
						? and(
								eq(refreshSessions.userId, userId),
								eq(refreshSessions.status, "active"),
							)
						: and(
								eq(refreshSessions.userId, userId),
								eq(refreshSessions.status, "active"),
								ne(refreshSessions.familyId, keepFamilyId),
							);
				await tx
					.update(refreshSessions)
					.set({ status: "revoked", revokedAt: sql`now()` })
					.where(sessionFilter);

				// Invalida los tokens de restablecimiento pendientes.
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

		async updateEmailWithOutbox({ userId, newEmail, outbox: event }) {
			return db.transaction(async (tx) => {
				const updated = await tx
					.update(users)
					.set({ email: newEmail, updatedAt: sql`now()` })
					.where(eq(users.id, userId))
					.returning({ id: users.id });
				if (updated.length === 0) return false;

				await tx.insert(outbox).values({
					id: newId(),
					eventId: event.eventId,
					aggregateType: USER_AGGREGATE_TYPE,
					aggregateId: userId,
					eventType: event.eventType,
					eventVersion: event.eventVersion,
					correlationId: event.correlationId,
					payload: event.payload,
					status: OutboxStatus.PENDING,
					attempts: 0,
				});
				return true;
			});
		},
	};
};
