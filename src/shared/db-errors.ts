/**
 * Clasificacion de errores de Postgres sin acoplar a Drizzle.
 *
 * `isUniqueViolation` detecta el 23505 (UNIQUE) tanto si el driver lo
 * expone en `err.code` como anidado en `err.cause.code`. Los servicios
 * lo usan para mapear carreras de unicidad al error generico
 * anti-enumeracion que corresponda (409 de registro o de actualizacion).
 */
export const isUniqueViolation = (err: unknown): boolean => {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: unknown }).code;
	if (code === "23505") return true;
	const cause = (err as { cause?: unknown }).cause;
	return (
		typeof cause === "object" &&
		cause !== null &&
		(cause as { code?: unknown }).code === "23505"
	);
};
