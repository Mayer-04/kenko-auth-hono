import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import {
  AppError,
  internalError,
  rateLimitedError,
} from '../../shared/errors.js';
import {
  CACHE_CONTROL_HEADER,
  FORWARDED_FOR_HEADER,
  NO_STORE,
  RETRY_AFTER_HEADER,
} from '../../shared/headers.js';
import { type AppVariables, ok } from '../../shared/http.js';
import { LogEvent } from '../../shared/log-events.js';
import type { RateLimiter } from '../../shared/ratelimit/ratelimit.port.js';
import { MS_PER_SECOND } from './passwordreset.limits.js';
import type {
  ForgotService,
  PasswordResetLogger,
  ResetService,
} from './passwordreset.port.js';
import {
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from './passwordreset.schema.js';

/**
 * `POST /auth/password/forgot` y `POST /auth/password/reset`.
 *
 * Seguridad (criterios de aceptacion):
 * - Ambos responden con `Cache-Control: no-store`.
 * - `forgot` SIEMPRE responde igual (mismo status, cuerpo y cabeceras)
 *   exista o no la cuenta: el servicio no distingue y aqui no se añade
 *   informacion. La diferencia de tiempo entre caminos queda acotada por
 *   diseño (el camino inexistente solo consulta) y se documenta como
 *   riesgo residual aceptado: sobre red domina el jitter; se midio en
 *   integracion y no se añadio retardo artificial por sobreingenieria.
 * - `reset` recibe el token en el BODY (nunca en la URL) y usa un unico
 *   error generico `PASSWORD_RESET_INVALID`.
 * - Rate limiting por IP (ambos) y por documento + enfriamiento (forgot).
 *   La IP sale de `X-Forwarded-For` si existe; sin proxy en dev todas las
 *   peticiones comparten la clave `unknown`, limitacion documentada.
 * - `correlationId` lo propaga el middleware global de la app.
 * - Nunca se registra token, documento, email ni password; solo IDs.
 */

/** Sin proxy delante, la IP desconocida comparte bucket (documentado). */
const UNKNOWN_CLIENT = 'unknown';

export const NO_STORE_MIDDLEWARE = createMiddleware<{
  Variables: AppVariables;
}>(async (c, next) => {
  c.header(CACHE_CONTROL_HEADER, NO_STORE);
  await next();
});

export type PasswordResetRouteLimits = {
  forgotIpMax: number;
  forgotDocumentMax: number;
  forgotCooldownSeconds: number;
  resetIpMax: number;
  windowMs: number;
};

export type PasswordResetRouteDeps = {
  forgot: ForgotService;
  reset: ResetService;
  rateLimiter: RateLimiter;
  logger: PasswordResetLogger;
  limits: PasswordResetRouteLimits;
};

type RateLimitCheck = {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
};

/** Devuelve el primer check que rechaza, o `null` si todos permiten. */
const firstRateLimitFailure = (
  limiter: RateLimiter,
  checks: RateLimitCheck[],
): { scope: string; retryAfterSeconds: number } | null => {
  for (const check of checks) {
    const hit = limiter.hit(check.key, check.limit, check.windowMs);
    if (!hit.allowed) {
      return { scope: check.scope, retryAfterSeconds: hit.retryAfterSeconds };
    }
  }
  return null;
};

const clientIp = (forwardedFor: string | undefined): string => {
  if (forwardedFor === undefined || forwardedFor === '') return UNKNOWN_CLIENT;
  const first = forwardedFor.split(',')[0]?.trim();
  return first === undefined || first === '' ? UNKNOWN_CLIENT : first;
};

export const makePasswordResetRoute = (
  deps: PasswordResetRouteDeps,
): Hono<{ Variables: AppVariables }> => {
  const route = new Hono<{ Variables: AppVariables }>();

  route.post(
    '/auth/password/forgot',
    NO_STORE_MIDDLEWARE,
    zValidator('json', ForgotPasswordSchema),
    async (c) => {
      const correlationId = c.get('correlationId');
      const body = c.req.valid('json');
      const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));
      const documentKey = `${body.documentType}:${body.documentNumber}`;

      const failure = firstRateLimitFailure(deps.rateLimiter, [
        {
          scope: 'forgot:ip',
          key: `forgot:ip:${ip}`,
          limit: deps.limits.forgotIpMax,
          windowMs: deps.limits.windowMs,
        },
        {
          scope: 'forgot:document',
          key: `forgot:document:${documentKey}`,
          limit: deps.limits.forgotDocumentMax,
          windowMs: deps.limits.windowMs,
        },
        {
          scope: 'forgot:cooldown',
          key: `forgot:cooldown:${documentKey}`,
          limit: 1,
          windowMs: deps.limits.forgotCooldownSeconds * MS_PER_SECOND,
        },
      ]);
      if (failure !== null) {
        deps.logger.warn(LogEvent.PASSWORD_RESET_RATE_LIMITED, {
          scope: failure.scope,
          correlationId,
        });
        c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
        throw rateLimitedError(correlationId);
      }

      await deps
        .forgot(
          {
            documentType: body.documentType,
            documentNumber: body.documentNumber,
          },
          correlationId,
        )
        .catch((err: unknown) => {
          if (err instanceof AppError) throw err;
          throw internalError(correlationId, err);
        });

      // Respuesta identica exista o no la cuenta (anti-enumeracion).
      return ok(c, {});
    },
  );

  route.post(
    '/auth/password/reset',
    NO_STORE_MIDDLEWARE,
    zValidator('json', ResetPasswordSchema),
    async (c) => {
      const correlationId = c.get('correlationId');
      const body = c.req.valid('json');
      const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));

      const failure = firstRateLimitFailure(deps.rateLimiter, [
        {
          scope: 'reset:ip',
          key: `reset:ip:${ip}`,
          limit: deps.limits.resetIpMax,
          windowMs: deps.limits.windowMs,
        },
      ]);
      if (failure !== null) {
        deps.logger.warn(LogEvent.PASSWORD_RESET_RATE_LIMITED, {
          scope: failure.scope,
          correlationId,
        });
        c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
        throw rateLimitedError(correlationId);
      }

      await deps
        .reset({ token: body.token, password: body.password }, correlationId)
        .catch((err: unknown) => {
          if (err instanceof AppError) throw err;
          throw internalError(correlationId, err);
        });

      return ok(c, {});
    },
  );

  return route;
};
