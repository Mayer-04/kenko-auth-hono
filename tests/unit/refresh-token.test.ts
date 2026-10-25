import { describe, expect, it } from "vitest";
import { makeRefreshTokenTool } from "../../src/infra/token/refresh-token.js";

describe("makeRefreshTokenTool", () => {
	it("genera opaco base64url de 32 bytes y hashea a SHA-256 hex", () => {
		const tool = makeRefreshTokenTool(32);
		const token = tool.generate();
		// base64url: sin `+`, `/` ni `=`.
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(Buffer.from(token, "base64url")).toHaveLength(32);
		expect(tool.hash(token)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("dos tokens distintos dan hashes distintos", () => {
		const tool = makeRefreshTokenTool(32);
		expect(tool.hash(tool.generate())).not.toBe(tool.hash(tool.generate()));
	});

	it("equals compara en tiempo constante: igual, distinto y otra longitud", () => {
		const tool = makeRefreshTokenTool(32);
		const hash = tool.hash("raw-refresh-token");
		expect(tool.equals(hash, tool.hash("raw-refresh-token"))).toBe(true);
		expect(tool.equals(hash, tool.hash("otro-token"))).toBe(false);
		expect(tool.equals(hash, "abc")).toBe(false);
	});
});
