import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  AppError,
  internalError,
  invalidCredentials,
  tooManyAttempts,
} from '../../shared/errors.js';
import { CORRELATION_ID_HEADER } from '../../shared/headers.js';
import { type AppContext, type AppVariables, ok } from '../../shared/http.js';
import { isUuid, newId } from '../../shared/ids.js';
import { LoginLimits } from './login.limits.js';
import type { RateLimiter } from './login.rate-limit.js';
import { LoginSchema } from './login.schema.js';
import type { LoginService } from './login.service.js';
import type { LoginResult } from './login.types.js';
import type { LogoutService } from './logout.service.js';
import type { RefreshService } from './refresh.service.js';

export type LoginRouteDeps = {
  loginService: LoginService;
  refreshService: RefreshService;
  logoutService: LogoutService;
  rateLimiter: RateLimiter;
  /** `true` en produccion (HTTPS): la cookie exige canal seguro. */
  cookieSecure: boolean;
};

/**
 * Rutas de sesion: `POST /auth/login`, `POST /auth/refresh`,
 * `POST /auth/logout`.
 *
 * Transporte acordado: el access token viaja en el cuerpo JSON (el
 * frontend lo guarda en memoria y lo envia como `Authorization: Bearer` a
 * los consumidores); el refresh viaja solo en cookie `HttpOnly`
 * (`SameSite=Lax`, `Path=/auth`). `Lax` bloquea el envio en peticiones
 * cruzadas tipo fetch/form, que es la mitigacion CSRF para esta API sin
 * `GET` autenticados por cookie. Pendiente: si el frontend queda en otro
 * sitio (cross-site), evaluar `SameSite=None` (exige `Secure`).
 */
export const makeLoginRoutes = (
  deps: LoginRouteDeps,
): Hono<{ Variables: AppVariables }> => {
  const route = new Hono<{ Variables: AppVariables }>();

  route.post('/auth/login', zValidator('json', LoginSchema), async (c) => {
    const correlationId = takeCorrelation(c);
    const ip = clientIp(c);
    if (deps.rateLimiter.isBlocked(ip)) {
      throw tooManyAttempts(correlationId);
    }

    const body = c.req.valid('json');
    let result: LoginResult;
    try {
      result = await deps.loginService(
        {
          documentType: body.documentType,
          documentNumber: body.documentNumber,
          password: body.password,
        },
        correlationId,
      );
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'UNAUTHORIZED') {
        deps.rateLimiter.registerFailure(ip);
        throw err;
      }
      throw internalError(correlationId, err);
    }
    deps.rateLimiter.reset(ip);

    setRefreshCookie(c, result.refreshToken, deps.cookieSecure);
    return ok(c, {
      accessToken: result.accessToken,
      expiresIn: result.accessTokenExpiresInSec,
      user: result.identity,
    });
  });

  route.post('/auth/refresh', async (c) => {
    const correlationId = takeCorrelation(c);
    const token = getCookie(c, LoginLimits.REFRESH_COOKIE_NAME);
    if (token === undefined || token === '') {
      throw invalidCredentials(correlationId);
    }

    const result = await deps
      .refreshService(token, correlationId)
      .catch((err: unknown) => {
        if (err instanceof AppError) throw err;
        throw internalError(correlationId, err);
      });

    setRefreshCookie(c, result.refreshToken, deps.cookieSecure);
    return ok(c, {
      accessToken: result.accessToken,
      expiresIn: result.accessTokenExpiresInSec,
      user: result.identity,
    });
  });

  route.post('/auth/logout', async (c) => {
    const correlationId = takeCorrelation(c);
    const token = getCookie(c, LoginLimits.REFRESH_COOKIE_NAME);
    await deps.logoutService(token).catch((err: unknown) => {
      throw internalError(correlationId, err);
    });

    deleteCookie(c, LoginLimits.REFRESH_COOKIE_NAME, {
      path: LoginLimits.REFRESH_COOKIE_PATH,
      sameSite: 'Lax',
      secure: deps.cookieSecure,
    });
    return c.newResponse(null, 204);
  });

  return route;
};

/** Igual que en `register.route.ts`: reutiliza o genera `correlationId`. */
const takeCorrelation = (c: AppContext): string => {
  const header = c.req.header(CORRELATION_ID_HEADER);
  const correlationId =
    header !== undefined && isUuid(header) ? header : newId();
  c.set('correlationId', correlationId);
  c.header(CORRELATION_ID_HEADER, correlationId);
  return correlationId;
};

/** Primera IP de `X-Forwarded-For`, o `unknown` en llamada directa/test. */
const clientIp = (c: AppContext): string => {
  const forwarded = c.req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : 'unknown';
};

const setRefreshCookie = (
  c: AppContext,
  token: string,
  secure: boolean,
): void => {
  setCookie(c, LoginLimits.REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: LoginLimits.REFRESH_COOKIE_PATH,
    maxAge: LoginLimits.REFRESH_TOKEN_TTL_SEC,
  });
};
