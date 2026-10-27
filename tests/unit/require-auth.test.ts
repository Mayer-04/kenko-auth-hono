import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppVariables } from "../../src/shared/http.js";
import { errorHandler } from "../../src/shared/http.js";
import { newId } from "../../src/shared/ids.js";
import { makeRequireAuth } from "../../src/shared/middleware/require-auth.js";

/**
 * `requireAuth`: exige `Authorization: Bearer ...`, valida el JWT y deja
 * `userId` (+ `sessionFamilyId` si el token trae `sid`) en el contexto.
 * Cualquier fallo da el mismo 401 generico, sin distinguir el motivo.
 */
const buildApp = (
	verify: (token: string) => Promise<{ sub: string; sid?: string }>,
) => {
	const app = new Hono<{ Variables: AppVariables }>();
	app.use(async (c, next) => {
		c.set("correlationId", newId());
		await next();
	});
	app.use(makeRequireAuth({ verifyAccessToken: verify }));
	app.get("/privado", (c) =>
		c.json({
			data: {
				userId: c.get("userId"),
				sessionFamilyId: c.get("sessionFamilyId") ?? null,
			},
		}),
	);
	app.onError((err, c) => errorHandler(err, c));
	return app;
};

describe("makeRequireAuth", () => {
	it("con token valido expone userId y familia", async () => {
		const app = buildApp(async (token) => {
			expect(token).toBe("buen-token");
			return { sub: "user-1", sid: "family-1" };
		});
		const res = await app.request("/privado", {
			headers: { Authorization: "Bearer buen-token" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: { userId: "user-1", sessionFamilyId: "family-1" },
		});
	});

	it("token sin sid (legacy): userId si, familia ausente", async () => {
		const app = buildApp(async () => ({ sub: "user-1" }));
		const res = await app.request("/privado", {
			headers: { Authorization: "Bearer token-viejo" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: { userId: "user-1", sessionFamilyId: null },
		});
	});

	it("sin cabecera, malformada o token invalido dan el mismo 401", async () => {
		const app = buildApp(async () => {
			throw new Error("firma invalida");
		});
		const cases = [
			{},
			{ Authorization: "Token abc" },
			{ Authorization: "Bearer " },
			{ Authorization: "Bearer malo" },
		];
		for (const headers of cases) {
			const res = await app.request("/privado", { headers });
			expect(res.status).toBe(401);
			const json = (await res.json()) as {
				error: { code: string; message: string };
			};
			expect(json.error.code).toBe("UNAUTHORIZED");
		}
	});
});
