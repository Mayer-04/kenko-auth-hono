/**
 * Estados HTTP usados por el servicio.
 *
 * Objeto `as const` (compatible con `erasableSyntaxOnly`: sin `enum`) para
 * no dispersar numeros magicos en rutas y manejadores.
 */
export const HttpStatus = {
	OK: 200,
	CREATED: 201,
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	CONFLICT: 409,
	PAYLOAD_TOO_LARGE: 413,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_ERROR: 500,
	SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];
