import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../../src/app.js";
import { loadEnv, resolveDatabase } from "../../src/config/env.js";
import { LoginLimits } from "../../src/features/login/index.js";
import { createDb } from "../../src/infra/db/client.js";
import {
	outbox,
	refreshSessions,
	users,
} from "../../src/infra/db/schema/index.js";
import { makeJwtSigner } from "../../src/infra/token/jwt-signer.js";
import { buildTestApp } from "./helpers.js";

/**
 * Integracion de sesion (`/auth/login`, `/auth/refresh`, `/auth/logout`)
 * contra PostgreSQL local. No toca AWS: verifica tokens, rotacion, reuse
 * detection, revocacion y 401 generico.
 */
describe("sesion (login, refresh, logout)", () => {
	let sql: SQL;
	let close: () => void;
	let app: ReturnType<typeof buildApp>;
	const createdUserIds: string[] = [];

	const uniqueEmail = () =>
		`login.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
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

	const registerBody = () => ({
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
	});

	/** Registra por API y devuelve documento + contrasena + userId. */
	const registerUser = async (): Promise<{
		documentType: string;
		documentNumber: string;
		password: string;
		userId: string;
	}> => {
		const body = registerBody();
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(201);
		const json = (await res.json()) as { data: { userId: string } };
		createdUserIds.push(json.data.userId);
		return {
			documentType: body.documentType,
			documentNumber: body.documentNumber,
			password: body.password,
			userId: json.data.userId,
		};
	};

	it("200 con credenciales validas: tokens, no-store y sesion activa", async () => {
		const user = await registerUser();
		const res = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
				password: user.password,
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");

		const json = (await res.json()) as {
			data: { accessToken: string; refreshToken: string; expiresIn: number };
		};
		expect(json.data.expiresIn).toBe(LoginLimits.ACCESS_TTL_SECONDS);
		expect(json.data.accessToken.split(".")).toHaveLength(3);
		expect(json.data.refreshToken).not.toBe(json.data.accessToken);

		// El access es un JWT HS256 verificable con iss/aud del contrato.
		const verifier = makeJwtSigner({
			secret: "test-jwt-secret-con-al-menos-32-caracteres",
			issuer: "kenko-auth",
			audience: "kenko-api",
			kid: LoginLimits.JWT_KID,
		});
		const claims = await verifier.verifyAccessToken(json.data.accessToken);
		expect(claims.sub).toBe(user.userId);
		expect(claims.iss).toBe("kenko-auth");
		expect(claims.aud).toBe("kenko-api");
		expect(claims.exp - claims.iat).toBe(900);

		// Solo el hash del refresh en BD, sesion activa de una familia nueva.
		const db = drizzle({ client: sql });
		const rows = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("active");
		expect(rows[0]?.tokenHash).toBe(
			createHash("sha256").update(json.data.refreshToken).digest("hex"),
		);
		expect(rows[0]?.tokenHash).not.toContain(json.data.refreshToken);
	});

	it("401 generico con documento inexistente o contrasena incorrecta", async () => {
		const user = await registerUser();

		const unknown = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: "CC",
				documentNumber: "9999999999",
				password: user.password,
			}),
		});
		const wrong = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
				password: "otra-contrasena-00",
			}),
		});

		expect(unknown.status).toBe(401);
		expect(wrong.status).toBe(401);
		const unknownJson = (await unknown.json()) as {
			error: { code: string; message: string };
		};
		const wrongJson = (await wrong.json()) as {
			error: { code: string; message: string };
		};
		expect(unknownJson.error.code).toBe("UNAUTHORIZED");
		expect(wrongJson.error.code).toBe("UNAUTHORIZED");
		expect(unknownJson.error.message).toBe(wrongJson.error.message);
	});

	it("400 con cuerpo de forma invalida", async () => {
		const res = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ documentType: "XX" }),
		});
		expect(res.status).toBe(400);
		// Sobre comun de errores (no el formato crudo del validador).
		const json = (await res.json()) as {
			error?: { code: string; message: string; correlationId: string };
			success?: boolean;
		};
		expect(json.success).toBeUndefined();
		expect(json.error?.code).toBe("VALIDATION_ERROR");
		expect(typeof json.error?.correlationId).toBe("string");
	});

	it("429 al superar el limite por IP", async () => {
		const limited = buildTestApp(sql, {
			loginLimits: {
				loginIpMax: 2,
				loginDocumentMax: 100,
				refreshIpMax: 1000,
				logoutIpMax: 1000,
				windowMs: 60000,
			},
		}).app;
		const user = await registerUser();
		const body = {
			documentType: user.documentType,
			documentNumber: user.documentNumber,
			password: "incorrecta-00",
		};
		const headers = { "Content-Type": "application/json" };
		expect(
			(
				await limited.request("/auth/login", {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				})
			).status,
		).toBe(401);
		expect(
			(
				await limited.request("/auth/login", {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				})
			).status,
		).toBe(401);
		const third = await limited.request("/auth/login", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(third.status).toBe(429);
		expect(third.headers.get("Retry-After")).not.toBeNull();
	});

	it("reset de contrasena revoca las sesiones de refresh activas", async () => {
		const user = await registerUser();

		// Sesion activa tras el login.
		const loginRes = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
				password: user.password,
			}),
		});
		expect(loginRes.status).toBe(200);

		const db = drizzle({ client: sql });
		const before = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		expect(before).toHaveLength(1);
		expect(before[0]?.status).toBe("active");

		// Flujo forgot -> reset con contrasena nueva.
		const forgotRes = await app.request("/auth/password/forgot", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Forwarded-For": "10.9.9.9",
			},
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
			}),
		});
		expect(forgotRes.status).toBe(200);

		const rows = await db
			.select()
			.from(outbox)
			.where(
				and(
					eq(outbox.aggregateId, user.userId),
					eq(outbox.eventType, "PasswordResetRequested"),
				),
			)
			.orderBy(desc(outbox.createdAt))
			.limit(1);
		let payload: unknown = rows[0]?.payload;
		for (let i = 0; i < 3 && typeof payload === "string"; i += 1) {
			payload = JSON.parse(payload) as unknown;
		}
		const resetUrl = (payload as { data: { resetUrl: string } }).data.resetUrl;
		const token = resetUrl.slice(
			resetUrl.indexOf("#token=") + "#token=".length,
		);

		const resetRes = await app.request("/auth/password/reset", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Forwarded-For": "10.9.9.10",
			},
			body: JSON.stringify({
				token,
				password: "nueva-segura-00",
				confirmPassword: "nueva-segura-00",
			}),
		});
		expect(resetRes.status).toBe(200);

		// La sesion quedo revocada en la misma transaccion del consumo.
		const after = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		expect(after).toHaveLength(1);
		expect(after[0]?.status).toBe("revoked");
		expect(after[0]?.revokedAt).not.toBeNull();

		// La contrasena vieja ya no entra; la nueva si.
		const oldLogin = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
				password: user.password,
			}),
		});
		expect(oldLogin.status).toBe(401);
		const newLogin = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
				password: "nueva-segura-00",
			}),
		});
		expect(newLogin.status).toBe(200);
	});

	it("refresh rota: par nuevo, anterior invalidado", async () => {
		const user = await registerUser();
		const loginRes = await app.request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				documentType: user.documentType,
				documentNumber: user.documentNumber,
				password: user.password,
			}),
		});
		const first = (await loginRes.json()) as {
			data: { accessToken: string; refreshToken: string; expiresIn: number };
		};

		const refreshRes = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: first.data.refreshToken }),
		});
		expect(refreshRes.status).toBe(200);
		expect(refreshRes.headers.get("Cache-Control")).toBe("no-store");
		const second = (await refreshRes.json()) as {
			data: { accessToken: string; refreshToken: string; expiresIn: number };
		};
		expect(second.data.refreshToken).not.toBe(first.data.refreshToken);
		expect(second.data.expiresIn).toBe(900);

		// Anterior `rotated`, sucesor `active` en la misma familia.
		const db = drizzle({ client: sql });
		const rows = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		expect(rows).toHaveLength(2);
		const byToken = new Map(rows.map((r) => [r.tokenHash, r]));
		const oldHash = createHash("sha256")
			.update(first.data.refreshToken)
			.digest("hex");
		const newHash = createHash("sha256")
			.update(second.data.refreshToken)
			.digest("hex");
		expect(byToken.get(oldHash)?.status).toBe("rotated");
		expect(byToken.get(newHash)?.status).toBe("active");
		expect(byToken.get(oldHash)?.familyId).toBe(byToken.get(newHash)?.familyId);

		// El anterior ya no rota de nuevo: reuse detection (401 + familia revocada).
		const reuse = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: first.data.refreshToken }),
		});
		expect(reuse.status).toBe(401);

		const after = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		for (const row of after) expect(row.status).toBe("revoked");

		// El par nuevo tambien cayo con la familia: 401 generico.
		const afterReuse = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: second.data.refreshToken }),
		});
		expect(afterReuse.status).toBe(401);
		const reuseJson = (await reuse.json()) as {
			error: { code: string; message: string };
		};
		const afterJson = (await afterReuse.json()) as {
			error: { code: string; message: string };
		};
		expect(reuseJson.error.code).toBe("UNAUTHORIZED");
		expect(afterJson.error.message).toBe(reuseJson.error.message);
	});

	it("refresh con token desconocido da 401 sin efectos", async () => {
		const unknown = await app.request("/auth/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: "token-que-no-existe" }),
		});
		expect(unknown.status).toBe(401);
		const json = (await unknown.json()) as {
			error: { code: string; message: string };
		};
		expect(json.error.code).toBe("UNAUTHORIZED");
	});

	it("logout revoca todas las sesiones y responde siempre 200", async () => {
		const user = await registerUser();

		const loginBody = {
			documentType: user.documentType,
			documentNumber: user.documentNumber,
			password: user.password,
		};
		const headers = { "Content-Type": "application/json" };
		const first = (await (
			await app.request("/auth/login", {
				method: "POST",
				headers,
				body: JSON.stringify(loginBody),
			})
		).json()) as { data: { refreshToken: string } };
		const second = (await (
			await app.request("/auth/login", {
				method: "POST",
				headers,
				body: JSON.stringify(loginBody),
			})
		).json()) as { data: { refreshToken: string } };

		const logoutRes = await app.request("/auth/logout", {
			method: "POST",
			headers,
			body: JSON.stringify({ refreshToken: first.data.refreshToken }),
		});
		expect(logoutRes.status).toBe(200);
		expect(logoutRes.headers.get("Cache-Control")).toBe("no-store");
		expect(await logoutRes.json()).toEqual({ data: {} });

		// Ambas sesiones (dos familias) quedaron revocadas.
		const db = drizzle({ client: sql });
		const rows = await db
			.select()
			.from(refreshSessions)
			.where(eq(refreshSessions.userId, user.userId));
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.status).toBe("revoked");

		const withOld = await app.request("/auth/refresh", {
			method: "POST",
			headers,
			body: JSON.stringify({ refreshToken: second.data.refreshToken }),
		});
		expect(withOld.status).toBe(401);

		// Logout con token desconocido: mismo 200 (idempotente).
		const unknown = await app.request("/auth/logout", {
			method: "POST",
			headers,
			body: JSON.stringify({ refreshToken: "token-que-no-existe" }),
		});
		expect(unknown.status).toBe(200);

		// La contrasena no se toco: login nuevo funciona y crea sesion activa.
		const relogin = await app.request("/auth/login", {
			method: "POST",
			headers,
			body: JSON.stringify(loginBody),
		});
		expect(relogin.status).toBe(200);
	});
});
