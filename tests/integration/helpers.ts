import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { type AppDeps, buildApp } from "../../src/app.js";
import {
	MS_PER_MINUTE,
	PasswordResetLimits,
} from "../../src/features/passwordreset/passwordreset.limits.js";
import type { PasswordResetRouteLimits } from "../../src/features/passwordreset/passwordreset.route.js";
import {
	makeForgotPasswordService,
	makeResetPasswordService,
} from "../../src/features/passwordreset/passwordreset.service.js";
import { makeRegisterService } from "../../src/features/register/register.service.js";
import type { DbClient } from "../../src/infra/db/client.js";
import { makePasswordResetRepository } from "../../src/infra/db/repositories/password-reset.repository.js";
import { makeUserRepository } from "../../src/infra/db/repositories/user.repository.js";
import { makeArgon2Hasher } from "../../src/infra/password/argon2-hasher.js";
import { makeInMemoryRateLimiter } from "../../src/infra/ratelimit/in-memory-rate-limiter.js";
import { makeResetTokenTool } from "../../src/infra/security/reset-token.js";
import { newId } from "../../src/shared/ids.js";

/**
 * Constructor de la app para pruebas de integracion.
 *
 * Reutiliza el ensamblaje real (servicios + repos + hasher + token tool) sin
 * tocar AWS: la outbox se escribe en la base local y el relay no corre.
 * Los limites de rate limiting son inyectables para no interferir con las
 * pruebas; el logger captura los IDs registrados para verificar que no haya
 * PII ni tokens en los logs.
 */

export type CapturedLog = {
	level: string;
	event: string;
	ids: Record<string, string>;
};

export const makeCapturingLogger = (): {
	logger: AppDeps["routeLogger"];
	entries: CapturedLog[];
} => {
	const entries: CapturedLog[] = [];
	return {
		entries,
		logger: {
			info: (event, ids) => {
				entries.push({ level: "info", event, ids });
			},
			warn: (event, ids) => {
				entries.push({ level: "warn", event, ids });
			},
		},
	};
};

/** Limites generosos para no interferir con las pruebas. */
export const TEST_ROUTE_LIMITS: PasswordResetRouteLimits = {
	forgotIpMax: 1000,
	forgotDocumentMax: 1000,
	forgotCooldownSeconds: 0,
	resetIpMax: 1000,
	windowMs: 60 * MS_PER_MINUTE,
};

export const buildTestApp = (
	sql: SQL,
	overrides: {
		limits?: PasswordResetRouteLimits;
		newEventId?: () => string;
		baseUrl?: string;
	} = {},
): {
	app: ReturnType<typeof buildApp>;
	captured: CapturedLog[];
} => {
	const client: DbClient = {
		db: drizzle({ client: sql }),
		sql,
		close: () => {},
	};
	const hasher = makeArgon2Hasher();
	const users = makeUserRepository(client);
	const passwordResets = makePasswordResetRepository(client);
	const tokenTool = makeResetTokenTool(PasswordResetLimits.TOKEN_RANDOM_BYTES);

	const { logger, entries } = makeCapturingLogger();

	const registerService = makeRegisterService({
		users,
		hasher,
		newUserId: () => newId(),
		newEventId: () => newId(),
		nowIso: () => new Date().toISOString(),
	});

	const forgotService = makeForgotPasswordService({
		users: passwordResets,
		tokens: passwordResets,
		tokenTool,
		newTokenId: () => newId(),
		newEventId: overrides.newEventId ?? (() => newId()),
		now: () => new Date(),
		ttlMinutes: PasswordResetLimits.TOKEN_TTL_MINUTES,
		baseUrl: overrides.baseUrl ?? "http://localhost:8080",
		logger,
	});

	const resetService = makeResetPasswordService({
		users: passwordResets,
		tokens: passwordResets,
		hasher,
		tokenTool,
		logger,
	});

	const deps: AppDeps = {
		registerService,
		forgotService,
		resetService,
		rateLimiter: makeInMemoryRateLimiter({
			bucketsMax: PasswordResetLimits.RATE_BUCKETS_MAX,
		}),
		routeLogger: logger,
		routeLimits: overrides.limits ?? TEST_ROUTE_LIMITS,
	};

	return { app: buildApp(deps), captured: entries };
};
