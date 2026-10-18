import { LoginLimits } from './login.limits.js';

/**
 * Limite de intentos de login en memoria (version simple acordada).
 *
 * - Por IP de origen, ventana deslizante de `ATTEMPT_WINDOW_MS`.
 * - Solo cuenta fallos de credenciales; un login correcto limpia la IP.
 * - `now` inyectable para pruebas deterministas.
 * - Limitacion conocida: sin proxy de confianza todas las IPs pueden verse
 *   como una (`unknown`); en produccion conviene delegar a gateway/WAF.
 */

export type RateLimiter = {
  isBlocked(ip: string): boolean;
  registerFailure(ip: string): void;
  reset(ip: string): void;
};

export type RateLimiterOptions = {
  maxAttempts?: number;
  windowMs?: number;
  now?: () => number;
};

export const createLoginRateLimiter = (
  options: RateLimiterOptions = {},
): RateLimiter => {
  const maxAttempts = options.maxAttempts ?? LoginLimits.MAX_ATTEMPTS;
  const windowMs = options.windowMs ?? LoginLimits.ATTEMPT_WINDOW_MS;
  const now = options.now ?? Date.now;
  const attempts = new Map<string, { count: number; windowStart: number }>();

  return {
    isBlocked(ip) {
      const entry = attempts.get(ip);
      if (entry === undefined) return false;
      if (now() - entry.windowStart >= windowMs) {
        attempts.delete(ip);
        return false;
      }
      return entry.count >= maxAttempts;
    },
    registerFailure(ip) {
      const current = now();
      const entry = attempts.get(ip);
      if (entry === undefined || current - entry.windowStart >= windowMs) {
        attempts.set(ip, { count: 1, windowStart: current });
        return;
      }
      attempts.set(ip, {
        count: entry.count + 1,
        windowStart: entry.windowStart,
      });
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
};
