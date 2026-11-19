import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import {
	AppError,
	internalError,
	invalidCredentials,
	rateLimitedError,
} from "../../shared/errors.js";
import { FORWARDED_FOR_HEADER } from "../../shared/headers.js";
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
	AccountLogger,
	AccountReader,
	ChangePasswordService,
	EmailChangeService,
} from "./account.port.js";
import { ChangeEmailSchema, ChangePasswordSchema } from "./account.schema.js";

/**
 * `POST /auth/password/change` (autenticado con `requireAuth`, montado en `app.ts`).
 *
 * - 200 `{data:{}}` (sobre comun). `Cache-Control: no-store`.
 * - Rate limiting por IP y bloqueo temporal por usuario (5 intentos / 10 min):
 *   al superarlo, 429 con `Retry-After` + `RateLimit-*` (aviso al usuario).
 *   El contador cubre intentos totales, no solo fallidos.
 * - `userId` y familia salen del JWT, nunca del body.
 * - Nunca se registra contraseña ni PII; solo IDs. No publica eventos.
 */
export type AccountRouteLimits = {
	changeIpMax: number;
	emailIpMax: number;
	userMaxAttempts: number;
	lockoutWindowMs: number;
	windowMs: number;
};

export type ChangePasswordRouteDeps = {
	changePassword: ChangePasswordService;
	rateLimiter: RateLimiter;
	logger: AccountLogger;
	limits: AccountRouteLimits;
};

export const makeChangePasswordRoute = (
	deps: ChangePasswordRouteDeps,
): Hono<{ Variables: AppVariables }> => {
	const route = new Hono<{ Variables: AppVariables }>();

	route.post(
		"/auth/password/change",
		noStoreMiddleware,
		zValidator("json", ChangePasswordSchema, validationErrorHook),
		async (c) => {
			const correlationId = c.get("correlationId");
			const body = c.req.valid("json");
			const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));
			const userId = c.get("userId");
			if (userId === undefined) throw internalError(correlationId);

			const failure = firstRateLimitFailure(deps.rateLimiter, [
				{
					scope: "changepassword:ip",
					key: `changepassword:ip:${ip}`,
					limit: deps.limits.changeIpMax,
					windowMs: deps.limits.windowMs,
				},
				{
					scope: "changepassword:user",
					key: `changepassword:user:${userId}`,
					limit: deps.limits.userMaxAttempts,
					windowMs: deps.limits.lockoutWindowMs,
				},
			]);
			if (failure !== null) {
				deps.logger.warn(LogEvent.ACCOUNT_RATE_LIMITED, {
					scope: failure.scope,
					limit: String(failure.limit),
					correlationId,
				});
				setRateLimitHeaders((name, value) => c.header(name, value), failure);
				throw rateLimitedError(correlationId);
			}

			await deps
				.changePassword(
					{
						currentPassword: body.currentPassword,
						newPassword: body.newPassword,
					},
					userId,
					c.get("sessionFamilyId"),
					correlationId,
				)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			return ok(c, {});
		},
	);

	return route;
};

export type ChangeEmailRouteDeps = {
	changeEmail: EmailChangeService;
	rateLimiter: RateLimiter;
	logger: AccountLogger;
	limits: AccountRouteLimits;
	/** Aviso async al relay tras escribir en outbox. Opcional. */
	onOutboxWrite?: (() => void) | undefined;
};

/**
 * `POST /auth/email/change` (autenticado con `requireAuth`, montado en `app.ts`).
 *
 * - 200 `{data:{changed}}` inmediato: `changed:false` si el correo ya era el
 *   mismo (idempotente, sin escribir ni evento); `changed:true` si se actualizo.
 * - Correo ocupado: 409 generico, sin revelar nada.
 * - Rate limiting por IP y bloqueo temporal por usuario (igual que
 *   contraseña, claves propias `changeemail:*`) con `Retry-After` + `RateLimit-*`.
 * - `userId` sale del JWT, nunca del body. Publica `EmailChanged` via
 *   outbox en la misma transaccion. `Cache-Control: no-store`.
 * - Nunca se registran emails ni secretos; solo IDs.
 */
export const makeChangeEmailRoute = (
	deps: ChangeEmailRouteDeps,
): Hono<{ Variables: AppVariables }> => {
	const route = new Hono<{ Variables: AppVariables }>();

	route.post(
		"/auth/email/change",
		noStoreMiddleware,
		zValidator("json", ChangeEmailSchema, validationErrorHook),
		async (c) => {
			const correlationId = c.get("correlationId");
			const body = c.req.valid("json");
			const ip = clientIp(c.req.header(FORWARDED_FOR_HEADER));
			const userId = c.get("userId");
			if (userId === undefined) throw internalError(correlationId);

			const failure = firstRateLimitFailure(deps.rateLimiter, [
				{
					scope: "changeemail:ip",
					key: `changeemail:ip:${ip}`,
					limit: deps.limits.emailIpMax,
					windowMs: deps.limits.windowMs,
				},
				{
					scope: "changeemail:user",
					key: `changeemail:user:${userId}`,
					limit: deps.limits.userMaxAttempts,
					windowMs: deps.limits.lockoutWindowMs,
				},
			]);
			if (failure !== null) {
				deps.logger.warn(LogEvent.ACCOUNT_RATE_LIMITED, {
					scope: failure.scope,
					limit: String(failure.limit),
					correlationId,
				});
				setRateLimitHeaders((name, value) => c.header(name, value), failure);
				throw rateLimitedError(correlationId);
			}

			const result = await deps
				.changeEmail(
					{
						newEmail: body.newEmail,
						currentPassword: body.currentPassword,
					},
					userId,
					correlationId,
				)
				.catch((err: unknown) => {
					if (err instanceof AppError) throw err;
					throw internalError(correlationId, err);
				});

			// Solo avisa si hubo escritura (changed:true genera evento).
			if (result.changed) deps.onOutboxWrite?.();

			return ok(c, { changed: result.changed });
		},
	);

	return route;
};

export type MeRouteDeps = {
	users: AccountReader;
	logger: AccountLogger;
};

/**
 * `GET /auth/me` (autenticado con `requireAuth`, montado en `app.ts`).
 *
 * - Devuelve la identidad minima para la UI sin invadir `Profile`:
 *   `{data:{userId, firstName, email}}` (email propio, ya autenticado).
 * - `Cache-Control: no-store`. 401 generico si el usuario ya no existe.
 * - Logs: solo el fallo (`me.failed`, warn con `userId`+`correlationId`).
 *   El exito no se loguea aqui (el request logger ya deja `http.request 200`).
 * - El `userId` sale del JWT (`sub`); `Profile` sigue siendo dueño del perfil
 *   completo. El frontend NO debe decodificar el JWT para esto: usa este endpoint.
 */
export const makeMeRoute = (
	deps: MeRouteDeps,
): Hono<{ Variables: AppVariables }> => {
	const route = new Hono<{ Variables: AppVariables }>();

	route.get("/auth/me", noStoreMiddleware, async (c) => {
		const correlationId = c.get("correlationId");
		const userId = c.get("userId");
		if (userId === undefined) throw internalError(correlationId);

		const account = await deps.users.findAccountById(userId).catch(() => null);
		if (account === null) {
			deps.logger.warn(LogEvent.ME_FAILED, { userId, correlationId });
			throw invalidCredentials(correlationId);
		}

		return ok(c, {
			userId: account.id,
			firstName: account.firstName,
			email: account.email,
		});
	});

	return route;
};
