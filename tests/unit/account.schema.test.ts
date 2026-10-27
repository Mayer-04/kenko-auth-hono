import { describe, expect, it } from "vitest";
import {
	ChangeEmailSchema,
	ChangePasswordSchema,
} from "../../src/features/account/account.schema.js";

describe("ChangePasswordSchema", () => {
	it("acepta actual y nueva validas (sin confirmacion en el backend)", () => {
		const res = ChangePasswordSchema.safeParse({
			currentPassword: "clave-actual-99",
			newPassword: "nueva-clave-00",
		});
		expect(res.success).toBe(true);
	});

	it("rechaza actual vacia y nueva debil o comun", () => {
		for (const body of [
			{ currentPassword: "", newPassword: "nueva-clave-00" },
			{ currentPassword: "clave-actual-99", newPassword: "corta" },
			{ currentPassword: "clave-actual-99", newPassword: "password" },
		]) {
			expect(ChangePasswordSchema.safeParse(body).success).toBe(false);
		}
	});
});

describe("ChangeEmailSchema", () => {
	it("normaliza el correo (trim + minusculas)", () => {
		const res = ChangeEmailSchema.safeParse({
			newEmail: "  Maria.Nuevo@Example.COM ",
			currentPassword: "clave-actual-99",
		});
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.newEmail).toBe("maria.nuevo@example.com");
	});

	it("rechaza formato invalido y actual vacia", () => {
		for (const body of [
			{ newEmail: "no-es-correo", currentPassword: "clave-actual-99" },
			{ newEmail: "nuevo@example.com", currentPassword: "" },
		]) {
			expect(ChangeEmailSchema.safeParse(body).success).toBe(false);
		}
	});
});
