import { invalidCredentials } from "../../shared/errors.js";
import { LogEvent } from "../../shared/log-events.js";
import { MS_PER_DAY } from "./login.limits.js";
import type {
	LoginDeps,
	LoginService,
	LogoutDeps,
	LogoutService,
	RefreshDeps,
	RefreshService,
} from "./login.port.js";

/**
 * Caso de uso `login` (inicio de sesion).
 *
 * - Puro en reglas: no importa `infra/`, recibe puertos.
 * - Anti-enumeracion: usuario inexistente y contrasena incorrecta producen
 *   el MISMO `401 UNAUTHORIZED` generico, sin distinguir el motivo.
 *   Compromiso documentado: la diferencia de tiempo entre ambos caminos
 *   (consulta vs. Argon2) queda como riesgo residual aceptado, igual que en
 *   `passwordreset`: sobre red domina el jitter y no se anade retardo
 *   artificial por sobreingenieria.
 * - Emite access JWT (15 min) + refresh opaco (7 dias) y persiste la sesion
 *   inicial de la familia (`active`). La rotacion y el reuse detection viven
 *   en `makeRefreshSessionService`; el logout en `makeLogoutService`.
 * - El login NO publica eventos.
 * - Nunca registra PII, contrasenas ni tokens; el llamador loguea solo IDs.
 */
export const makeLoginService = (deps: LoginDeps): LoginService => {
	return async (input, correlationId) => {
		const user = await deps.users.findByDocument(
			input.documentType,
			input.documentNumber,
		);
		if (user === null) {
			deps.logger.warn(LogEvent.LOGIN_FAILED, { correlationId });
			throw invalidCredentials(correlationId);
		}

		const passwordOk = await deps.hasher.verify(
			user.passwordHash,
			input.password,
		);
		if (!passwordOk) {
			deps.logger.warn(LogEvent.LOGIN_FAILED, { correlationId });
			throw invalidCredentials(correlationId);
		}

		const now = deps.now();
		const issuedAtSeconds = Math.floor(now.getTime() / 1000);
		const expiresAtSeconds = issuedAtSeconds + deps.accessTtlSeconds;
		const jwtId = deps.newJwtId();

		const accessToken = await deps.accessTokens.signAccessToken({
			subject: user.id,
			tokenId: jwtId,
			issuedAtSeconds,
			expiresAtSeconds,
		});

		const refreshToken = deps.refreshTokens.generate();
		const sessionId = deps.newSessionId();
		const familyId = deps.newFamilyId();
		const expiresAt = new Date(
			now.getTime() + deps.refreshTtlDays * MS_PER_DAY,
		).toISOString();

		await deps.sessions.createLoginSession({
			id: sessionId,
			userId: user.id,
			familyId,
			tokenHash: deps.refreshTokens.hash(refreshToken),
			status: "active",
			expiresAt,
			correlationId,
		});

		deps.logger.info(LogEvent.LOGIN_SUCCEEDED, {
			userId: user.id,
			sessionId,
			correlationId,
		});

		return {
			accessToken,
			refreshToken,
			expiresIn: deps.accessTtlSeconds,
		};
	};
};

/**
 * Caso de uso `refresh` (rotacion del refresh token).
 *
 * - Token opaco en el BODY; se hashea (SHA-256) y se busca por hash.
 *   Un token basura simplemente no coincide: mismo 401 generico.
 * - `active` y vigente: rota en UNA transaccion (anterior a `rotated`,
 *   sucesora `active` en la misma familia). `false` si otro request gano
 *   la carrera: solo uno tiene exito.
 * - Reuse detection: presentar un token `rotated` (ya usado) revoca TODA
 *   la familia y devuelve el mismo 401, sin revelar el motivo.
 * - `revoked`: solo 401 (estado terminal, sin señal de robo: no se toca
 *   la familia). Expirado: 401.
 * - Carrera perdida: si el `rotateSession` atomico devuelve `false`, se
 *   relee por hash; si ya esta `rotated`, otro request uso el mismo token
 *   primero (reuso concurrente) y tambien se revoca la familia.
 * - Nunca registra PII ni tokens; solo IDs.
 */
export const makeRefreshSessionService = (
	deps: RefreshDeps,
): RefreshService => {
	return async (input, correlationId) => {
		const tokenHash = deps.refreshTokens.hash(input.refreshToken);
		const session = await deps.sessions.findSessionByTokenHash(tokenHash);
		if (session === null) {
			deps.logger.warn(LogEvent.LOGIN_REFRESH_FAILED, { correlationId });
			throw invalidCredentials(correlationId);
		}
		if (!deps.refreshTokens.equals(session.tokenHash, tokenHash)) {
			deps.logger.warn(LogEvent.LOGIN_REFRESH_FAILED, { correlationId });
			throw invalidCredentials(correlationId);
		}

		if (session.status === "rotated") {
			await deps.sessions.revokeFamily(session.familyId);
			deps.logger.warn(LogEvent.LOGIN_REUSE_DETECTED, {
				userId: session.userId,
				familyId: session.familyId,
				correlationId,
			});
			throw invalidCredentials(correlationId);
		}
		if (
			session.status !== "active" ||
			session.expiresAt <= deps.now().toISOString()
		) {
			deps.logger.warn(LogEvent.LOGIN_REFRESH_FAILED, { correlationId });
			throw invalidCredentials(correlationId);
		}

		const now = deps.now();
		const issuedAtSeconds = Math.floor(now.getTime() / 1000);
		const accessToken = await deps.accessTokens.signAccessToken({
			subject: session.userId,
			tokenId: deps.newJwtId(),
			issuedAtSeconds,
			expiresAtSeconds: issuedAtSeconds + deps.accessTtlSeconds,
		});

		const refreshToken = deps.refreshTokens.generate();
		const rotated = await deps.sessions.rotateSession({
			oldId: session.id,
			userId: session.userId,
			newSession: {
				id: deps.newSessionId(),
				familyId: session.familyId,
				tokenHash: deps.refreshTokens.hash(refreshToken),
				expiresAt: new Date(
					now.getTime() + deps.refreshTtlDays * MS_PER_DAY,
				).toISOString(),
				correlationId,
			},
		});
		if (!rotated) {
			// Otro request gano la carrera con el MISMO token: si ya esta
			// `rotated`, es reuso concurrente y tambien se revoca la familia.
			const current = await deps.sessions.findSessionByTokenHash(tokenHash);
			if (current !== null && current.status === "rotated") {
				await deps.sessions.revokeFamily(current.familyId);
				deps.logger.warn(LogEvent.LOGIN_REUSE_DETECTED, {
					userId: current.userId,
					familyId: current.familyId,
					correlationId,
				});
			} else {
				deps.logger.warn(LogEvent.LOGIN_REFRESH_FAILED, { correlationId });
			}
			throw invalidCredentials(correlationId);
		}

		deps.logger.info(LogEvent.LOGIN_REFRESHED, {
			userId: session.userId,
			familyId: session.familyId,
			correlationId,
		});

		return {
			accessToken,
			refreshToken,
			expiresIn: deps.accessTtlSeconds,
		};
	};
};

/**
 * Caso de uso `logout` (cierre de sesion).
 *
 * - Idempotente y anti-enumeracion: responda siempre 200, exista o no la
 *   sesion. Con un token conocido revoca TODAS las sesiones `active` del
 *   usuario (todos sus dispositivos/familias); con uno desconocido no hace
 *   nada. No distingue ambos casos.
 * - No toca la contrasena: el usuario puede volver a loguearse.
 * - Nunca registra PII ni tokens; solo IDs.
 */
export const makeLogoutService = (deps: LogoutDeps): LogoutService => {
	return async (input, correlationId) => {
		const tokenHash = deps.refreshTokens.hash(input.refreshToken);
		const session = await deps.sessions.findSessionByTokenHash(tokenHash);
		if (session !== null) {
			await deps.sessions.revokeAllUserSessions(session.userId);
			deps.logger.info(LogEvent.LOGIN_LOGGED_OUT, {
				userId: session.userId,
				correlationId,
			});
		}
		return { correlationId };
	};
};
