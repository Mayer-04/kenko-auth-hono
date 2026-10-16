/**
 * Politica del relay outbox -> EventBridge.
 *
 * Backoff ante rechazo de EventBridge: 5s, 30s, 5min y tope 1h.
 * `RELAY_INTERVAL_MS` es la encuesta del worker; `NORMALIZE_MAX_DEPTH`
 * limita cuantas capas de serializacion abre `normalizeDetail`.
 */
export const RELAY_BATCH_LIMIT = 10;
export const RELAY_INTERVAL_MS = 5000;
export const NORMALIZE_MAX_DEPTH = 3;

export const BACKOFF_FIRST_RETRY_SECONDS = 5;
export const BACKOFF_SECOND_RETRY_SECONDS = 30;
export const BACKOFF_THIRD_RETRY_SECONDS = 300;
export const BACKOFF_MAX_SECONDS = 3600;
