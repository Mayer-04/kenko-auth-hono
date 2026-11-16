import { describe, expect, it } from "vitest";
import {
	buildClearRefreshCookie,
	buildRefreshCookie,
	refreshTokenFromCookie,
} from "../../src/shared/cookies.js";
import { REFRESH_COOKIE_NAME } from "../../src/shared/headers.js";

describe("refresh cookie", () => {
	it("lee el token desde la cabecera Cookie", () => {
		const header = `otra=1; ${REFRESH_COOKIE_NAME}=abc123; x=2`;
		expect(refreshTokenFromCookie(header)).toBe("abc123");
	});

	it("ausente o vacia da undefined", () => {
		expect(refreshTokenFromCookie(undefined)).toBeUndefined();
		expect(refreshTokenFromCookie("")).toBeUndefined();
		expect(refreshTokenFromCookie("otra=1")).toBeUndefined();
	});

	it("fija httpOnly + SameSite=Lax + Path y Secure solo en https", () => {
		const http = buildRefreshCookie("tok", "http://localhost:3000/auth/login");
		expect(http).toContain(`${REFRESH_COOKIE_NAME}=tok`);
		expect(http).toContain("HttpOnly");
		expect(http).toContain("SameSite=Lax");
		expect(http).not.toContain("Secure");

		const https = buildRefreshCookie("tok", "https://api.kenko.com/auth/login");
		expect(https).toContain("Secure");
	});

	it("limpiar expira la cookie", () => {
		const cleared = buildClearRefreshCookie(
			"https://api.kenko.com/auth/logout",
		);
		expect(cleared).toContain("Max-Age=0");
		expect(cleared).toContain("HttpOnly");
	});
});
