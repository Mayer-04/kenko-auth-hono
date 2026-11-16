/**
 * Configuración centralizada de CORS para el API HTTP.
 *
 * - Allowlist cerrada: solo orígenes explícitos (nunca `*`), porque se usan
 *   cookies (`kenko_refresh`) y `credentials: true` lo exige.
 * - Solo `http://localhost` / `http://127.0.0.1` en puertos de desarrollo.
 *   En producción se debe fijar `CORS_ORIGINS` con los dominios reales
 *   (https) y no depender de estos defaults.
 * - Sin trailing slash: `http://localhost:3000`, no `http://localhost:3000/`.
 */

const DEV_PORTS = [3000, 3001, 3100, 5000, 5500, 8000, 8080] as const;

const DEV_HOSTS = ["localhost", "127.0.0.1"] as const;

/** Defaults para desarrollo: cada puerto x cada host local. */
export const DEFAULT_CORS_ORIGINS: readonly string[] = DEV_PORTS.flatMap(
	(port) => DEV_HOSTS.map((host) => `http://${host}:${port}`),
);

/** Métodos que el API usa hoy (`GET`/`POST`) más preflight (`OPTIONS`). */
export const CORS_ALLOW_METHODS = ["GET", "POST", "OPTIONS"] as const;

/** Cabeceras que el frontend necesita enviar. */
export const CORS_ALLOW_HEADERS = [
	"Content-Type",
	"Authorization",
	"X-Correlation-Id",
] as const;

/**
 * Cabeceras que el frontend necesita leer con `fetch`:
 * correlación para soporte y `RateLimit-*`/`Retry-After` para countdown en 429.
 */
export const CORS_EXPOSE_HEADERS = [
	"X-Correlation-Id",
	"RateLimit-Limit",
	"RateLimit-Remaining",
	"RateLimit-Reset",
	"Retry-After",
] as const;

/** Segundos de caché del preflight (10 min: equilibra tráfico y cambios). */
export const CORS_MAX_AGE_SECONDS = 600;

/** Normaliza un origen para comparar (`trim` + sin `/` final). */
export const normalizeOrigin = (origin: string): string =>
	origin.trim().replace(/\/+$/, "");

/** Parsea `CORS_ORIGINS="https://a, https://b"` a lista deduplicada. */
export const parseCorsOrigins = (raw: string | undefined): string[] => {
	if (raw === undefined || raw.trim() === "") return [];
	return [
		...new Set(
			raw
				.split(",")
				.map(normalizeOrigin)
				.filter((o) => o !== ""),
		),
	];
};

/**
 * Resuelve la allowlist efectiva: `CORS_ORIGINS` si viene definida,
 * si no los defaults de desarrollo. Nunca devuelve `*`.
 */
export const resolveCorsOrigins = (
	corsOrigins: string | undefined,
): string[] => {
	const fromEnv = parseCorsOrigins(corsOrigins);
	return fromEnv.length > 0 ? fromEnv : [...DEFAULT_CORS_ORIGINS];
};

/** `true` solo si el `Origin` está en la allowlist (comparación exacta). */
export const isAllowedOrigin = (
	origin: string,
	allowed: readonly string[],
): boolean => allowed.includes(normalizeOrigin(origin));
