import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import {
	AppError,
	internalError,
	rateLimitedError,
} from "../../shared/errors.js";
import {
	FORWARDED_FOR_HEADER,
	RETRY_AFTER_HEADER,
} from "../../shared/headers.js";
import { type AppVariables, ok } from "../../shared/http.js";
import { LogEvent } from "../../shared/log-events.js";
import { noStoreMiddleware } from "../../shared/middleware/no-store.js";
import {
	clientIp,
	firstRateLimitFailure,
} from "../../shared/ratelimit/rate-limit-http.js";
import type { RateLimiter } from "../../shared/ratelimit/ratelimit.port.js";
import type {
	LoginLogger,
	LoginService,
	LogoutService,
	RefreshService,
} from "./login.port.js";
import { LoginSchema, LogoutSchema, RefreshSchema } from "./login.schema.js";

/**
 * `POST /auth/login`, `POST /auth/refresh` y `POST /auth/logout`.
 *
 * Seguridad:
 * - Responden con `Cache-Control: no-store` (los tokens no deben quedar en
 *   caches): Authentication solo devuelve los tokens; el BFF los guarda y el
 *   navegador conserva unicamente la cookie de sesion.
 * - Error UNICO `401 UNAUTHORIZED` generico en login y refresh, sin
 *   distinguir el motivo (anti-enumeracion). Logout responde siempre 200.
 *   Los errores de forma (Zod) son `400` aparte.
 * - Rate limiting por IP (las tres) y por documento (login). La IP sale de
 *   `X-Forwarded-For`; sin proxy en dev todas las peticiones comparten la
 *   clave `unknown` (misma limitacion documentada que en `passwordreset`).
 * - `correlationId` lo propaga el middleware global de la app.
 * - Nunca se registra contrasena, token ni documento; solo IDs.
 * - Ninguna publica eventos.
 */

export type LoginRouteLimits = {
	loginIpMax: number;
	loginDocumentMax: number;
	refreshIpMax: number;
	logoutIpMax: number;
	windowMs: number;
};

export type LoginRouteDeps = {
	login: LoginService;
	refresh: RefreshService;
	logout: LogoutService;
	rateLimiter: RateLimiter;
	logger: LoginLogger;
	limits: LoginRouteLimits;
};

export const makeLoginRoute = (
	deps: LoginRouteDeps,
): Hono<{ Variables: AppVariables }> => {
	const route = new Hono<{ Variables: AppVariables }>();

	route.post(
		"/auth/login",
		noStoreMiddleware,
		zValidator("json", LoginSchema),
		async (c) => {
			const correlationId = c.get("correlationId");
			const body = c.req.valid("json");
			const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));
			const documentKey = `${body.documentType}:${body.documentNumber}`;

			const failure = firstRateLimitFailure(deps.rateLimiter, [
				{
					scope: "login:ip",
					key: `login:ip:${ip}`,
					limit: deps.limits.loginIpMax,
					windowMs: deps.limits.windowMs,
				},
				{
					scope: "login:document",
					key: `login:document:${documentKey}`,
					limit: deps.limits.loginDocumentMax,
					windowMs: deps.limits.windowMs,
				},
			]);
			if (failure !== null) {
				deps.logger.warn(LogEvent.LOGIN_RATE_LIMITED, {
					scope: failure.scope,
					correlationId,
				});
				c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
				throw rateLimitedError(correlationId);
			}

			const result = await deps
				.login(
					{
						documentType: body.documentType,
						documentNumber: body.documentNumber,
						password: body.password,
					},
					correlationId,
				)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			return ok(c, {
				accessToken: result.accessToken,
				refreshToken: result.refreshToken,
				expiresIn: result.expiresIn,
			});
		},
	);

	route.post(
		"/auth/refresh",
		noStoreMiddleware,
		zValidator("json", RefreshSchema),
		async (c) => {
			const correlationId = c.get("correlationId");
			const body = c.req.valid("json");
			const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));

			const failure = firstRateLimitFailure(deps.rateLimiter, [
				{
					scope: "refresh:ip",
					key: `refresh:ip:${ip}`,
					limit: deps.limits.refreshIpMax,
					windowMs: deps.limits.windowMs,
				},
			]);
			if (failure !== null) {
				deps.logger.warn(LogEvent.LOGIN_RATE_LIMITED, {
					scope: failure.scope,
					correlationId,
				});
				c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
				throw rateLimitedError(correlationId);
			}

			const result = await deps
				.refresh({ refreshToken: body.refreshToken }, correlationId)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			return ok(c, {
				accessToken: result.accessToken,
				refreshToken: result.refreshToken,
				expiresIn: result.expiresIn,
			});
		},
	);

	route.post(
		"/auth/logout",
		noStoreMiddleware,
		zValidator("json", LogoutSchema),
		async (c) => {
			const correlationId = c.get("correlationId");
			const body = c.req.valid("json");
			const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));

			const failure = firstRateLimitFailure(deps.rateLimiter, [
				{
					scope: "logout:ip",
					key: `logout:ip:${ip}`,
					limit: deps.limits.logoutIpMax,
					windowMs: deps.limits.windowMs,
				},
			]);
			if (failure !== null) {
				deps.logger.warn(LogEvent.LOGIN_RATE_LIMITED, {
					scope: failure.scope,
					correlationId,
				});
				c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
				throw rateLimitedError(correlationId);
			}

			// Siempre 200 (idempotente): con token desconocido no hace nada.
			await deps
				.logout({ refreshToken: body.refreshToken }, correlationId)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			return ok(c, {});
		},
	);

	return route;
};
