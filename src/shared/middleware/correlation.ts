import { createMiddleware } from "hono/factory";

import { CORRELATION_ID_HEADER } from "../headers.js";
import type { AppVariables } from "../http.js";
import { newId } from "../ids.js";

/**
 * Propaga `correlationId`: reutiliza `X-Correlation-Id` o genera UUID v7.
 * Disponible en handlers via `c.get('correlationId')` y en la respuesta.
 * Patron `createMiddleware` de la skill `hono` (tipo `AppVariables` heredado).
 */
export const correlationMiddleware = createMiddleware<{
	Variables: AppVariables;
}>(async (c, next) => {
	const header = c.req.header(CORRELATION_ID_HEADER);
	const correlationId =
		header !== undefined && header !== "" ? header : newId();
	c.set("correlationId", correlationId);
	c.header(CORRELATION_ID_HEADER, correlationId);
	await next();
});
