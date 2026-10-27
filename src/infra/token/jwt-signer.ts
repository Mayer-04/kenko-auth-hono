import { jwtVerify, SignJWT } from "jose";

import type {
	AccessTokenSigner,
	AccessTokenVerifier,
} from "../../features/login/login.port.js";

/**
 * Firma y verificacion del access token (HS256, HMAC-SHA256).
 *
 * Decision temporal por practicidad; ES256 con JWKS queda para una fase
 * posterior. La interfaz (`AccessTokenSigner`/`AccessTokenVerifier`) permite
 * migrar sin tocar el caso de uso: solo cambia esta implementacion.
 *
 * Validaciones obligatorias al verificar: `alg` (unicamente HS256; `none`
 * y cualquier otro se rechazan), `iss`, `aud` y `exp` (las aplica `jose`;
 * `sub` y `jti` se exigen aqui porque el contrato los declara obligatorios).
 * Sin JWKS no hay llamadas HTTP entre servicios.
 *
 * El secreto llega por entorno (`JWT_SECRET`, minimo 32 caracteres) y nunca
 * se registra. Limitacion conocida y aceptada: cualquier servicio que
 * conozca el secreto podria emitir tokens validos.
 */
export type JwtSignerOptions = {
	secret: string;
	issuer: string;
	audience: string;
	kid: string;
};

const singleAudience = (aud: string | string[] | undefined): string => {
	if (typeof aud === "string") return aud;
	if (Array.isArray(aud) && typeof aud[0] === "string") return aud[0];
	throw new Error("Access token misses audience.");
};

export const makeJwtSigner = (
	options: JwtSignerOptions,
): AccessTokenSigner & AccessTokenVerifier => {
	const key = new TextEncoder().encode(options.secret);

	return {
		async signAccessToken({
			subject,
			tokenId,
			issuedAtSeconds,
			expiresAtSeconds,
			sessionFamilyId,
		}): Promise<string> {
			return new SignJWT(
				sessionFamilyId !== undefined ? { sid: sessionFamilyId } : {},
			)
				.setProtectedHeader({ alg: "HS256", typ: "JWT", kid: options.kid })
				.setSubject(subject)
				.setIssuer(options.issuer)
				.setAudience(options.audience)
				.setJti(tokenId)
				.setIssuedAt(issuedAtSeconds)
				.setExpirationTime(expiresAtSeconds)
				.sign(key);
		},

		async verifyAccessToken(token: string) {
			const { payload } = await jwtVerify(token, key, {
				algorithms: ["HS256"],
				issuer: options.issuer,
				audience: options.audience,
			});
			if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
				throw new Error("Access token misses sub/jti.");
			}
			if (typeof payload.iss !== "string") {
				throw new Error("Access token misses issuer.");
			}
			if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
				throw new Error("Access token misses exp/iat.");
			}
			return {
				sub: payload.sub,
				iss: payload.iss,
				aud: singleAudience(payload.aud),
				exp: payload.exp,
				iat: payload.iat,
				jti: payload.jti,
				...(typeof payload.sid === "string" ? { sid: payload.sid } : {}),
			};
		},
	};
};
