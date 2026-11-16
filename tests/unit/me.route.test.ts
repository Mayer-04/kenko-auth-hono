import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeMeRoute } from "../../src/features/account/account.route.js";
import type { AppVariables } from "../../src/shared/http.js";
import { errorHandler } from "../../src/shared/http.js";
import { newId } from "../../src/shared/ids.js";

const buildMeApp = (
	account: {
		id: string;
		email: string;
		firstName: string;
		lastName: string;
		passwordHash: string;
	} | null,
	warns: Array<{ event: string; ids: Record<string, string> }> = [],
) => {
	const app = new Hono<{ Variables: AppVariables }>();
	app.use(async (c, next) => {
		c.set("correlationId", newId());
		c.set("userId", "user-1");
		await next();
	});
	app.route(
		"/",
		makeMeRoute({
			users: { findAccountById: async () => account },
			logger: {
				info: () => {},
				warn: (event: string, ids: Record<string, string>) => {
					warns.push({ event, ids });
				},
			},
		}),
	);
	app.onError((err, c) => errorHandler(err, c));
	return app;
};

describe("GET /auth/me", () => {
	it("devuelve identidad minima sin exponer hash", async () => {
		const app = buildMeApp({
			id: "user-1",
			email: "maria.gomez@example.com",
			firstName: "Maria Fernanda",
			lastName: "Gomez Rojas",
			passwordHash: "hash",
		});
		const res = await app.request("/auth/me");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: {
				userId: "user-1",
				firstName: "Maria Fernanda",
				email: "maria.gomez@example.com",
			},
		});
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("usuario inexistente da 401 generico y deja me.failed", async () => {
		const warns: Array<{ event: string; ids: Record<string, string> }> = [];
		const app = buildMeApp(null, warns);
		const res = await app.request("/auth/me");
		expect(res.status).toBe(401);
		expect(warns).toEqual([
			{
				event: "me.failed",
				ids: { userId: "user-1", correlationId: expect.any(String) },
			},
		]);
	});
});
