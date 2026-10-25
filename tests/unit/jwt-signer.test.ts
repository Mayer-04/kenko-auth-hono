import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { makeJwtSigner } from "../../src/infra/token/jwt-signer.js";

const OPTIONS = {
	secret: "test-jwt-secret-con-al-menos-32-caracteres",
	issuer: "kenko-auth",
	audience: "kenko-api",
	kid: "hs256-01",
};

const ARGS = {
	subject: "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
	tokenId: "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10",
	issuedAtSeconds: Math.floor(Date.now() / 1000),
	expiresAtSeconds: Math.floor(Date.now() / 1000) + 900,
};

describe("makeJwtSigner", () => {
	it("firma HS256 con kid y verifica iss/aud/exp/sub/jti", async () => {
		const signer = makeJwtSigner(OPTIONS);
		const token = await signer.signAccessToken(ARGS);
		// Tres segmentos JWT.
		expect(token.split(".")).toHaveLength(3);

		const claims = await signer.verifyAccessToken(token);
		expect(claims.sub).toBe(ARGS.subject);
		expect(claims.iss).toBe("kenko-auth");
		expect(claims.aud).toBe("kenko-api");
		expect(claims.jti).toBe(ARGS.tokenId);
		expect(claims.exp - claims.iat).toBe(900);
	});

	it("rechaza token manipulado, expirado y de otro emisor", async () => {
		const signer = makeJwtSigner(OPTIONS);
		const token = await signer.signAccessToken(ARGS);

		// Firma manipulada: cambia el primer caracter de la firma por otro
		// distinto de forma determinista.
		const [header, payload, signature] = token.split(".");
		const first = signature?.[0];
		expect(header).toBeDefined();
		expect(payload).toBeDefined();
		expect(first).toBeDefined();
		const tampered = `${header}.${payload}.${first === "x" ? "y" : "x"}${signature?.slice(1)}`;
		await expect(signer.verifyAccessToken(tampered)).rejects.toThrow();

		// Expirado.
		const expired = await signer.signAccessToken({
			...ARGS,
			issuedAtSeconds: ARGS.issuedAtSeconds - 3600,
			expiresAtSeconds: ARGS.issuedAtSeconds - 1800,
		});
		await expect(signer.verifyAccessToken(expired)).rejects.toThrow();

		// Otro emisor.
		const other = makeJwtSigner({ ...OPTIONS, issuer: "otro" });
		const foreign = await other.signAccessToken(ARGS);
		await expect(signer.verifyAccessToken(foreign)).rejects.toThrow();
	});

	it("rechaza alg distinto de HS256 (incluido none)", async () => {
		const signer = makeJwtSigner(OPTIONS);
		const key = new TextEncoder().encode(OPTIONS.secret);
		const noneAlg = await new SignJWT({})
			.setProtectedHeader({ alg: "HS384" })
			.setSubject(ARGS.subject)
			.setIssuer(OPTIONS.issuer)
			.setAudience(OPTIONS.audience)
			.setJti(ARGS.tokenId)
			.setIssuedAt(ARGS.issuedAtSeconds)
			.setExpirationTime(ARGS.expiresAtSeconds)
			.sign(key);
		await expect(signer.verifyAccessToken(noneAlg)).rejects.toThrow();
	});
});
