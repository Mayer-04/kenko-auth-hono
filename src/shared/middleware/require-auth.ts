import { createMiddleware } from "hono/factory";

import { invalidCredentials } from "../errors.js";
import type { AppVariables } from "../http.js";

/**
 * Exige JWT de access (`Authorization: Bearer ...`) en rutas autenticadas.
 *
 * - Fabrica que recibe el verificador (inyectado por `container.ts`):
 *   `features/` y `shared/` nunca importan `infra/`, asi que el tipo minimo
 *   se declara aqui y la implementacion real (`infra/token/jwt-signer.ts`)
 *   encaja por estructura.
 * - Valida firma y `alg` (solo HS256), `iss`, `aud` y `exp`; cualquier fallo
 *   (cabecera ausente, malformada, token invalido o expirado) da el MISMO
 *   `401 UNAUTHORIZED` generico, sin distinguir el motivo.
 * - Deja `userId` (`sub`) y `sessionFamilyId` (`sid`, ausente en tokens
 *   emitidos antes del claim) en el contexto. Nunca registra el token.
 */
export type AccessTokenVerifierPort = {
	verifyAccessToken(token: string): Promise<{
		sub: string;
		sid?: string;
	}>;
};

export const makeRequireAuth = (
	verifier: AccessTokenVerifierPort,
): ReturnType<typeof createMiddleware<{ Variables: AppVariables }>> => {
	return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
		const correlationId = c.get("correlationId");
		const header = c.req.header("Authorization");
		const token =
			header?.startsWith("Bearer ") === true
				? header.slice("Bearer ".length).trim()
				: "";

		if (token === "") throw invalidCredentials(correlationId);

		let claims: { sub: string; sid?: string };
		try {
			claims = await verifier.verifyAccessToken(token);
		} catch {
			throw invalidCredentials(correlationId);
		}

		c.set("userId", claims.sub);
		if (claims.sid !== undefined) c.set("sessionFamilyId", claims.sid);
		await next();
	});
};
