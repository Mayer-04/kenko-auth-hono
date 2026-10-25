import type { RateLimiter } from "./ratelimit.port.js";

/**
 * Ayudas HTTP para rate limiting en aplicacion (uso en rutas).
 *
 * Extraido de `passwordreset.route.ts` al anadir `login.route.ts` con la
 * misma logica: un solo lugar para la extraccion de IP y la evaluacion de
 * checks. Sin cambios de comportamiento; las claves de bucket siguen con
 * prefijo por feature (`forgot:`, `reset:`, `login:`, ...).
 */

/** Sin proxy delante, la IP desconocida comparte bucket (documentado). */
export const UNKNOWN_CLIENT = "unknown";

export type RateLimitCheck = {
	scope: string;
	key: string;
	limit: number;
	windowMs: number;
};

/** Devuelve el primer check que rechaza, o `null` si todos permiten. */
export const firstRateLimitFailure = (
	limiter: RateLimiter,
	checks: RateLimitCheck[],
): { scope: string; retryAfterSeconds: number } | null => {
	for (const check of checks) {
		const hit = limiter.hit(check.key, check.limit, check.windowMs);
		if (!hit.allowed) {
			return { scope: check.scope, retryAfterSeconds: hit.retryAfterSeconds };
		}
	}
	return null;
};

/** IP del cliente desde el valor de `X-Forwarded-For` (primera de la lista). */
export const clientIp = (forwardedFor: string | undefined): string => {
	if (forwardedFor === undefined || forwardedFor === "") return UNKNOWN_CLIENT;
	const first = forwardedFor.split(",")[0]?.trim();
	return first === undefined || first === "" ? UNKNOWN_CLIENT : first;
};
