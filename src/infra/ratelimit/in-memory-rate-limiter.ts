import { MS_PER_SECOND } from "../../features/passwordreset/passwordreset.limits.js";
import type {
	RateLimiter,
	RateLimitHit,
} from "../../shared/ratelimit/ratelimit.port.js";

/**
 * Rate limiter en memoria (ventana fija por bucket).
 *
 * - Un bucket por clave: contador + instante en el que vuelve a estar
 *   disponible. Consumo O(1); la limpieza es oportunista al superar
 *   `bucketsMax` entradas, para acotar el uso de memoria.
 * - Sin dependencias externas. No persiste: ver `ratelimit.port.ts` para
 *   las limitaciones documentadas y el plan de produccion.
 * - Las claves pueden contener la IP o el documento del usuario: solo viven
 *   en memoria y NUNCA se registran en logs.
 */

type Bucket = { count: number; resetAt: number };

export const makeInMemoryRateLimiter = (options: {
	bucketsMax: number;
	now?: () => number;
}): RateLimiter => {
	const buckets = new Map<string, Bucket>();
	const now = options.now ?? Date.now;

	const purgeExpired = (current: number): void => {
		for (const [key, bucket] of buckets) {
			if (bucket.resetAt <= current) buckets.delete(key);
		}
	};

	return {
		hit(key: string, limit: number, windowMs: number): RateLimitHit {
			const current = now();
			if (buckets.size >= options.bucketsMax) purgeExpired(current);

			const bucket = buckets.get(key);
			if (bucket === undefined || bucket.resetAt <= current) {
				buckets.set(key, { count: 1, resetAt: current + windowMs });
				return { allowed: true };
			}
			if (bucket.count >= limit) {
				return {
					allowed: false,
					retryAfterSeconds: Math.ceil(
						(bucket.resetAt - current) / MS_PER_SECOND,
					),
				};
			}
			bucket.count += 1;
			return { allowed: true };
		},
	};
};
