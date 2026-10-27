import type { SQL } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../../src/app.js";
import { loadEnv, resolveDatabase } from "../../src/config/env.js";
import { createDb } from "../../src/infra/db/client.js";
import { outbox, users } from "../../src/infra/db/schema/index.js";
import { makeArgon2Hasher } from "../../src/infra/password/argon2-hasher.js";
import { buildTestApp } from "./helpers.js";

/**
 * Integracion `POST /auth/register` contra PostgreSQL local.
 * No toca AWS: verifica usuario + outbox atomicos, 409 generico y 400.
 */
describe("POST /auth/register", () => {
	let sql: SQL;
	let close: () => void;
	let app: ReturnType<typeof buildApp>;
	const hasher = makeArgon2Hasher();
	const createdUserIds: string[] = [];

	const uniqueEmail = () =>
		`it.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
	const uniqueDoc = () =>
		String(Math.floor(1000000000 + Math.random() * 9000000000));

	beforeAll(() => {
		const env = loadEnv();
		const database = resolveDatabase(env);
		const client = createDb(database.url);
		sql = client.sql;
		close = client.close;
		app = buildTestApp(client.sql).app;
	});

	afterAll(async () => {
		if (createdUserIds.length > 0) {
			const db = drizzle({ client: sql });
			for (const id of createdUserIds) {
				await db.delete(outbox).where(eq(outbox.aggregateId, id));
				await db.delete(users).where(eq(users.id, id));
			}
		}
		close();
	});

	const validBody = () => {
		return {
			firstName: "Maria Fernanda",
			lastName: "Gomez Rojas",
			birthDate: "1995-03-21",
			gender: "female",
			email: uniqueEmail(),
			phone: "+573001234567",
			addressLine: "Cra 15 # 93-60 Apto 402",
			city: "Bogota",
			documentType: "CC",
			documentNumber: uniqueDoc(),
			password: "correcta-segura-99",
			confirmPassword: "correcta-segura-99",
		};
	};

	it("201 crea usuario y deja evento pendiente en outbox", async () => {
		const body = validBody();
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(res.status).toBe(201);
		expect(res.headers.get("X-Correlation-Id")).toBeTruthy();
		const json = (await res.json()) as { data: { userId: string } };
		expect(json.data.userId).toBeTruthy();
		createdUserIds.push(json.data.userId);

		// La respuesta no filtra password.
		expect(JSON.stringify(json)).not.toContain("correcta-segura-99");

		const db = drizzle({ client: sql });
		const rows = await db
			.select()
			.from(users)
			.where(eq(users.id, json.data.userId))
			.limit(1);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (row === undefined) throw new Error("usuario no encontrado");
		expect(row.email).toBe(body.email.toLowerCase());
		expect(row.emailVerified).toBe(false);
		expect(await hasher.verify(row.passwordHash, body.password)).toBe(true);

		const events = await db
			.select()
			.from(outbox)
			.where(eq(outbox.aggregateId, json.data.userId));
		expect(events).toHaveLength(1);
		expect(events[0]?.status).toBe("pending");
		expect(events[0]?.eventType).toBe("UserRegistered");
		const payload = events[0]?.payload as {
			data: { contact: { email: string } };
		};
		expect(payload.data.contact.email).toBe(body.email.toLowerCase());
		expect(JSON.stringify(payload)).not.toContain("correcta-segura-99");
	});

	it("duplicado responde 409 generico sin distinguir campo", async () => {
		const body = validBody();
		const first = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(first.status).toBe(201);
		const firstJson = (await first.json()) as { data: { userId: string } };
		createdUserIds.push(firstJson.data.userId);

		const second = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(second.status).toBe(409);
		const err = (await second.json()) as {
			error: { code: string; message: string };
		};
		expect(err.error.code).toBe("REGISTER_CONFLICT");
		expect(err.error.message).toBe("No se pudo completar el registro.");
	});

	it("entrada invalida responde 400", async () => {
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...validBody(),
				email: "no-es-email",
				confirmPassword: "otra",
			}),
		});
		expect(res.status).toBe(400);
		// Sobre comun de errores (no el formato crudo del validador).
		const json = (await res.json()) as {
			error?: { code: string; message: string; correlationId: string };
			success?: boolean;
		};
		expect(json.success).toBeUndefined();
		expect(json.error?.code).toBe("VALIDATION_ERROR");
		expect(typeof json.error?.message).toBe("string");
		expect(typeof json.error?.correlationId).toBe("string");
	});
});
