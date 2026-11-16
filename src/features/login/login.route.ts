import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
	buildClearRefreshCookie,
	buildRefreshCookie,
	refreshTokenFromCookie,
} from "../../shared/cookies.js";
import {
	AppError,
	internalError,
	rateLimitedError,
} from "../../shared/errors.js";
import {
	FORWARDED_FOR_HEADER,
	SET_COOKIE_HEADER,
} from "../../shared/headers.js";
import { type AppVariables, ok } from "../../shared/http.js";
import { LogEvent } from "../../shared/log-events.js";
import { noStoreMiddleware } from "../../shared/middleware/no-store.js";
import {
	clientIp,
	firstRateLimitFailure,
	setRateLimitHeaders,
} from "../../shared/ratelimit/rate-limit-http.js";
import type { RateLimiter } from "../../shared/ratelimit/ratelimit.port.js";
import { validationErrorHook } from "../../shared/validation.js";
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
 *   caches). El JSON con tokens se mantiene por compatibilidad, pero ademas
 *   se fija la cookie httpOnly `kenko_refresh` para que el frontend no guarde
 *   el refresh en `localStorage` (flujo recomendado 2026). `refresh`/`logout`
 *   aceptan el token por BODY (prioridad) o por cookie; nunca por URL.
 * - Error UNICO `401 UNAUTHORIZED` generico en login y refresh, sin
 *   distinguir el motivo (anti-enumeracion). Logout responde siempre 200.
 *   Los errores de forma (Zod) son `400` aparte; si falta el token en body
 *   y en cookie se preserva el 400 original.
 * - Rate limiting por IP (las tres) y por documento (login) con `Retry-After`
 *   + `RateLimit-*` en 429. La IP sale de `X-Forwarded-For`; sin proxy en dev
 *   todas las peticiones comparten la clave `unknown`.
 * - `correlationId` lo propaga el middleware global de la app.
 * - Nunca se registra contraseña, token ni documento; solo IDs.
 * - Ninguna publica eventos.
 *
 * Claims del access token (documentados para el frontend, no para decodificar
 * a mano): `sub` (userId), `sid` (familia de sesion), `iss`, `aud`, `exp`,
 * `iat`, `jti`. El frontend debe usar `GET /auth/me` para datos de UI en vez
 * de decodificar el JWT.
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

/**
 * Token para `refresh`/`logout`: BODY (prioridad) o cookie httpOnly.
 * Si falta en ambos se preserva el 400 original (no 401): el contrato de
 * forma no cambia, solo se añade la fuente alternativa.
 */
const resolveRefreshToken = (
	bodyToken: string | undefined,
	cookieHeader: string | undefined,
	correlationId: string,
): string => {
	const refreshToken = bodyToken ?? refreshTokenFromCookie(cookieHeader);
	if (refreshToken === undefined || refreshToken === "") {
		throw new AppError("VALIDATION_ERROR", "Credenciales inválidas.", {
			correlationId,
		});
	}
	return refreshToken;
};

const forwardedProtoOf = (c: {
	req: { header(name: string): string | undefined };
}) => c.req.header("X-Forwarded-Proto");

export const makeLoginRoute = (
	deps: LoginRouteDeps,
): Hono<{ Variables: AppVariables }> => {
	const route = new Hono<{ Variables: AppVariables }>();

	route.post(
		"/auth/login",
		noStoreMiddleware,
		zValidator("json", LoginSchema, validationErrorHook),
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
					limit: String(failure.limit),
					correlationId,
				});
				setRateLimitHeaders((name, value) => c.header(name, value), failure);
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

			c.header(
				SET_COOKIE_HEADER,
				buildRefreshCookie(result.refreshToken, c.req.url, forwardedProtoOf(c)),
			);
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
		zValidator("json", RefreshSchema, validationErrorHook),
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
					limit: String(failure.limit),
					correlationId,
				});
				setRateLimitHeaders((name, value) => c.header(name, value), failure);
				throw rateLimitedError(correlationId);
			}

			const refreshToken = resolveRefreshToken(
				body.refreshToken,
				c.req.header("Cookie"),
				correlationId,
			);

			const result = await deps
				.refresh({ refreshToken }, correlationId)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			c.header(
				SET_COOKIE_HEADER,
				buildRefreshCookie(result.refreshToken, c.req.url, forwardedProtoOf(c)),
			);
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
		zValidator("json", LogoutSchema, validationErrorHook),
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
					limit: String(failure.limit),
					correlationId,
				});
				setRateLimitHeaders((name, value) => c.header(name, value), failure);
				throw rateLimitedError(correlationId);
			}

			const refreshToken = resolveRefreshToken(
				body.refreshToken,
				c.req.header("Cookie"),
				correlationId,
			);

			// Siempre 200 (idempotente): con token desconocido no hace nada.
			await deps
				.logout({ refreshToken }, correlationId)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			c.header(
				SET_COOKIE_HEADER,
				buildClearRefreshCookie(c.req.url, forwardedProtoOf(c)),
			);
			return ok(c, {});
		},
	);

	return route;
};
