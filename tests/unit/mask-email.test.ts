import { describe, expect, it } from "vitest";
import { maskEmail } from "../../src/features/register/register.normalize.js";

describe("maskEmail", () => {
	it("enmascara conservando primera letra y dominio", () => {
		expect(maskEmail("maria.gomez@example.com")).toBe("m***@example.com");
	});

	it("formato inesperado no filtra el valor", () => {
		expect(maskEmail("sin-arroba")).toBe("***@***");
		expect(maskEmail("a@")).toBe("***@***");
	});
});
