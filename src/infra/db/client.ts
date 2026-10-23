import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

/**
 * Cliente Drizzle sobre el SQL nativo de Bun.
 *
 * Hallazgo verificado en dev: `POSTGRES_URL` con `?connect_timeout=...`
 * hace que `postgres:18` rechace la conexion ("unrecognized configuration
 * parameter"). Se elimina ese parametro aqui sin tocar el `.env`.
 * Politica confirmada: sin fallback silencioso; si la base configurada
 * no responde, se falla y se reporta.
 */

const sanitizeUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		parsed.searchParams.delete("connect_timeout");
		return parsed.toString();
	} catch {
		return url;
	}
};

export type DbClient = {
	db: ReturnType<typeof drizzle>;
	sql: SQL;
	close: () => void;
};

export const createDb = (url: string): DbClient => {
	const sql = new SQL(sanitizeUrl(url));
	const db = drizzle({ client: sql });
	return { db, sql, close: () => void sql.close() };
};
