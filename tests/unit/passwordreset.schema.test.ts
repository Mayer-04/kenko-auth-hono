import { describe, expect, it } from "vitest";

import {
	ForgotPasswordSchema,
	ResetPasswordSchema,
} from "../../src/features/passwordreset/passwordreset.schema.js";

describe("ForgotPasswordSchema", () => {
	it("normaliza el documento igual que registro (mayusculas sin separadores)", () => {
		const parsed = ForgotPasswordSchema.parse({
			documentType: " cc ",
			documentNumber: "1.020.304-050",
		});
		expect(parsed).toEqual({
			documentType: "CC",
			documentNumber: "1020304050",
		});
	});

	it("rechaza tipo de documento desconocido y numero fuera de formato", () => {
		expect(() =>
			ForgotPasswordSchema.parse({
				documentType: "XX",
				documentNumber: "1020304050",
			}),
		).toThrow();
		expect(() =>
			ForgotPasswordSchema.parse({
				documentType: "CC",
				documentNumber: "ab",
			}),
		).toThrow();
	});
});

describe("ResetPasswordSchema", () => {
	const valid = {
		token: "un-token-opaco",
		password: "clave-nueva-segura-42",
		confirmPassword: "clave-nueva-segura-42",
	};

	it("acepta una entrada valida", () => {
		expect(ResetPasswordSchema.parse(valid)).toEqual(valid);
	});

	it("reutiliza las reglas de contrasena de registro (min 8, deny-list)", () => {
		expect(() =>
			ResetPasswordSchema.parse({
				...valid,
				password: "corta",
				confirmPassword: "corta",
			}),
		).toThrow();
		expect(() =>
			ResetPasswordSchema.parse({
				...valid,
				password: "password123",
				confirmPassword: "password123",
			}),
		).toThrow();
	});

	it("exige que las contrasenas coincidan (confirmPassword solo valida)", () => {
		expect(() =>
			ResetPasswordSchema.parse({ ...valid, confirmPassword: "otra-cosa-99" }),
		).toThrow();
	});

	it("exige token presente pero no valida su formato", () => {
		expect(() => ResetPasswordSchema.parse({ ...valid, token: "" })).toThrow();
		expect(
			ResetPasswordSchema.parse({ ...valid, token: "???caracteres raros???" })
				.token,
		).toBe("???caracteres raros???");
	});
});
