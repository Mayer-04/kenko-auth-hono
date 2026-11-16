import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import {
	CORS_ALLOW_HEADERS,
	CORS_ALLOW_METHODS,
	CORS_EXPOSE_HEADERS,
	CORS_MAX_AGE_SECONDS,
	isAllowedOrigin,
} from "./config/cors.js";
import type {
	AccountReader,
	AccountRouteLimits,
	ChangePasswordService,
	EmailChangeService,
} from "./features/account/index.js";
import {
	makeChangeEmailRoute,
	makeChangePasswordRoute,
	makeMeRoute,
} from "./features/account/index.js";
import type {
	LoginRouteLimits,
	LoginService,
	LogoutService,
	RefreshService,
} from "./features/login/index.js";
import { makeLoginRoute } from "./features/login/index.js";
import { makePasswordResetRoute } from "./features/passwordreset/index.js";
import type {
	ForgotService,
	PasswordResetLogger,
	ResetService,
} from "./features/passwordreset/passwordreset.port.js";
import type { PasswordResetRouteLimits } from "./features/passwordreset/passwordreset.route.js";
import { makeRegisterRoute } from "./features/register/index.js";
import type { RegisterService } from "./features/register/register.port.js";
import { CORRELATION_ID_HEADER } from "./shared/headers.js";
import {
	type AppVariables,
	errorHandler,
	notFoundHandler,
} from "./shared/http.js";
import { HttpStatus } from "./shared/http-status.js";
import { resolveCorrelationId } from "./shared/ids.js";
import { correlationMiddleware } from "./shared/middleware/correlation.js";
import { makeRequestLogger } from "./shared/middleware/request-logger.js";
import type { makeRequireAuth } from "./shared/middleware/require-auth.js";
import type { RateLimiter } from "./shared/ratelimit/ratelimit.port.js";
import { REQUEST_BODY_LIMIT_BYTES } from "./shared/request-limits.js";

/**
 * App Hono. `features/` nunca importa `infra/`: las rutas llegan ya
 * construidas desde `container.ts`.
 */
export type AppDeps = {
	registerService: RegisterService;
	loginService: LoginService;
	refreshService: RefreshService;
	logoutService: LogoutService;
	changePasswordService: ChangePasswordService;
	changeEmailService: EmailChangeService;
	meReader: AccountReader;
	forgotService: ForgotService;
	resetService: ResetService;
	rateLimiter: RateLimiter;
	requireAuth: ReturnType<typeof makeRequireAuth>;
	routeLogger: PasswordResetLogger;
	routeLimits: PasswordResetRouteLimits;
	loginRouteLimits: LoginRouteLimits;
	accountRouteLimits: AccountRouteLimits;
	allowedOrigins: string[];
};

export const buildApp = (deps: AppDeps): Hono<{ Variables: AppVariables }> => {
	const app = new Hono<{ Variables: AppVariables }>();

	// CORS primero: debe responder el preflight OPTIONS antes de bodyLimit/auth.
	// Allowlist cerrada (sin `*`) porque se usa cookie httpOnly + credentials.
	app.use(
		cors({
			origin: (origin) =>
				typeof origin === "string" &&
				isAllowedOrigin(origin, deps.allowedOrigins)
					? origin
					: undefined,
			allowMethods: [...CORS_ALLOW_METHODS],
			allowHeaders: [...CORS_ALLOW_HEADERS],
			exposeHeaders: [...CORS_EXPOSE_HEADERS],
			maxAge: CORS_MAX_AGE_SECONDS,
			credentials: true,
		}),
	);

	app.use(secureHeaders());
	app.use(
		bodyLimit({
			maxSize: REQUEST_BODY_LIMIT_BYTES,
			onError: (c) => {
				const correlationId = resolveCorrelationId(
					c.req.header(CORRELATION_ID_HEADER),
				);
				c.header(CORRELATION_ID_HEADER, correlationId);
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "Cuerpo demasiado grande.",
							correlationId,
							details: [],
						},
					},
					HttpStatus.PAYLOAD_TOO_LARGE,
				);
			},
		}),
	);

	// Propaga correlationId y registra una linea de acceso por request
	// (ver `shared/middleware/request-logger.ts`). El request logger va
	// despues para tener `correlationId` disponible.
	app.use(correlationMiddleware);
	app.use(makeRequestLogger(deps.routeLogger));

	app.get("/health", (c) => c.json({ data: { status: "ok" } }));

	const register = makeRegisterRoute(deps.registerService);
	app.route("/", register);

	const login = makeLoginRoute({
		login: deps.loginService,
		refresh: deps.refreshService,
		logout: deps.logoutService,
		rateLimiter: deps.rateLimiter,
		logger: deps.routeLogger,
		limits: deps.loginRouteLimits,
	});
	app.route("/", login);

	const passwordReset = makePasswordResetRoute({
		forgot: deps.forgotService,
		reset: deps.resetService,
		rateLimiter: deps.rateLimiter,
		logger: deps.routeLogger,
		limits: deps.routeLimits,
	});
	app.route("/", passwordReset);

	// Rutas autenticadas: `requireAuth` corre despues del middleware de
	// correlacion y antes de la validacion del body.
	app.use("/auth/password/change", deps.requireAuth);
	app.use("/auth/email/change", deps.requireAuth);
	app.use("/auth/me", deps.requireAuth);
	const changePassword = makeChangePasswordRoute({
		changePassword: deps.changePasswordService,
		rateLimiter: deps.rateLimiter,
		logger: deps.routeLogger,
		limits: deps.accountRouteLimits,
	});
	app.route("/", changePassword);

	const changeEmail = makeChangeEmailRoute({
		changeEmail: deps.changeEmailService,
		rateLimiter: deps.rateLimiter,
		logger: deps.routeLogger,
		limits: deps.accountRouteLimits,
	});
	app.route("/", changeEmail);

	const me = makeMeRoute({ users: deps.meReader, logger: deps.routeLogger });
	app.route("/", me);

	app.notFound((c) => notFoundHandler(c));
	app.onError((err, c) => errorHandler(err, c));

	return app;
};
