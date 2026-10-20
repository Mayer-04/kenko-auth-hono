import type winston from 'winston';

import { loadEnv, resolveDatabase } from './config/env.js';
import { initLogger } from './config/logger.js';
import {
  MS_PER_MINUTE,
  makeForgotPasswordService,
  makeResetPasswordService,
  PasswordResetLimits,
} from './features/passwordreset/index.js';
import type {
  ForgotService,
  PasswordResetLogger,
  ResetService,
} from './features/passwordreset/passwordreset.port.js';
import type { PasswordResetRouteLimits } from './features/passwordreset/passwordreset.route.js';
import { makeRegisterService } from './features/register/index.js';
import type { RegisterService } from './features/register/register.port.js';
import { createDb, type DbClient } from './infra/db/client.js';
import { makePasswordResetRepository } from './infra/db/repositories/password-reset.repository.js';
import { makeUserRepository } from './infra/db/repositories/user.repository.js';
import {
  createEventBridgeClient,
  resolveBusName,
} from './infra/events/eventbridge-client.js';
import { makeArgon2Hasher } from './infra/password/argon2-hasher.js';
import { makeInMemoryRateLimiter } from './infra/ratelimit/in-memory-rate-limiter.js';
import { makeResetTokenTool } from './infra/security/reset-token.js';
import { newId } from './shared/ids.js';
import { LogEvent } from './shared/log-events.js';
import type { RateLimiter } from './shared/ratelimit/ratelimit.port.js';

/**
 * Contenedor: unico lugar que conoce `infra/`.
 * Arma DB, repositorios, hasher, token tool, rate limiter y servicios.
 */
export type Container = {
  env: ReturnType<typeof loadEnv>;
  logger: winston.Logger;
  dbClient: DbClient;
  registerService: RegisterService;
  forgotService: ForgotService;
  resetService: ResetService;
  rateLimiter: RateLimiter;
  routeLimits: PasswordResetRouteLimits;
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

  const tokenTool = makeResetTokenTool(PasswordResetLimits.TOKEN_RANDOM_BYTES);
  const passwordResets = makePasswordResetRepository(dbClient);

  /** Adaptador Winston -> puerto minimo del feature (solo IDs, sin PII). */
  const resetLogger: PasswordResetLogger = {
    info: (event, ids) => {
      logger.info(event, ids);
    },
    warn: (event, ids) => {
      logger.warn(event, ids);
    },
  };

  const forgotService = makeForgotPasswordService({
    users: passwordResets,
    tokens: passwordResets,
    tokenTool,
    newTokenId: () => newId(),
    newEventId: () => newId(),
    now: () => new Date(),
    ttlMinutes: PasswordResetLimits.TOKEN_TTL_MINUTES,
    baseUrl: env.PORTAL_BASE_URL,
    logger: resetLogger,
  });

  const resetService = makeResetPasswordService({
    users: passwordResets,
    tokens: passwordResets,
    hasher,
    tokenTool,
    logger: resetLogger,
  });

  const rateLimiter = makeInMemoryRateLimiter({
    bucketsMax: PasswordResetLimits.RATE_BUCKETS_MAX,
  });

  const routeLimits: PasswordResetRouteLimits = {
    forgotIpMax: PasswordResetLimits.FORGOT_IP_MAX_REQUESTS,
    forgotDocumentMax: PasswordResetLimits.FORGOT_DOCUMENT_MAX_REQUESTS,
    forgotCooldownSeconds: PasswordResetLimits.FORGOT_DOCUMENT_COOLDOWN_SECONDS,
    resetIpMax: PasswordResetLimits.RESET_IP_MAX_REQUESTS,
    windowMs: PasswordResetLimits.RATE_WINDOW_MINUTES * MS_PER_MINUTE,
  };

  return {
    env,
    logger,
    dbClient,
    registerService,
    forgotService,
    resetService,
    rateLimiter,
    routeLimits,
    eventBusName: resolveBusName(env.EVENT_BUS_NAME),
  };
};
