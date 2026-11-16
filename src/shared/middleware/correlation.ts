import { createMiddleware } from "hono/factory";

import { CORRELATION_ID_HEADER } from "../headers.js";
import type { AppVariables } from "../http.js";
import { resolveCorrelationId } from "../ids.js";

/**
 * Propaga `correlationId`: reutiliza `X-Correlation-Id` si es UUID valido,
 * si no genera UUID v7. El valor viaja en respuesta para soporte
 * ("codigo de referencia") sin exponer PII.
 */
export const correlationMiddleware = createMiddleware<{
	Variables: AppVariables;
}>(async (c, next) => {
	const correlationId = resolveCorrelationId(
		c.req.header(CORRELATION_ID_HEADER),
	);
	c.set("correlationId", correlationId);
	c.header(CORRELATION_ID_HEADER, correlationId);
	await next();
});
