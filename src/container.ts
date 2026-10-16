import type winston from 'winston';

import { loadEnv, resolveDatabase } from './config/env.js';
import { initLogger } from './config/logger.js';
import { makeRegisterService } from './features/register/index.js';
import type { RegisterService } from './features/register/register.port.js';
import { createDb, type DbClient } from './infra/db/client.js';
import { makeUserRepository } from './infra/db/repositories/user.repository.js';
import {
  createEventBridgeClient,
  resolveBusName,
} from './infra/events/eventbridge-client.js';
import { makeArgon2Hasher } from './infra/password/argon2-hasher.js';
import { newId } from './shared/ids.js';
import { LogEvent } from './shared/log-events.js';

/**
 * Contenedor: unico lugar que conoce `infra/`.
 * Arma DB, repositorios, hasher y servicio de registro.
 */
export type Container = {
  env: ReturnType<typeof loadEnv>;
  logger: winston.Logger;
  dbClient: DbClient;
  registerService: RegisterService;
  eventBusName: string;
};

export const buildContainer = (): Container => {
  const env = loadEnv();
  const logger = initLogger(env.ENVIRONMENT);
  const database = resolveDatabase(env);

  logger.info(LogEvent.DATABASE_TARGET, {
    target: database.target,
    ...database.safeDescription,
  });

  const dbClient = createDb(database.url);
  const users = makeUserRepository(dbClient);
  const hasher = makeArgon2Hasher();
  void createEventBridgeClient(env.AWS_REGION);

  const registerService = makeRegisterService({
    users,
    hasher,
    newUserId: () => newId(),
    newEventId: () => newId(),
    nowIso: () => new Date().toISOString(),
  });

  return {
    env,
    logger,
    dbClient,
    registerService,
    eventBusName: resolveBusName(env.EVENT_BUS_NAME),
  };
};
