import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../http.js";
import { LogEvent } from "../log-events.js";

/**
 * Logger minimo para el acceso HTTP (una linea por request).
 *
 * - `info`: 2xx. `warn`: 4xx (incluye 429 y validaciones). `error`: 5xx.
 *   Sin `error` inyectado (tests) los 5xx caen a `warn` para no exigir
 *   cambiar todos los fakes: en produccion se inyecta Winston con `error`.
 * - Campos: `method`, `route`, `status`, `latencyMs`, `correlationId` y
 *   `userId` cuando `requireAuth` ya lo fijo. Nunca body, query, headers
 *   de auth, tokens ni PII.
 * - `GET /health` no se registra (ruido del healthcheck).
 */
export type RequestLogWriter = {
	info(event: string, fields: Record<string, string>): void;
	warn(event: string, fields: Record<string, string>): void;
	error?(event: string, fields: Record<string, string>): void;
};

const asFields = (fields: {
	method: string;
	route: string;
	status: string;
	latencyMs: string;
	correlationId: string;
	userId?: string;
}): Record<string, string> => {
	const out: Record<string, string> = {
		method: fields.method,
		route: fields.route,
		status: fields.status,
		latencyMs: fields.latencyMs,
		correlationId: fields.correlationId,
	};
	if (fields.userId !== undefined) out.userId = fields.userId;
	return out;
};

export const makeRequestLogger = (
	logger: RequestLogWriter,
): ReturnType<typeof createMiddleware<{ Variables: AppVariables }>> => {
	return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
		if (c.req.path === "/health") {
			await next();
			return;
		}
		const start = Date.now();
		const correlationId = c.get("correlationId") ?? "unknown";
		try {
			await next();
		} catch (err) {
			const latencyMs = String(Date.now() - start);
			const fields = asFields({
				method: c.req.method,
				route: c.req.path,
				status: "500",
				latencyMs,
				correlationId,
			});
			if (logger.error !== undefined)
				logger.error(LogEvent.HTTP_REQUEST, fields);
			else logger.warn(LogEvent.HTTP_REQUEST, fields);
			throw err;
		}
		const status = c.res?.status ?? 500;
		const latencyMs = String(Date.now() - start);
		const userId = c.get("userId");
		const fields = asFields({
			method: c.req.method,
			route: c.req.path,
			status: String(status),
			latencyMs,
			correlationId,
			...(userId !== undefined ? { userId } : {}),
		});
		if (status >= 500) {
			if (logger.error !== undefined)
				logger.error(LogEvent.HTTP_REQUEST, fields);
			else logger.warn(LogEvent.HTTP_REQUEST, fields);
		} else if (status >= 400) {
			logger.warn(LogEvent.HTTP_REQUEST, fields);
		} else {
			logger.info(LogEvent.HTTP_REQUEST, fields);
		}
	});
};
