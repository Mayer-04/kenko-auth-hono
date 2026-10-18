import { buildApp } from './app.js';
import { buildContainer } from './container.js';
import { LogEvent } from './shared/log-events.js';

/**
 * Entrada del API. Falla rapido si el env es invalido o la DB configurada
 * no responde (sin fallback silencioso a otra base).
 */
const container = buildContainer();
const app = buildApp({
  registerService: container.registerService,
  loginService: container.loginService,
  refreshService: container.refreshService,
  logoutService: container.logoutService,
  rateLimiter: container.rateLimiter,
  cookieSecure: container.cookieSecure,
});

const port = container.env.PORT;

// Verificacion temprana de DB: un `select 1` antes de escuchar.
try {
  await container.dbClient.sql`SELECT 1`.catch((err: unknown) => {
    throw err;
  });
  container.logger.info(LogEvent.SERVER_STARTING, { port });
} catch (err) {
  container.logger.error(LogEvent.DATABASE_UNREACHABLE, {
    error: err instanceof Error ? err.message : 'unknown',
  });
  process.exit(1);
}

export default {
  port,
  fetch: app.fetch,
};
