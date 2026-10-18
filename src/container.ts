import type winston from 'winston';

import { loadEnv, resolveDatabase } from './config/env.js';
import { initLogger } from './config/logger.js';
import {
  type LoginService,
  type LogoutService,
  makeLoginService,
  makeLogoutService,
  makeRefreshService,
  type RefreshService,
} from './features/login/index.js';
import { LoginLimits } from './features/login/login.limits.js';
import type { RateLimiter } from './features/login/login.rate-limit.js';
import { createLoginRateLimiter } from './features/login/login.rate-limit.js';
import { makeRegisterService } from './features/register/index.js';
import type { RegisterService } from './features/register/register.port.js';
import { makeRefreshTokenFactory } from './infra/auth/refresh-token.js';
import { makeAccessTokenIssuer } from './infra/auth/token-issuer.js';
import type { DbClient } from './infra/db/client.js';
import { createDb } from './infra/db/client.js';
import { makeLoginCredentialsRepository } from './infra/db/repositories/login-credentials.repository.js';
import { makeSessionRepository } from './infra/db/repositories/session.repository.js';
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
 * Arma DB, repositorios, hasher, issuer de tokens y servicios.
 */
export type Container = {
  env: ReturnType<typeof loadEnv>;
  logger: winston.Logger;
  dbClient: DbClient;
  registerService: RegisterService;
  loginService: LoginService;
  refreshService: RefreshService;
  logoutService: LogoutService;
  rateLimiter: RateLimiter;
  cookieSecure: boolean;
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
  const credentials = makeLoginCredentialsRepository(dbClient);
  const sessions = makeSessionRepository(dbClient);
  const hasher = makeArgon2Hasher();
  const refresher = makeRefreshTokenFactory();
  const issuer = makeAccessTokenIssuer({
    secret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ttlSec: LoginLimits.ACCESS_TOKEN_TTL_SEC,
  });
  void createEventBridgeClient(env.AWS_REGION);

  const registerService = makeRegisterService({
    users,
    hasher,
    newUserId: () => newId(),
    newEventId: () => newId(),
    nowIso: () => new Date().toISOString(),
  });
  const loginService = makeLoginService({
    credentials,
    sessions,
    verifier: hasher,
    signer: issuer,
    refresher,
    newSessionId: () => newId(),
    newFamilyId: () => newId(),
    nowIso: () => new Date().toISOString(),
  });
  const refreshService = makeRefreshService({
    credentials,
    sessions,
    signer: issuer,
    refresher,
    newSessionId: () => newId(),
    nowIso: () => new Date().toISOString(),
  });
  const logoutService = makeLogoutService({ sessions, refresher });

  return {
    env,
    logger,
    dbClient,
    registerService,
    loginService,
    refreshService,
    logoutService,
    rateLimiter: createLoginRateLimiter(),
    cookieSecure: env.ENVIRONMENT === 'production',
    eventBusName: resolveBusName(env.EVENT_BUS_NAME),
  };
};
