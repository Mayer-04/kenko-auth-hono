import { describe, expect, it } from "vitest";
import { LoginSchema } from "../../src/features/login/login.schema.js";

describe("LoginSchema", () => {
	it("acepta documento y contrasena validos", () => {
		const res = LoginSchema.safeParse({
			documentType: "CC",
			documentNumber: "1020304050",
			password: "correcta-segura-99",
		});
		expect(res.success).toBe(true);
	});

	it("normaliza tipo en minusculas y numero con separadores", () => {
		const res = LoginSchema.safeParse({
			documentType: "cc",
			documentNumber: " 1020-3040.50 ",
			password: "correcta-segura-99",
		});
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.documentType).toBe("CC");
		expect(res.data.documentNumber).toBe("1020304050");
	});

	it("rechaza tipo de documento desconocido", () => {
		const res = LoginSchema.safeParse({
			documentType: "XX",
			documentNumber: "1020304050",
			password: "correcta-segura-99",
		});
		expect(res.success).toBe(false);
	});

	it("rechaza numero de documento invalido y contrasena vacia", () => {
		const res = LoginSchema.safeParse({
			documentType: "CC",
			documentNumber: "!!!",
			password: "",
		});
		expect(res.success).toBe(false);
	});

	it("no altera los espacios de la contrasena", () => {
		const res = LoginSchema.safeParse({
			documentType: "CC",
			documentNumber: "1020304050",
			password: " con espacios ",
		});
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("unreachable");
		expect(res.data.password).toBe(" con espacios ");
	});
});
