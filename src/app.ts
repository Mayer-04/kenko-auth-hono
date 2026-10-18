import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';

import {
  type LoginService,
  type LogoutService,
  makeLoginRoutes,
  type RefreshService,
} from './features/login/index.js';
import type { RateLimiter } from './features/login/login.rate-limit.js';
import { makeRegisterRoute } from './features/register/index.js';
import type { RegisterService } from './features/register/register.port.js';
import {
  type AppVariables,
  errorHandler,
  notFoundHandler,
} from './shared/http.js';
import { HttpStatus } from './shared/http-status.js';
import { correlationMiddleware } from './shared/middleware/correlation.js';
import { REQUEST_BODY_LIMIT_BYTES } from './shared/request-limits.js';

export type AppDeps = {
  registerService: RegisterService;
  loginService: LoginService;
  refreshService: RefreshService;
  logoutService: LogoutService;
  rateLimiter: RateLimiter;
  cookieSecure: boolean;
};

/**
 * App Hono. `features/` nunca importa `infra/`: las rutas llegan ya
 * construidas desde `container.ts`.
 */
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
              code: 'VALIDATION_ERROR',
              message: 'Cuerpo demasiado grande.',
            },
          },
          HttpStatus.PAYLOAD_TOO_LARGE,
        ),
    }),
  );

  // Propaga correlationId (ver `shared/middleware/correlation.ts`).
  app.use(correlationMiddleware);

  app.get('/health', (c) => c.json({ data: { status: 'ok' } }));

  const register = makeRegisterRoute(deps.registerService);
  app.route('/', register);

  const login = makeLoginRoutes({
    loginService: deps.loginService,
    refreshService: deps.refreshService,
    logoutService: deps.logoutService,
    rateLimiter: deps.rateLimiter,
    cookieSecure: deps.cookieSecure,
  });
  app.route('/', login);

  app.notFound((c) => notFoundHandler(c));
  app.onError((err, c) => errorHandler(err, c));

  return app;
};
