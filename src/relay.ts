/**
 * Worker outbox -> EventBridge (opcion B confirmada).
 *
 * Proceso separado del API:
 * - `bun run relay` (dev) / comando propio en prod.
 * - Encuesta cada 5s, publica pendientes, backoff ante fallos.
 * - Termina con SIGINT/SIGTERM.
 */
import { loadEnv, resolveDatabase } from './config/env.js';
import { initLogger } from './config/logger.js';
import { createDb } from './infra/db/client.js';
import { makeOutboxRepository } from './infra/db/repositories/outbox.repository.js';
import { makeSessionRepository } from './infra/db/repositories/session.repository.js';
import { makeSessionCleanup } from './infra/db/session-cleanup.js';
import {
  createEventBridgeClient,
  resolveBusName,
} from './infra/events/eventbridge-client.js';
import { startRelayLoop } from './infra/events/outbox-relay.js';
import { LogEvent } from './shared/log-events.js';

const env = loadEnv();
const logger = initLogger(env.ENVIRONMENT);
const database = resolveDatabase(env);
logger.info(LogEvent.RELAY_STARTING, {
  target: database.target,
  ...database.safeDescription,
});

const dbClient = createDb(database.url);
const outbox = makeOutboxRepository(dbClient);
const sessionCleanup = makeSessionCleanup(makeSessionRepository(dbClient));
const eventBridge = createEventBridgeClient(env.AWS_REGION);
const eventBusName = resolveBusName(env.EVENT_BUS_NAME);

const stop = await startRelayLoop({
  outbox,
  eventBridge,
  eventBusName,
  logger,
  sessionCleanup,
});

const shutdown = () => {
  logger.info(LogEvent.RELAY_STOPPING);
  stop();
  dbClient.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
