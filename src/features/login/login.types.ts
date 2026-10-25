import type { DocumentType } from "../user/user.types.js";

/**
 * Dominio del caso de uso `login`.
 *
 * El login NO publica eventos: solo valida credenciales, emite el access
 * token (JWT HS256, 15 min) y el refresh token (opaco, 7 dias), y persiste
 * la sesion de refresh con su familia para rotacion y reuse detection
 * futura (endpoints fuera del alcance actual).
 */

/** Entrada de `login` ya normalizada. */
export type LoginInput = {
	documentType: DocumentType;
	documentNumber: string;
	password: string;
};

/** Resultado del caso de uso. Los tokens viajan al BFF, que los guarda. */
export type LoginResult = {
	accessToken: string;
	refreshToken: string;
	/** Segundos de vida del access token (15 min = 900). */
	expiresIn: number;
};

/** Entrada de `refresh` y `logout`: el token llega en el BODY, nunca en la URL. */
export type RefreshInput = {
	refreshToken: string;
};

/** Resultado de `refresh`: par nuevo; el anterior queda invalidado. */
export type RefreshResult = {
	accessToken: string;
	refreshToken: string;
	/** Segundos de vida del access token (15 min = 900). */
	expiresIn: number;
};

/** Resultado de `logout`. Solo IDs, sin PII ni token. */
export type LogoutResult = {
	correlationId: string;
};

/** Claims obligatorios del access token (diseno 4.1). */
export type AccessTokenClaims = {
	sub: string;
	iss: string;
	aud: string;
	exp: number;
	iat: number;
	jti: string;
};
