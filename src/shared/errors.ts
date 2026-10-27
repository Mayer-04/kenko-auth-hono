import { HttpStatus } from "./http-status.js";

/**
 * Errores de aplicacion con codigo estable y estado HTTP.
 *
 * El `code` viaja al cliente; el `message` es generico y seguro.
 * Los detalles internos (valores PII, SQL, stack) nunca salen en la respuesta:
 * se registran en el servidor con `correlationId`.
 */

export type ErrorCode =
	| "VALIDATION_ERROR"
	| "REGISTER_CONFLICT"
	| "UPDATE_CONFLICT"
	| "PASSWORD_RESET_INVALID"
	| "RATE_LIMITED"
	| "UNAUTHORIZED"
	| "NOT_FOUND"
	| "DB_UNAVAILABLE"
	| "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
	VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
	REGISTER_CONFLICT: HttpStatus.CONFLICT,
	UPDATE_CONFLICT: HttpStatus.CONFLICT,
	PASSWORD_RESET_INVALID: HttpStatus.BAD_REQUEST,
	RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
	UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
	NOT_FOUND: HttpStatus.NOT_FOUND,
	DB_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
	INTERNAL_ERROR: HttpStatus.INTERNAL_ERROR,
};

export class AppError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly correlationId?: string;

	constructor(
		code: ErrorCode,
		message: string,
		options?: { correlationId?: string; cause?: unknown },
	) {
		super(
			message,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "AppError";
		this.code = code;
		this.status = STATUS_BY_CODE[code];
		if (options?.correlationId !== undefined) {
			this.correlationId = options.correlationId;
		}
	}
}

/** Conflicto generico de registro: no distingue email vs documento (anti-enumeracion). */
export const registerConflict = (correlationId: string): AppError => {
	return new AppError(
		"REGISTER_CONFLICT",
		"No se pudo completar el registro.",
		{ correlationId },
	);
};

export const internalError = (
	correlationId: string,
	cause?: unknown,
): AppError => {
	return new AppError(
		"INTERNAL_ERROR",
		"Error interno. Intente de nuevo mas tarde.",
		{
			correlationId,
			cause,
		},
	);
};

/**
 * Token de restablecimiento invalido, expirado o ya usado: UN unico error
 * generico (anti-enumeracion). No distingue el motivo ni revela si existio.
 */
export const invalidResetToken = (correlationId: string): AppError => {
	return new AppError(
		"PASSWORD_RESET_INVALID",
		"El enlace de restablecimiento no es valido o ha expirado.",
		{ correlationId },
	);
};

/** La nueva contrasena es igual a la actual (solo aplica con token valido). */
export const reusedPassword = (correlationId: string): AppError => {
	return new AppError(
		"VALIDATION_ERROR",
		"La contrasena no puede ser igual a la actual.",
		{ correlationId },
	);
};

/**
 * Contrasena actual incorrecta en un endpoint autenticado: mensaje
 * especifico aceptado (no revela nada nuevo: la identidad ya esta
 * autenticada por el JWT). Mismo codigo 401 que el login.
 */
export const wrongCurrentPassword = (correlationId: string): AppError => {
	return new AppError("UNAUTHORIZED", "Contrasena actual incorrecta.", {
		correlationId,
	});
};

/** La nueva contrasena contiene el correo o el nombre del usuario. */
export const passwordWithUserData = (correlationId: string): AppError => {
	return new AppError(
		"VALIDATION_ERROR",
		"La nueva contrasena no puede contener tu correo o tu nombre.",
		{ correlationId },
	);
};

/** Credenciales invalidas: UNICO error generico del login (anti-enumeracion).
 * No distingue usuario inexistente de contrasena incorrecta. */
export const invalidCredentials = (correlationId: string): AppError => {
	return new AppError("UNAUTHORIZED", "Credenciales invalidas.", {
		correlationId,
	});
};

/**
 * Cambio de email a un correo ya registrado: error GENERICO (no revela
 * si el correo existe ni a quien pertenece). Incluye la carrera 23505.
 */
export const emailTaken = (correlationId: string): AppError => {
	return new AppError("UPDATE_CONFLICT", "No se pudo completar el cambio.", {
		correlationId,
	});
};

/** Limite de solicitudes alcanzado (rate limiting). */
export const rateLimitedError = (correlationId: string): AppError => {
	return new AppError(
		"RATE_LIMITED",
		"Demasiadas solicitudes. Intente de nuevo mas tarde.",
		{ correlationId },
	);
};
