import { loadEnv, resolveDatabase } from "./config/env.js";
import { initLogger } from "./config/logger.js";
import { createDb } from "./infra/db/client.js";
import { makeOutboxRepository } from "./infra/db/repositories/outbox.repository.js";
import {
	createEventBridgeClient,
	resolveBusName,
} from "./infra/events/eventbridge-client.js";
import { runRelayOnce } from "./infra/events/outbox-relay.js";
import { LogEvent } from "./shared/log-events.js";

/**
 * Relay one-shot para EventBridge Scheduler -> ECS RunTask.
 *
 * Misma logica que `relay.ts` (loop) y `relay-handler.ts` (Lambda),
 * pero corre UNA pasada `runRelayOnce()` y termina.
 * Ideal para Fargate publico (tiene internet + acceso a RDS privado)
 * sin pagar NAT ni VPC Endpoints que exigiria Lambda en VPC.
 */

const env = loadEnv();
const logger = initLogger(env.ENVIRONMENT);
const database = resolveDatabase(env);

logger.info(LogEvent.RELAY_STARTING, {
	target: database.target,
	mode: "once",
	...database.safeDescription,
});

const dbClient = createDb(database.url);

try {
	const outcome = await runRelayOnce({
		outbox: makeOutboxRepository(dbClient),
		eventBridge: createEventBridgeClient(env.AWS_REGION),
		eventBusName: resolveBusName(env.EVENT_BUS_NAME),
		logger,
	});
	logger.info(LogEvent.RELAY_STOPPING, outcome);
	dbClient.close();
	process.exit(outcome.failed > 0 ? 2 : 0);
} catch (err) {
	logger.error(LogEvent.RELAY_TICK_FAILED, {
		error: err instanceof Error ? err.message : "unknown",
	});
	dbClient.close();
	process.exit(1);
}
