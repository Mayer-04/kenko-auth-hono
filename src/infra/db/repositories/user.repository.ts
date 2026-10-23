import { and, eq } from "drizzle-orm";

import type { UserRepository } from "../../../features/user/user.port.js";
import { newId } from "../../../shared/ids.js";
import {
	OutboxStatus,
	USER_AGGREGATE_TYPE,
} from "../../events/event.constants.js";
import type { DbClient } from "../client.js";
import { outbox, users } from "../schema/index.js";

/**
 * Implementacion Drizzle de `UserRepository`.
 *
 * `createWithOutbox` es atomica: inserta `users` + `outbox(pending)` en una
 * transaccion. Un 23505 (UNIQUE en email o documento) lo mapea el servicio
 * a 409 generico.
 */
export const makeUserRepository = (client: DbClient): UserRepository => {
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
	};
};
