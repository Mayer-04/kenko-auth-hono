import { z } from "zod";
import { normalizeDocumentNumber } from "../register/register.normalize.js";
import { documentNumberRegex } from "../register/register.schema.js";
import { DOCUMENT_TYPES } from "../user/user.types.js";
import { LoginLimits } from "./login.limits.js";

/**
 * Validacion de entrada para `POST /auth/login`.
 *
 * Misma normalizacion que registro y recuperacion (sin reglas nuevas):
 * - `documentType`: trim + mayusculas.
 * - `documentNumber`: trim, sin espacios/puntos/guiones, mayusculas.
 * - `password`: sin normalizacion; los espacios cuentan. Solo se exige no
 *   vacia y un tope de longitud (las reglas de complejidad aplican al
 *   crearla, no al validarla aqui).
 */
export const LoginSchema = z.object({
	documentType: z.preprocess(
		(value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
		z.enum(DOCUMENT_TYPES),
	),
	documentNumber: z.preprocess(
		(value) =>
			typeof value === "string" ? normalizeDocumentNumber(value) : value,
		z.string().regex(documentNumberRegex(), "Numero de documento invalido."),
	),
	password: z
		.string()
		.min(1, "Credenciales invalidas.")
		.max(LoginLimits.PASSWORD_MAX_LENGTH, "Credenciales invalidas."),
});

export type LoginRequest = z.infer<typeof LoginSchema>;

/**
 * Validacion de entrada para `POST /auth/refresh` y `POST /auth/logout`.
 *
 * El token es opaco: NO se valida su formato aqui; cualquier cadena se
 * hashea y se busca por hash. Un token basura simplemente no coincide y
 * produce el 401 generico (anti-enumeracion). Llega en el BODY, nunca en
 * la URL.
 */
const RefreshTokenSchema = z.object({
	refreshToken: z.string().min(1, "Credenciales invalidas."),
});

export const RefreshSchema = RefreshTokenSchema;
export const LogoutSchema = RefreshTokenSchema;

export type RefreshRequest = z.infer<typeof RefreshSchema>;
export type LogoutRequest = z.infer<typeof LogoutSchema>;
