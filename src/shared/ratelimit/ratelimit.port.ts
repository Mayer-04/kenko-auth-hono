/**
 * Puerto de rate limiting.
 *
 * Decision D5 (confirmada): limitacion EN APLICACION, en memoria, por IP y
 * por documento, con enfriamiento. Ventaja: sin dependencias externas y
 * funciona en dev local. Limitacion documentada: el estado no se comparte
 * entre instancias ni sobrevive reinicios; en produccion debe complementarse
 * con una regla de WAF/API Gateway por IP (fuera del alcance de este repo).
 *
 * El puerto permite sustituir la implementacion (p. ej. Redis) sin tocar
 * los casos de uso ni las rutas.
 */

export type RateLimitHit =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number };

export type RateLimiter = {
	/**
	 * Incrementa el contador de `key` y evalua el limite fijo en la ventana.
	 * Debe ser atomico dentro del proceso.
	 */
	hit(key: string, limit: number, windowMs: number): RateLimitHit;
};
