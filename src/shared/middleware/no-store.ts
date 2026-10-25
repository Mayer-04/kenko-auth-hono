import { createMiddleware } from "hono/factory";

import { CACHE_CONTROL_HEADER, NO_STORE } from "../headers.js";
import type { AppVariables } from "../http.js";

/**
 * `Cache-Control: no-store` para respuestas con material sensible
 * (tokens). Compartido por `passwordreset` y `login`: un solo lugar para
 * la politica "nada de sesiones/tokens queda en caches".
 */
export const noStoreMiddleware = createMiddleware<{
	Variables: AppVariables;
}>(async (c, next) => {
	c.header(CACHE_CONTROL_HEADER, NO_STORE);
	await next();
});
