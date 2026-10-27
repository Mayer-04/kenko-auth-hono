import type { PasswordHasher } from "../register/register.port.js";
import type {
	ChangeEmailInput,
	ChangeEmailResult,
	ChangePasswordInput,
	ChangePasswordResult,
	EmailChangedDetail,
} from "./account.types.js";

/**
 * Puertos que el caso de uso de cambio de contrasena necesita.
 * `features/` declara interfaces; `container.ts` inyecta `infra/`
 * (`makeUserRepository` implementa ambas: metodos extra invisibles
 * para `register`, que solo ve `UserRepository`).
 */

/** Lectura de credenciales y datos para la politica (proyeccion minima). */
export type AccountRecord = {
	id: string;
	email: string;
	firstName: string;
	lastName: string;
	passwordHash: string;
};

export type AccountReader = {
	findAccountById(id: string): Promise<AccountRecord | null>;
};

/** Solo necesita saber si el correo ya pertenece a alguien (`id`). */
export type EmailTakenReader = {
	findByEmail(email: string): Promise<{ id: string } | null>;
};

/**
 * Escritura atomica del cambio: hash nuevo + revocacion de sesiones
 * `active` ajenas a la familia actual + invalidacion de tokens de
 * restablecimiento pendientes, en UNA transaccion. `false` si el usuario
 * ya no existe. Sin `keepFamilyId` (token pre-`sid`) revoca TODO,
 * incluida la actual: el cliente debe volver a loguearse.
 */
export type PasswordChangeStore = {
	changePasswordAndRevokeOthers(args: {
		userId: string;
		passwordHash: string;
		keepFamilyId: string | undefined;
		correlationId: string;
	}): Promise<boolean>;
};

export type AccountStore = AccountReader & PasswordChangeStore;

/**
 * Logger minimo que el feature necesita (solo IDs).
 * El contenedor lo implementa con Winston; los tests usan un fake.
 */
export type AccountLogger = {
	info(event: string, ids: Record<string, string>): void;
	warn(event: string, ids: Record<string, string>): void;
};

export type ChangePasswordDeps = {
	users: AccountStore;
	hasher: PasswordHasher;
	logger: AccountLogger;
};

export type ChangePasswordService = (
	input: ChangePasswordInput,
	userId: string,
	keepFamilyId: string | undefined,
	correlationId: string,
) => Promise<ChangePasswordResult>;

/**
 * Escritura atomica del cambio de email: UPDATE del correo + fila outbox
 * `pending` del evento `EmailChanged` en UNA transaccion. `false` si el
 * usuario ya no existe. Un 23505 (carrera por el mismo correo) lo mapea
 * el servicio al 409 generico.
 */
export type EmailChangeStore = {
	updateEmailWithOutbox(args: {
		userId: string;
		newEmail: string;
		outbox: {
			eventId: string;
			eventType: "EmailChanged";
			eventVersion: "1";
			correlationId: string;
			payload: EmailChangedDetail;
		};
	}): Promise<boolean>;
};

export type EmailChangeDeps = {
	users: AccountReader & EmailTakenReader & EmailChangeStore;
	hasher: PasswordHasher;
	newEventId: () => string;
	nowIso: () => string;
	logger: AccountLogger;
};

export type EmailChangeService = (
	input: ChangeEmailInput,
	userId: string,
	correlationId: string,
) => Promise<ChangeEmailResult>;
