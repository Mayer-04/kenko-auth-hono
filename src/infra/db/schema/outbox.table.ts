import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/**
 * Outbox transaccional para `UserRegistered`.
 *
 * El repositorio inserta usuario + fila `pending` en la misma transaccion.
 * El relay (worker separado, opcion B) publica a EventBridge y marca `sent`.
 * `event_id` unico da idempotencia ante reintentos del relay.
 */
export const outbox = pgTable(
	"outbox",
	{
		id: uuid("id").primaryKey(),
		eventId: uuid("event_id").notNull(),
		aggregateType: text("aggregate_type").notNull().default("user"),
		aggregateId: uuid("aggregate_id").notNull(),
		eventType: text("event_type").notNull(),
		eventVersion: text("event_version").notNull(),
		correlationId: text("correlation_id").notNull(),
		payload: jsonb("payload").notNull(),
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", {
			withTimezone: true,
			mode: "string",
		})
			.notNull()
			.defaultNow(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
			.notNull()
			.defaultNow(),
		publishedAt: timestamp("published_at", {
			withTimezone: true,
			mode: "string",
		}),
	},
	(t) => [
		uniqueIndex("outbox_event_id_unique").on(t.eventId),
		index("outbox_pending_idx").on(t.status, t.nextAttemptAt),
	],
);

export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;
