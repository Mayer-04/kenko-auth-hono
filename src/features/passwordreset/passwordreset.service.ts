import { invalidResetToken, reusedPassword } from "../../shared/errors.js";
import { LogEvent } from "../../shared/log-events.js";
import { MS_PER_MINUTE } from "./passwordreset.limits.js";
import type {
	ForgotDeps,
	ForgotService,
	ResetDeps,
	ResetService,
} from "./passwordreset.port.js";
import type {
	PasswordResetRequestedDetail,
	PasswordResetResult,
} from "./passwordreset.types.js";

/**
 * Construye el enlace de restablecimiento con el token en el fragmento
 * (`#token=`), para que no viaje en query, logs de proxy ni `Referer`.
 */
export const buildResetUrl = (baseUrl: string, token: string): string =>
	`${baseUrl.replace(/\/+$/, "")}/reset#token=${token}`;

/**
 * Caso de uso `forgot` (solicitud de restablecimiento).
 *
 * - Anti-enumeracion: la existencia de la cuenta no cambia la respuesta del
 *   API (el route devuelve siempre el mismo 200). Aqui solo se abstiene de
 *   escribir si no hay usuario.
 * - Token opaco aleatorio; en DB se guarda SOLO su hash SHA-256.
 * - El token en claro solo viaja dentro del fragmento de `data.resetUrl`
 *   (`<baseUrl>/reset#token=<token>`); `data` ya no trae `resetToken` suelto.
 * - Invalida los tokens anteriores del usuario y crea el nuevo + fila outbox
 *   en UNA transaccion (delegado al repositorio).
 * - D6 confirmada: permite cuentas con `emailVerified=false`.
 * - Nunca registra PII, token, URL ni password; solo IDs.
 */
export const makeForgotPasswordService = (deps: ForgotDeps): ForgotService => {
	return async (input, correlationId): Promise<PasswordResetResult> => {
		const user = await deps.users.findByDocument(
			input.documentType,
			input.documentNumber,
		);
		if (user === null) {
			deps.logger.warn(LogEvent.PASSWORD_RESET_REQUEST_UNKNOWN, {
				correlationId,
			});
			return { correlationId };
		}

		const now = deps.now();
		const token = deps.tokenTool.generate();
		const eventId = deps.newEventId();
		const occurredAt = now.toISOString();
		const expiresAt = new Date(
			now.getTime() + deps.ttlMinutes * MS_PER_MINUTE,
		).toISOString();
		const resetUrl = buildResetUrl(deps.baseUrl, token);

		const payload: PasswordResetRequestedDetail = {
			metadata: { eventId, eventVersion: "1", occurredAt, correlationId },
			data: {
				userId: user.id,
				email: user.email,
				firstName: user.firstName,
				resetUrl,
				expiresAt,
			},
		};

		await deps.tokens.createTokenWithOutbox({
			token: {
				id: deps.newTokenId(),
				userId: user.id,
				tokenHash: deps.tokenTool.hash(token),
				expiresAt,
				correlationId,
			},
			outbox: {
				eventId,
				eventType: "PasswordResetRequested",
				eventVersion: "1",
				correlationId,
				payload,
			},
		});

		deps.logger.info(LogEvent.PASSWORD_RESET_REQUESTED, {
			userId: user.id,
			eventId,
			correlationId,
		});

		return { correlationId };
	};
};

/**
 * Caso de uso `reset` (restablecimiento con el token del enlace).
 *
 * - Un UNICO error generico (`PASSWORD_RESET_INVALID`) para token invalido,
 *   expirado, ya usado o inexistente: no se distingue el motivo.
 * - Politica de no reutilizacion: la nueva contrasena no puede ser la actual
 *   (verificada contra el hash vigente con el mismo `PasswordHasher`).
 * - El consumo del token y el cambio de contrasena son atomicos: dos requests
 *   concurrentes con el mismo token; solo una tiene exito.
 * - Punto de extension documentado en el puerto: cuando existan sesiones,
 *   refresh tokens y MFA, la revocacion de sesiones debe ocurrir en la misma
 *   transaccion que el consumo del token.
 */
export const makeResetPasswordService = (deps: ResetDeps): ResetService => {
	return async (input, correlationId): Promise<PasswordResetResult> => {
		const tokenHash = deps.tokenTool.hash(input.token);

		const active = await deps.tokens.findActiveTokenByHash(tokenHash);
		if (active === null) throw invalidResetToken(correlationId);

		const user = await deps.users.findUserById(active.userId);
		if (user === null) throw invalidResetToken(correlationId);

		const reusesCurrent = await deps.hasher.verify(
			user.passwordHash,
			input.password,
		);
		if (reusesCurrent) throw reusedPassword(correlationId);

		const passwordHash = await deps.hasher.hash(input.password);

		const consumed = await deps.tokens.consumeTokenAndUpdatePassword({
			tokenHash,
			userId: user.id,
			passwordHash,
		});
		if (!consumed) throw invalidResetToken(correlationId);

		deps.logger.info(LogEvent.PASSWORD_RESET_COMPLETED, {
			userId: user.id,
			correlationId,
		});

		return { correlationId };
	};
};
