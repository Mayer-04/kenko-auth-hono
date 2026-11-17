import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppVariables } from "../../src/shared/http.js";
import { errorHandler } from "../../src/shared/http.js";
import { validationErrorHook } from "../../src/shared/validation.js";

/**
 * Regresion: `Content-Type: application/json` con body vacio o malformado
 * lanzaba `HTTPException` en el validador de Hono antes de Zod y caia al
 * 500 generico. Debe responder 400 con el sobre comun de errores.
 */
const OptionalBody = z.object({
	refreshToken: z.string().min(1).optional(),
});

const buildApp = (
	warns: Array<{ event: string; fields: Record<string, string> }> = [],
) => {
	const app = new Hono<{ Variables: AppVariables }>();
	app.use(async (c, next) => {
		c.set("correlationId", "corr-test-1");
		await next();
	});
	app.post("/t", zValidator("json", OptionalBody, validationErrorHook), (c) =>
		c.json({ data: "ok" }),
	);
	app.post("/boom", () => {
		throw new Error("mensaje-con-secreto-no-logeable");
	});
	app.onError((err, c) =>
		errorHandler(err, c, {
			warn: (event: string, fields: Record<string, string>) => {
				warns.push({ event, fields });
			},
		}),
	);
	return app;
};

describe("errorHandler con HTTPException de Hono", () => {
	it("Content-Type json + body vacio responde 400, no 500", async () => {
		const res = await buildApp().request("/t", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as {
			error: {
				code: string;
				message: string;
				correlationId: string;
				details: unknown[];
			};
		};
		expect(json.error.code).toBe("VALIDATION_ERROR");
		expect(typeof json.error.message).toBe("string");
		expect(json.error.correlationId).toBe("corr-test-1");
		expect(json.error.details).toEqual([]);
	});

	it("Content-Type json + body malformado responde 400, no 500", async () => {
		const res = await buildApp().request("/t", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{malformado",
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: { code: string } };
		expect(json.error.code).toBe("VALIDATION_ERROR");
	});

	it("sin Content-Type y sin body sigue pasando la validacion (control)", async () => {
		const res = await buildApp().request("/t", { method: "POST" });
		expect(res.status).toBe(200);
	});

	it("body '{}' valido sigue pasando (control)", async () => {
		const res = await buildApp().request("/t", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(200);
	});

	it("error no manejado responde 500 y deja rastro sin mensaje ni stack", async () => {
		const warns: Array<{
			event: string;
			fields: Record<string, string>;
		}> = [];
		const res = await buildApp(warns).request("/boom", { method: "POST" });
		expect(res.status).toBe(500);
		const json = (await res.json()) as { error: { code: string } };
		expect(json.error.code).toBe("INTERNAL_ERROR");

		expect(warns).toHaveLength(1);
		expect(warns[0]?.event).toBe("http.unhandled_error");
		expect(warns[0]?.fields.correlationId).toBe("corr-test-1");
		expect(warns[0]?.fields.errorName).toBe("Error");
		// El mensaje del error nunca sale en logs (podria traer PII/SQL).
		expect(JSON.stringify(warns)).not.toContain("mensaje-con-secreto");
	});
});
