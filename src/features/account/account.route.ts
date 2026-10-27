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
import { validationErrorHook } from "../../shared/validation.js";
import type {
	AccountLogger,
	ChangePasswordService,
	EmailChangeService,
} from "./account.port.js";
import { ChangeEmailSchema, ChangePasswordSchema } from "./account.schema.js";

/**
 * `POST /auth/password/change` (autenticado con `requireAuth`, montado en `app.ts`).
 *
 * - 204 sin cuerpo. `Cache-Control: no-store`.
 * - Rate limiting por IP y bloqueo temporal por usuario (5 intentos / 10 min):
 *   al superarlo, 429 con `Retry-After` (aviso al usuario). El contador cubre
 *   intentos totales, no solo fallidos.
 * - `userId` y familia salen del JWT, nunca del body.
 * - Nunca se registra contrasena ni PII; solo IDs. No publica eventos.
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
					correlationId,
				});
				c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
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

			return c.body(null, 204);
		},
	);

	return route;
};

export type ChangeEmailRouteDeps = {
	changeEmail: EmailChangeService;
	rateLimiter: RateLimiter;
	logger: AccountLogger;
	limits: AccountRouteLimits;
};

/**
 * `POST /auth/email/change` (autenticado con `requireAuth`, montado en `app.ts`).
 *
 * - 200 `{data:{}}` inmediato: el cambio es directo, sin pendientes ni
 *   tokens. Mismo correo (normalizado): 200 idempotente sin escribir.
 * - Correo ocupado: 409 generico, sin revelar nada.
 * - Rate limiting por IP y bloqueo temporal por usuario (igual que
 *   contrasena, claves propias `changeemail:*`).
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
					correlationId,
				});
				c.header(RETRY_AFTER_HEADER, String(failure.retryAfterSeconds));
				throw rateLimitedError(correlationId);
			}

			await deps
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

			return ok(c, {});
		},
	);

	return route;
};
