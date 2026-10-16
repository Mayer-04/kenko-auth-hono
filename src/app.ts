import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';

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

/**
 * App Hono. `features/` nunca importa `infra/`: las rutas llegan ya
 * construidas desde `container.ts`.
 */
export const buildApp = (
  registerService: RegisterService,
): Hono<{ Variables: AppVariables }> => {
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

  const register = makeRegisterRoute(registerService);
  app.route('/', register);

  app.notFound((c) => notFoundHandler(c));
  app.onError((err, c) => errorHandler(err, c));

  return app;
};
