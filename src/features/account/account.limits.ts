/**
 * Limites y constantes de `account` (cambio de contrasena y de email).
 *
 * Bloqueo temporal (decision confirmada): 5 intentos por usuario cada
 * 10 minutos; al 6.º la respuesta es 429 con `Retry-After` (~10 min).
 * El contador cubre intentos totales (no solo fallidos): cambiar de
 * contrasena 5 veces en 10 minutos es patologico y tambien se frena.
 */

export const AccountLimits = {
	/** Solicitudes de cambio por IP en la ventana (abuso). */
	CHANGE_IP_MAX_REQUESTS: 20,
	/** Solicitudes de cambio de email por IP en la ventana. */
	EMAIL_IP_MAX_REQUESTS: 20,
	/** Intentos por usuario en la ventana de bloqueo (incluye exitos). */
	USER_MAX_ATTEMPTS: 5,
	/** Ventana de conteo y duracion aproximada del bloqueo. */
	LOCKOUT_WINDOW_MINUTES: 10,
	/** Ventana del limite por IP. */
	RATE_WINDOW_MINUTES: 15,
} as const;
