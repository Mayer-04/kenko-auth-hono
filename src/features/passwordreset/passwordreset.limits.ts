/**
 * Limites y constantes de `passwordreset`.
 *
 * Separados del esquema para nombrar cada numero con su intencion.
 * Decisiones confirmadas (etapa 1): TTL 30 min (D4), token de 32 bytes
 * CSPRNG = 256 bits, rate limiting en aplicacion por IP y documento (D5).
 */

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

export const PasswordResetLimits = {
	/** Duracion del token de restablecimiento (D4: 30 minutos). */
	TOKEN_TTL_MINUTES: 30,
	/** Bytes aleatorios del token: 32 = 256 bits (CSPRNG). */
	TOKEN_RANDOM_BYTES: 32,
	/** Solicitudes `forgot` por IP en la ventana. */
	FORGOT_IP_MAX_REQUESTS: 10,
	/** Solicitudes `forgot` por documento en la ventana (email bombing). */
	FORGOT_DOCUMENT_MAX_REQUESTS: 3,
	/** Enfriamiento minimo entre solicitudes para el mismo documento. */
	FORGOT_DOCUMENT_COOLDOWN_SECONDS: 60,
	/** Solicitudes `reset` por IP en la ventana (fuerza bruta de token). */
	RESET_IP_MAX_REQUESTS: 10,
	/** Ventana del contador deslizante fijo. */
	RATE_WINDOW_MINUTES: 15,
	/** Tope de buckets en memoria; al superarlo se purgan los expirados. */
	RATE_BUCKETS_MAX: 10000,
} as const;

export type PasswordResetLimitsConfig = {
	forgotIpMax: number;
	forgotDocumentMax: number;
	forgotCooldownSeconds: number;
	resetIpMax: number;
	windowMs: number;
};
