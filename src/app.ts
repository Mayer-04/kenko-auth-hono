import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
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
import {
	type AppVariables,
	errorHandler,
	notFoundHandler,
} from "./shared/http.js";
import { HttpStatus } from "./shared/http-status.js";
import { correlationMiddleware } from "./shared/middleware/correlation.js";
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
	forgotService: ForgotService;
	resetService: ResetService;
	rateLimiter: RateLimiter;
	routeLogger: PasswordResetLogger;
	routeLimits: PasswordResetRouteLimits;
	loginRouteLimits: LoginRouteLimits;
};

export const buildApp = (deps: AppDeps): Hono<{ Variables: AppVariables }> => {
	const app = new Hono<{ Variables: AppVariables }>();

	app.use(secureHeaders());
	app.use(
		bodyLimit({
			maxSize: REQUEST_BODY_LIMIT_BYTES,
			onError: (c) =>
				c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "Cuerpo demasiado grande.",
						},
					},
					HttpStatus.PAYLOAD_TOO_LARGE,
				),
		}),
	);

	// Propaga correlationId (ver `shared/middleware/correlation.ts`).
	app.use(correlationMiddleware);

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

	app.notFound((c) => notFoundHandler(c));
	app.onError((err, c) => errorHandler(err, c));

	return app;
};
