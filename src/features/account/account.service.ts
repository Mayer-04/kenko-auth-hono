import { isUniqueViolation } from "../../shared/db-errors.js";
import {
	emailTaken,
	passwordWithUserData,
	reusedPassword,
	wrongCurrentPassword,
} from "../../shared/errors.js";
import { LogEvent } from "../../shared/log-events.js";
import type { PasswordHasher } from "../register/register.port.js";
import type {
	AccountLogger,
	AccountReader,
	AccountRecord,
	ChangePasswordDeps,
	ChangePasswordService,
	EmailChangeDeps,
	EmailChangeService,
} from "./account.port.js";
import type { EmailChangedDetail } from "./account.types.js";

/**
 * Carga la cuenta y verifica la contrasena actual, o 401 especifico.
 *
 * Patron comun de los endpoints autenticados de `account`: la identidad ya
 * esta autenticada por el JWT, asi que el mensaje no revela nada nuevo.
 * Evita duplicar la secuencia null-check + verify en cada caso de uso.
 */
const requireAccountWithPassword = async (
	deps: {
		users: AccountReader;
		hasher: PasswordHasher;
		logger: AccountLogger;
	},
	userId: string,
	currentPassword: string,
	failedEvent: string,
	correlationId: string,
): Promise<AccountRecord> => {
	const account = await deps.users.findAccountById(userId);
	if (account === null) {
		deps.logger.warn(failedEvent, { correlationId });
		throw wrongCurrentPassword(correlationId);
	}

	const currentOk = await deps.hasher.verify(
		account.passwordHash,
		currentPassword,
	);
	if (!currentOk) {
		deps.logger.warn(failedEvent, { correlationId });
		throw wrongCurrentPassword(correlationId);
	}

	return account;
};

/**
 * Caso de uso `changePassword` (cambio autenticado de contrasena).
 *
 * - Puro en reglas: no importa `infra/`, recibe puertos.
 * - `userId` y `keepFamilyId` salen del JWT (`requireAuth`), no del body:
 *   un usuario solo cambia SU contrasena.
 * - Actual incorrecta: 401 con mensaje especifico (aceptado: la identidad
 *   ya esta autenticada, no revela nada nuevo).
 * - Nueva igual a la actual o con el correo/nombre completos (insensible a
 *   caja): 400. La forma (min 8, deny-list) ya la valido el esquema.
 * - Efecto atomico en el repositorio: hash nuevo + revoca sesiones `active`
 *   de otras familias + invalida tokens de restablecimiento pendientes.
 *   La familia actual sobrevive y el cliente la rota con `refresh`
 *   (sin `sid` en el token se revoca todo y hay que reloguearse).
 * - Nunca registra PII ni secretos; solo IDs.
 */
export const makeChangePasswordService = (
	deps: ChangePasswordDeps,
): ChangePasswordService => {
	return async (input, userId, keepFamilyId, correlationId) => {
		const account = await requireAccountWithPassword(
			deps,
			userId,
			input.currentPassword,
			LogEvent.PASSWORD_CHANGE_FAILED,
			correlationId,
		);

		if (
			input.newPassword === input.currentPassword ||
			(await deps.hasher.verify(account.passwordHash, input.newPassword))
		) {
			throw reusedPassword(correlationId);
		}

		if (containsUserData(input.newPassword, account)) {
			throw passwordWithUserData(correlationId);
		}

		const passwordHash = await deps.hasher.hash(input.newPassword);
		const changed = await deps.users.changePasswordAndRevokeOthers({
			userId,
			passwordHash,
			keepFamilyId,
			correlationId,
		});
		if (!changed) {
			deps.logger.warn(LogEvent.PASSWORD_CHANGE_FAILED, { correlationId });
			throw wrongCurrentPassword(correlationId);
		}

		deps.logger.info(LogEvent.PASSWORD_CHANGED, { userId, correlationId });

		return { correlationId };
	};
};

/** Coincidencia exacta (insensible a caja) del correo o nombre completos. */
const containsUserData = (
	password: string,
	account: { email: string; firstName: string; lastName: string },
): boolean => {
	const lower = password.toLowerCase();
	return [account.email, account.firstName, account.lastName].some(
		(value) => value.length > 0 && lower.includes(value.toLowerCase()),
	);
};

/**
 * Caso de uso `changeEmail` (cambio autenticado de correo).
 *
 * - `userId` sale del JWT (`requireAuth`), no del body.
 * - Actual incorrecta o cuenta inexistente: mismo 401 especifico (no revela
 *   nada nuevo: la identidad ya esta autenticada).
 * - Mismo correo (ya normalizado): 200 idempotente SIN escribir ni publicar.
 * - Correo ocupado por otro: mismo 409 generico (incluye la carrera 23505).
 * - Efecto atomico: UPDATE del correo + fila outbox `pending` de
 *   `EmailChanged` en UNA transaccion. Sin tokens, sin TTL, sin pendientes:
 *   el cambio es inmediato y lo confirman los consumidores.
 * - Nunca registra PII (emails) ni secretos; solo IDs.
 */
export const makeChangeEmailService = (
	deps: EmailChangeDeps,
): EmailChangeService => {
	return async (input, userId, correlationId) => {
		const account = await requireAccountWithPassword(
			deps,
			userId,
			input.currentPassword,
			LogEvent.EMAIL_CHANGE_FAILED,
			correlationId,
		);

		if (input.newEmail === account.email) {
			deps.logger.info(LogEvent.EMAIL_CHANGED, {
				userId,
				correlationId,
			});
			return { correlationId };
		}

		const taken = await deps.users.findByEmail(input.newEmail);
		if (taken !== null) {
			deps.logger.warn(LogEvent.EMAIL_CHANGE_FAILED, { correlationId });
			throw emailTaken(correlationId);
		}

		const eventId = deps.newEventId();
		const payload: EmailChangedDetail = {
			metadata: {
				eventId,
				eventVersion: "1",
				occurredAt: deps.nowIso(),
				correlationId,
			},
			data: {
				userId,
				oldEmail: account.email,
				newEmail: input.newEmail,
				firstName: account.firstName,
			},
		};

		try {
			const updated = await deps.users.updateEmailWithOutbox({
				userId,
				newEmail: input.newEmail,
				outbox: {
					eventId,
					eventType: "EmailChanged",
					eventVersion: "1",
					correlationId,
					payload,
				},
			});
			if (!updated) {
				deps.logger.warn(LogEvent.EMAIL_CHANGE_FAILED, { correlationId });
				throw wrongCurrentPassword(correlationId);
			}
		} catch (err) {
			if (isUniqueViolation(err)) {
				deps.logger.warn(LogEvent.EMAIL_CHANGE_FAILED, { correlationId });
				throw emailTaken(correlationId);
			}
			throw err;
		}

		deps.logger.info(LogEvent.EMAIL_CHANGED, { userId, correlationId });

		return { correlationId };
	};
};
