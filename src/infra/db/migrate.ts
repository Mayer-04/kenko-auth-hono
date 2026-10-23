/**
 * Aplica migraciones con el driver nativo de Bun.
 *
 * `drizzle-kit migrate` exige `pg`/`postgres`, que no usamos (Drizzle va
 * sobre `bun:sql`). Este runner usa `drizzle-orm/bun-sql/migrator`.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { loadEnv, resolveDatabase } from "../../config/env.js";

const env = loadEnv();
const database = resolveDatabase(env);

const sanitizeUrl = (url: string): string => {
	const parsed = new URL(url);
	parsed.searchParams.delete("connect_timeout");
	return parsed.toString();
};

const sql = new SQL(sanitizeUrl(database.url));
const db = drizzle({ client: sql });

await migrate(db, { migrationsFolder: "./src/infra/db/migrations" });
console.log("Migrations applied");
sql.close();
