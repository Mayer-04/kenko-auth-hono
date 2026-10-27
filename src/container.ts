import type winston from "winston";

import { loadEnv, resolveDatabase } from "./config/env.js";
import { initLogger } from "./config/logger.js";
import type {
	AccountRouteLimits,
	ChangePasswordService,
	EmailChangeService,
} from "./features/account/index.js";
import {
	AccountLimits,
	makeChangeEmailService,
	makeChangePasswordService,
} from "./features/account/index.js";
import type {
	LoginRouteLimits,
	LoginService,
	LogoutService,
	RefreshService,
} from "./features/login/index.js";
import {
	LoginLimits,
	makeLoginService,
	makeLogoutService,
	makeRefreshSessionService,
} from "./features/login/index.js";
import {
	MS_PER_MINUTE,
	makeForgotPasswordService,
	makeResetPasswordService,
	PasswordResetLimits,
} from "./features/passwordreset/index.js";
import type {
	ForgotService,
	PasswordResetLogger,
	ResetService,
} from "./features/passwordreset/passwordreset.port.js";
import type { PasswordResetRouteLimits } from "./features/passwordreset/passwordreset.route.js";
import { makeRegisterService } from "./features/register/index.js";
import type { RegisterService } from "./features/register/register.port.js";
import { createDb, type DbClient } from "./infra/db/client.js";
import { makePasswordResetRepository } from "./infra/db/repositories/password-reset.repository.js";
import { makeRefreshSessionRepository } from "./infra/db/repositories/refresh-session.repository.js";
import { makeUserRepository } from "./infra/db/repositories/user.repository.js";
import {
	createEventBridgeClient,
	resolveBusName,
} from "./infra/events/eventbridge-client.js";
import { makeArgon2Hasher } from "./infra/password/argon2-hasher.js";
import { makeInMemoryRateLimiter } from "./infra/ratelimit/in-memory-rate-limiter.js";
import { makeResetTokenTool } from "./infra/security/reset-token.js";
import { makeJwtSigner } from "./infra/token/jwt-signer.js";
import { makeRefreshTokenTool } from "./infra/token/refresh-token.js";
import { newId } from "./shared/ids.js";
import { LogEvent } from "./shared/log-events.js";
import { makeRequireAuth } from "./shared/middleware/require-auth.js";
import type { RateLimiter } from "./shared/ratelimit/ratelimit.port.js";

/**
 * Contenedor: unico lugar que conoce `infra/`.
 * Arma DB, repositorios, hasher, token tool, rate limiter y servicios.
 */
export type Container = {
	env: ReturnType<typeof loadEnv>;
	logger: winston.Logger;
	dbClient: DbClient;
	registerService: RegisterService;
	loginService: LoginService;
	refreshService: RefreshService;
	logoutService: LogoutService;
	changePasswordService: ChangePasswordService;
	changeEmailService: EmailChangeService;
	forgotService: ForgotService;
	resetService: ResetService;
	rateLimiter: RateLimiter;
	requireAuth: ReturnType<typeof makeRequireAuth>;
	routeLimits: PasswordResetRouteLimits;
	loginRouteLimits: LoginRouteLimits;
	accountRouteLimits: AccountRouteLimits;
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

	const jwtSigner = makeJwtSigner({
		secret: env.JWT_SECRET,
		issuer: env.JWT_ISSUER,
		audience: env.JWT_AUDIENCE,
		kid: LoginLimits.JWT_KID,
	});
	const refreshTokenTool = makeRefreshTokenTool(
		LoginLimits.REFRESH_RANDOM_BYTES,
	);
	const refreshSessions = makeRefreshSessionRepository(dbClient);

	const loginService = makeLoginService({
		users,
		sessions: refreshSessions,
		hasher,
		accessTokens: jwtSigner,
		refreshTokens: refreshTokenTool,
		newSessionId: () => newId(),
		newFamilyId: () => newId(),
		newJwtId: () => newId(),
		now: () => new Date(),
		accessTtlSeconds: LoginLimits.ACCESS_TTL_SECONDS,
		refreshTtlDays: LoginLimits.REFRESH_TTL_DAYS,
		logger: resetLogger,
	});

	const refreshService = makeRefreshSessionService({
		sessions: refreshSessions,
		accessTokens: jwtSigner,
		refreshTokens: refreshTokenTool,
		newSessionId: () => newId(),
		newJwtId: () => newId(),
		now: () => new Date(),
		accessTtlSeconds: LoginLimits.ACCESS_TTL_SECONDS,
		refreshTtlDays: LoginLimits.REFRESH_TTL_DAYS,
		logger: resetLogger,
	});

	const logoutService = makeLogoutService({
		sessions: refreshSessions,
		refreshTokens: refreshTokenTool,
		logger: resetLogger,
	});

	const changePasswordService = makeChangePasswordService({
		users,
		hasher,
		logger: resetLogger,
	});

	const changeEmailService = makeChangeEmailService({
		users,
		hasher,
		newEventId: () => newId(),
		nowIso: () => new Date().toISOString(),
		logger: resetLogger,
	});

	const requireAuth = makeRequireAuth(jwtSigner);

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

	const loginRouteLimits: LoginRouteLimits = {
		loginIpMax: LoginLimits.LOGIN_IP_MAX_REQUESTS,
		loginDocumentMax: LoginLimits.LOGIN_DOCUMENT_MAX_REQUESTS,
		refreshIpMax: LoginLimits.REFRESH_IP_MAX_REQUESTS,
		logoutIpMax: LoginLimits.LOGOUT_IP_MAX_REQUESTS,
		windowMs: LoginLimits.RATE_WINDOW_MINUTES * MS_PER_MINUTE,
	};

	const accountRouteLimits: AccountRouteLimits = {
		changeIpMax: AccountLimits.CHANGE_IP_MAX_REQUESTS,
		emailIpMax: AccountLimits.EMAIL_IP_MAX_REQUESTS,
		userMaxAttempts: AccountLimits.USER_MAX_ATTEMPTS,
		lockoutWindowMs: AccountLimits.LOCKOUT_WINDOW_MINUTES * MS_PER_MINUTE,
		windowMs: AccountLimits.RATE_WINDOW_MINUTES * MS_PER_MINUTE,
	};

	return {
		env,
		logger,
		dbClient,
		registerService,
		loginService,
		refreshService,
		logoutService,
		changePasswordService,
		changeEmailService,
		forgotService,
		resetService,
		rateLimiter,
		requireAuth,
		routeLimits,
		loginRouteLimits,
		accountRouteLimits,
		eventBusName: resolveBusName(env.EVENT_BUS_NAME),
	};
};
