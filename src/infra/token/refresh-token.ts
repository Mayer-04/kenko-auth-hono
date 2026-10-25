import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { RefreshTokenTool } from "../../features/login/login.port.js";

/**
 * Refresh token opaco: aleatorio (CSPRNG de `node:crypto`), base64url.
 * NO es JWT: no lleva claims ni firma verificable; su validez se determina
 * unicamente por la fila en base de datos (familia/estado/expiracion).
 *
 * El hash almacenado es SHA-256 en hex. Es correcto aqui a proposito: el
 * token ya tiene 256 bits de entropia aleatoria, por lo que no necesita
 * una KDF lenta como Argon2 (igual que el token de restablecimiento).
 * La comparacion de hashes usa `timingSafeEqual`.
 *
 * Nunca se registra el token ni el hash.
 */
export const makeRefreshTokenTool = (
	randomBytesCount: number,
): RefreshTokenTool => {
	return {
		generate(): string {
			return randomBytes(randomBytesCount).toString("base64url");
		},
		hash(token: string): string {
			return createHash("sha256").update(token).digest("hex");
		},
		equals(aHex: string, bHex: string): boolean {
			const a = Buffer.from(aHex, "hex");
			const b = Buffer.from(bHex, "hex");
			if (a.length !== b.length) return false;
			return timingSafeEqual(a, b);
		},
	};
};
