/**
 * Parametros Argon2id (recomendacion inicial OWASP Password Storage).
 *
 * Equilibran seguridad y coste para dev; en prod se ajustan por constructor
 * de `makeArgon2Hasher()` sin tocar este modulo.
 */
export const ARGON2_MEMORY_COST_KIB = 19456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;
