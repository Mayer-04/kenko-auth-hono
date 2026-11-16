/** Cabecera que propaga el identificador de correlacion. */
export const CORRELATION_ID_HEADER = "X-Correlation-Id";

/** Cabecera para fijar/limpiar la cookie de sesion. */
export const SET_COOKIE_HEADER = "Set-Cookie";

/** Cabeceras de politica de respuesta. */
export const CACHE_CONTROL_HEADER = "Cache-Control";
export const RETRY_AFTER_HEADER = "Retry-After";
export const FORWARDED_FOR_HEADER = "X-Forwarded-For";

/** Cabeceras estandar de rate limiting (IETF draft). */
export const RATELIMIT_LIMIT_HEADER = "RateLimit-Limit";
export const RATELIMIT_REMAINING_HEADER = "RateLimit-Remaining";
export const RATELIMIT_RESET_HEADER = "RateLimit-Reset";

/** Cookie httpOnly para el refresh token (flujo SPA sin localStorage). */
export const REFRESH_COOKIE_NAME = "kenko_refresh";
/** 7 dias en segundos (TTL del refresh token). */
export const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/** Valor `no-store`: impide que caches guarden respuestas con datos sensibles. */
export const NO_STORE = "no-store";
