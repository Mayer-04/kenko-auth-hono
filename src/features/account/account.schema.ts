import { z } from "zod";
import { RegisterLimits } from "../register/register.limits.js";
import { normalizeEmail } from "../register/register.normalize.js";
import { PasswordFieldSchema } from "../register/register.schema.js";

/**
 * Validacion de entrada para `POST /auth/password/change`.
 *
 * - `confirmPassword` NO existe aqui a proposito: se valida solo en el
 *   frontend (decision de diseno). El backend es la ultima palabra sobre
 *   la politica, no sobre el tecleo.
 * - `newPassword` reutiliza la politica vigente (`PasswordFieldSchema`:
 *   min 8, max 128, deny-list). Las reglas de negocio (distinta a la actual,
 *   sin datos del usuario) viven en el servicio, no aqui.
 */
export const ChangePasswordSchema = z.object({
	currentPassword: z.string().min(1, "La contrasena actual es obligatoria."),
	newPassword: PasswordFieldSchema,
});

export type ChangePasswordRequest = z.infer<typeof ChangePasswordSchema>;

/**
 * Validacion de entrada para `POST /auth/email/change`.
 *
 * - `newEmail`: misma normalizacion que en registro (trim + minusculas).
 * - `currentPassword`: obligatoria; la verifica el servicio contra el hash.
 */
export const ChangeEmailSchema = z.object({
	newEmail: z.preprocess(
		(value) => (typeof value === "string" ? normalizeEmail(value) : value),
		z.email().max(RegisterLimits.EMAIL_MAX_LENGTH),
	),
	currentPassword: z.string().min(1, "La contrasena actual es obligatoria."),
});
