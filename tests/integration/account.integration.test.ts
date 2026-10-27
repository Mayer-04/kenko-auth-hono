import type { SQL } from "bun";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../../src/app.js";
import { loadEnv, resolveDatabase } from "../../src/config/env.js";
import { createDb } from "../../src/infra/db/client.js";
import {
	outbox,
	refreshSessions,
	users,
} from "../../src/infra/db/schema/index.js";
import { buildTestApp } from "./helpers.js";

/**
 * Integracion de `POST /auth/password/change` contra PostgreSQL local.
 * No toca AWS: verifica hash nuevo, revocacion selectiva de sesiones,
 * invalidacion de resets pendientes, 401/400/429 y el bloqueo temporal.
 */
describe("POST /auth/password/change", () => {
	let sql: SQL;
	let close: () => void;
	let app: ReturnType<typeof buildApp>;
	const createdUserIds: string[] = [];

	const uniqueEmail = () =>
		`changepw.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
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
				await db.delete(refreshSessions).where(eq(refreshSessions.userId, id));
				await db.delete(outbox).where(eq(outbox.aggregateId, id));
				await db.delete(users).where(eq(users.id, id));
			}
		}
		close();
	});

	const registerUser = async (password = "clave-actual-99") => {
		const documentNumber = uniqueDoc();
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				firstName: "Maria Fernanda",
				lastName: "Gomez Rojas",
				birthDate: "1995-03-21",
				gender: "female",
				email: uniqueEmail(),
				phone: "+573001234567",
				addressLine: "Cra 15 # 93-60 Apto 402",
				city: "Bogota",
				documentType: "CC",
				documentNumber,
				password,
				confirmPassword: password,
			}),
		});
		expect(res.status).toBe(201);
		const json = (await res.json()) as { data: { userId: string } };
		createdUserIds.push(json.data.userId);
		return { documentNumber, password, userId: json.data.userId };
	};

	const login = async (documentNumber: string, password: string) => {
		const res = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: "CC",
				documentNumber,
				password,
			}),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as {
			data: { accessToken: string; refreshToken: string; expiresIn: number };
		};
	};

	const change = (
		accessToken: string | undefined,
		body: unknown,
		extraHeaders: Record<string, string> = {},
	) =>
		app.request("/auth/password/change", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(accessToken !== undefined
					? { Authorization: `Bearer ${accessToken}` }
					: {}),
				...extraHeaders,
			},
			body: JSON.stringify(body),
		});

	it("204: cambia el hash, revoca otras familias y conserva la actual", async () => {
		const user = await registerUser();
		const first = await login(user.documentNumber, user.password);
		// Segunda familia (otro dispositivo).
		const second = await login(user.documentNumber, user.password);

		const res = await change(first.data.accessToken, {
			currentPassword: user.password,
			newPassword: "nueva-clave-00",
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Cache-Control")).toBe("no-store");

		// Vieja ya no entra; nueva si.
		const oldLogin = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: "CC",
				documentNumber: user.documentNumber,
				password: user.password,
			}),
		});
		expect(oldLogin.status).toBe(401);
		const newLogin = await login(user.documentNumber, "nueva-clave-00");
		expect(newLogin.data.expiresIn).toBe(900);

		// Otra familia revocada; la actual sigue rotando.
		const db = drizzle({ client: sql });
		const other = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: second.data.refreshToken }),
		});
		expect(other.status).toBe(401);
		const kept = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: first.data.refreshToken }),
		});
		expect(kept.status).toBe(200);
		const rows = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		expect(rows.filter((r) => r.status === "revoked").length).toBeGreaterThan(
			0,
		);
	});

	it("invalida los tokens de restablecimiento pendientes", async () => {
		const user = await registerUser();
		const tokens = await login(user.documentNumber, user.password);

		const forgotRes = await app.request("/auth/password/forgot", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Forwarded-For": "10.8.8.8",
			},
			body: JSON.stringify({
				documentType: "CC",
				documentNumber: user.documentNumber,
			}),
		});
		expect(forgotRes.status).toBe(200);

		const changed = await change(tokens.data.accessToken, {
			currentPassword: user.password,
			newPassword: "otra-clave-11",
		});
		expect(changed.status).toBe(204);
	});

	it("sin token o con token invalido: 401 generico", async () => {
		const noAuth = await change(undefined, {
			currentPassword: "clave-actual-99",
			newPassword: "nueva-clave-00",
		});
		expect(noAuth.status).toBe(401);
		const malformed = await app.request("/auth/password/change", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Token abc",
			},
			body: JSON.stringify({
				currentPassword: "clave-actual-99",
				newPassword: "nueva-clave-00",
			}),
		});
		expect(malformed.status).toBe(401);
		const tampered = await app.request("/auth/password/change", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer abc.def.ghi",
			},
			body: JSON.stringify({
				currentPassword: "clave-actual-99",
				newPassword: "nueva-clave-00",
			}),
		});
		expect(tampered.status).toBe(401);
	});

	it("actual incorrecta: 401 especifico; misma o con datos: 400", async () => {
		const user = await registerUser();
		const tokens = await login(user.documentNumber, user.password);

		const wrong = await change(tokens.data.accessToken, {
			currentPassword: "otra-clave",
			newPassword: "nueva-clave-00",
		});
		expect(wrong.status).toBe(401);
		const wrongJson = (await wrong.json()) as {
			error: { code: string; message: string };
		};
		expect(wrongJson.error.code).toBe("UNAUTHORIZED");
		expect(wrongJson.error.message).toBe("Contrasena actual incorrecta.");

		const same = await change(tokens.data.accessToken, {
			currentPassword: user.password,
			newPassword: user.password,
		});
		expect(same.status).toBe(400);

		const withEmail = await change(tokens.data.accessToken, {
			currentPassword: user.password,
			newPassword: "xxMaria Fernandaxx00",
		});
		expect(withEmail.status).toBe(400);
	});

	it("bloqueo temporal: tras 2 fallos, el intento valido da 429", async () => {
		const limited = buildTestApp(sql, {
			accountLimits: {
				changeIpMax: 1000,
				emailIpMax: 1000,
				userMaxAttempts: 2,
				lockoutWindowMs: 60000,
				windowMs: 60000,
			},
		}).app;
		const user = await registerUser();
		const tokens = await login(user.documentNumber, user.password);
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${tokens.data.accessToken}`,
		};
		const attempt = (currentPassword: string, fw = "10.7.7.7") =>
			limited.request("/auth/password/change", {
				method: "POST",
				headers: { ...headers, "X-Forwarded-For": fw },
				body: JSON.stringify({
					currentPassword,
					newPassword: "nueva-clave-00",
				}),
			});

		expect((await attempt("mala-1")).status).toBe(401);
		expect((await attempt("mala-2")).status).toBe(401);
		const blocked = await attempt(user.password);
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("Retry-After")).not.toBeNull();
	});
});

describe("POST /auth/email/change", () => {
	let sql: SQL;
	let close: () => void;
	let app: ReturnType<typeof buildApp>;
	const createdUserIds: string[] = [];

	const uniqueEmail = (prefix: string) =>
		`${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
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
				await db.delete(refreshSessions).where(eq(refreshSessions.userId, id));
				await db.delete(outbox).where(eq(outbox.aggregateId, id));
				await db.delete(users).where(eq(users.id, id));
			}
		}
		close();
	});

	const registerUser = async (email: string, password = "clave-actual-99") => {
		const documentNumber = uniqueDoc();
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				firstName: "Maria Fernanda",
				lastName: "Gomez Rojas",
				birthDate: "1995-03-21",
				gender: "female",
				email,
				phone: "+573001234567",
				addressLine: "Cra 15 # 93-60 Apto 402",
				city: "Bogota",
				documentType: "CC",
				documentNumber,
				password,
				confirmPassword: password,
			}),
		});
		expect(res.status).toBe(201);
		const json = (await res.json()) as { data: { userId: string } };
		createdUserIds.push(json.data.userId);
		return { documentNumber, password, userId: json.data.userId, email };
	};

	const login = async (documentNumber: string, password: string) => {
		const res = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: "CC",
				documentNumber,
				password,
			}),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as {
			data: { accessToken: string; refreshToken: string; expiresIn: number };
		};
	};

	const change = (
		accessToken: string | undefined,
		body: unknown,
		extraHeaders: Record<string, string> = {},
	) =>
		app.request("/auth/email/change", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(accessToken !== undefined
					? { Authorization: `Bearer ${accessToken}` }
					: {}),
				...extraHeaders,
			},
			body: JSON.stringify(body),
		});

	const latestEmailChangedOf = async (userId: string) => {
		const db = drizzle({ client: sql });
		const rows = await db
			.select()
			.from(outbox)
			.where(
				and(
					eq(outbox.aggregateId, userId),
					eq(outbox.eventType, "EmailChanged"),
				),
			)
			.orderBy(desc(outbox.createdAt))
			.limit(1);
		let payload: unknown = rows[0]?.payload;
		for (let i = 0; i < 3 && typeof payload === "string"; i += 1) {
			payload = JSON.parse(payload) as unknown;
		}
		return {
			count: rows.length,
			payload: payload as
				| {
						metadata: { eventId: string; correlationId: string };
						data: {
							userId: string;
							oldEmail: string;
							newEmail: string;
							firstName: string;
						};
				  }
				| undefined,
		};
	};

	it("200: actualiza el email y deja EmailChanged pendiente", async () => {
		const user = await registerUser(uniqueEmail("cambio"));
		const tokens = await login(user.documentNumber, user.password);
		const newEmail = uniqueEmail("nuevo");

		const res = await change(tokens.data.accessToken, {
			newEmail,
			currentPassword: user.password,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(await res.json()).toEqual({ data: {} });

		const db = drizzle({ client: sql });
		const rows = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, user.userId));
		expect(rows[0]?.email).toBe(newEmail);

		const { count, payload } = await latestEmailChangedOf(user.userId);
		expect(count).toBe(1);
		expect(payload?.data).toEqual({
			userId: user.userId,
			oldEmail: user.email,
			newEmail,
			firstName: "Maria Fernanda",
		});
		expect(payload?.metadata.correlationId).toBeDefined();

		// Las sesiones siguen intactas: el refresh funciona.
		const refresh = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: tokens.data.refreshToken }),
		});
		expect(refresh.status).toBe(200);
	});

	it("mismo correo (con otra caja/espacios): 200 sin escribir", async () => {
		const user = await registerUser(uniqueEmail("mismo"));
		const tokens = await login(user.documentNumber, user.password);

		const res = await change(tokens.data.accessToken, {
			newEmail: `  ${user.email.toUpperCase()} `,
			currentPassword: user.password,
		});
		expect(res.status).toBe(200);
		const { count } = await latestEmailChangedOf(user.userId);
		expect(count).toBe(0);
	});

	it("correo ocupado: 409 generico sin revelar nada", async () => {
		const first = await registerUser(uniqueEmail("primero"));
		const second = await registerUser(uniqueEmail("segundo"));
		const tokens = await login(first.documentNumber, first.password);

		const res = await change(tokens.data.accessToken, {
			newEmail: second.email,
			currentPassword: first.password,
		});
		expect(res.status).toBe(409);
		const json = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(json.error.code).toBe("UPDATE_CONFLICT");
		expect(json.error.message).toBe("No se pudo completar el cambio.");

		const db = drizzle({ client: sql });
		const rows = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, first.userId));
		expect(rows[0]?.email).toBe(first.email);
	});

	it("sin token o clave incorrecta: 401", async () => {
		const user = await registerUser(uniqueEmail("auth"));
		const tokens = await login(user.documentNumber, user.password);

		expect((await change(undefined, {})).status).toBe(401);
		const wrong = await change(tokens.data.accessToken, {
			newEmail: uniqueEmail("otro"),
			currentPassword: "mala",
		});
		expect(wrong.status).toBe(401);
	});
});
