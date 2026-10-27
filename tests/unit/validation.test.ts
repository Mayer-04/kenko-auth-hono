import { describe, expect, it } from "vitest";

import { validationErrorHook } from "../../src/shared/validation.js";

/**
 * El hook traduce fallos de Zod al sobre comun de errores
 * (`{error:{code,message,correlationId}}`, 400) en vez del formato
 * crudo del validador (`{"success":false,...}`).
 */
const fakeContext = (correlationId: string) => {
	const headers: Record<string, string> = {};
	return {
		get: (key: string) => (key === "correlationId" ? correlationId : undefined),
		header: (name: string, value: string) => {
			headers[name] = value;
		},
		json: (body: unknown, status: number) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		headers,
	};
};

describe("validationErrorHook", () => {
	it("exito de validacion: no responde nada", () => {
		const res = validationErrorHook(
			{ success: true },
			fakeContext("corr-1") as never,
		);
		expect(res).toBeUndefined();
	});

	it("fallo: 400 con el sobre comun y el primer mensaje", async () => {
		const res = validationErrorHook(
			{
				success: false,
				error: {
					issues: [
						{ message: "Nombres es obligatorio." },
						{ message: "Otro error que no debe salir." },
					],
				},
			},
			fakeContext("corr-2") as never,
		);
		expect(res).toBeInstanceOf(Response);
		expect(res?.status).toBe(400);
		const json = (await res?.json()) as {
			error: { code: string; message: string; correlationId: string };
		};
		expect(json).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "Nombres es obligatorio.",
				correlationId: "corr-2",
			},
		});
	});

	it("sin issues: mensaje generico seguro", async () => {
		const res = validationErrorHook(
			{ success: false },
			fakeContext("corr-3") as never,
		);
		const json = (await res?.json()) as {
			error: { code: string; message: string };
		};
		expect(res?.status).toBe(400);
		expect(json.error.code).toBe("VALIDATION_ERROR");
		expect(json.error.message).toBe("Datos inválidos.");
	});
});
