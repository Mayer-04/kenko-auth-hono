/**
 * Limites y constantes de `login`.
 *
 * Separados del esquema para nombrar cada numero con su intencion.
 * Decisiones confirmadas (fase 3): access JWT HS256 de 15 minutos, refresh
 * opaco de 7 dias, `kid` fijo inicial para migrar a ES256 sin tocar el
 * servicio, rate limiting en aplicacion como en `passwordreset`.
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const LoginLimits = {
	/** Duracion del access token JWT (decision: 15 minutos). */
	ACCESS_TTL_SECONDS: 15 * 60,
	/** Duracion del refresh token opaco (decision: 7 dias). */
	REFRESH_TTL_DAYS: 7,
	/** Bytes aleatorios del refresh token: 32 = 256 bits (CSPRNG). */
	REFRESH_RANDOM_BYTES: 32,
	/** `kid` inicial del header JWT (rotacion futura sin tocar el servicio). */
	JWT_KID: "hs256-01",
	/** Longitud maxima de la contrasena al hacer login (igual que registro). */
	PASSWORD_MAX_LENGTH: 128,
	/** Solicitudes `login` por IP en la ventana (fuerza bruta). */
	LOGIN_IP_MAX_REQUESTS: 10,
	/** Solicitudes `login` por documento en la ventana (fuerza bruta). */
	LOGIN_DOCUMENT_MAX_REQUESTS: 5,
	/** Solicitudes `refresh` por IP en la ventana (robo de token). */
	REFRESH_IP_MAX_REQUESTS: 20,
	/** Solicitudes `logout` por IP en la ventana (abuso). */
	LOGOUT_IP_MAX_REQUESTS: 20,
	/** Ventana del contador deslizante fijo. */
	RATE_WINDOW_MINUTES: 15,
} as const;
