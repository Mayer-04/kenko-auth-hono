/**
 * Constantes de la feature `login`.
 *
 * Decisiones confirmadas por el dueño: HS256, access 15 min, refresh 7 dias,
 * logout de una sola sesion y limite de intentos simple en memoria.
 * Los TTL viven aqui (no en env) para mantener minima la superficie de
 * configuracion; el secreto, emisor y audiencia si son env (`config/env.ts`).
 */
export const LoginLimits = {
  /** Duracion del access token en segundos (15 minutos). */
  ACCESS_TOKEN_TTL_SEC: 15 * 60,
  /** Duracion del refresh token en segundos (7 dias). */
  REFRESH_TOKEN_TTL_SEC: 7 * 24 * 60 * 60,
  /** Nombre de la cookie que transporta el refresh token. */
  REFRESH_COOKIE_NAME: 'kenko_refresh',
  /** Alcance de la cookie: solo las rutas de autenticacion la reciben. */
  REFRESH_COOKIE_PATH: '/auth',
  /** Intentos fallidos antes de bloquear temporalmente una IP. */
  MAX_ATTEMPTS: 5,
  /** Ventana del conteo de intentos fallidos (10 minutos). */
  ATTEMPT_WINDOW_MS: 10 * 60 * 1000,
  /** Contrasena maxima aceptada en login (igual que en registro). */
  PASSWORD_MAX_LENGTH: 128,
  /** Documento: mismos limites que en registro para aceptar lo registrado. */
  DOCUMENT_NUMBER_MIN_LENGTH: 4,
  DOCUMENT_NUMBER_MAX_LENGTH: 20,
  /** Dias que se conservan sesiones muertas antes de purgarlas. */
  SESSION_RETENTION_DAYS: 30,
  /** Cada cuanto el relay intenta la purga (24 horas). */
  SESSION_CLEANUP_INTERVAL_MS: 24 * 60 * 60 * 1000,
  /** Tope por lote del DELETE para no bloquear la tabla. */
  SESSION_CLEANUP_BATCH_LIMIT: 1000,
} as const;
