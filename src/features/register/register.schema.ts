import { z } from "zod";
import { DOCUMENT_TYPES, GENDERS } from "../user/user.types.js";
import { COMMON_PASSWORDS, RegisterLimits } from "./register.limits.js";
import {
	normalizeDocumentNumber,
	normalizeEmail,
	normalizePhoneToE164,
} from "./register.normalize.js";

/**
 * Validacion de entrada para `POST /auth/register`.
 *
 * Capas separadas:
 * - Aqui: forma y normalizacion explicita con regla clara.
 * - Servicio: reglas de negocio (unicidad).
 * - DB: restricciones de unicidad como ultima defensa.
 *
 * Normalizaciones aplicadas (unicas permitidas):
 * - `email`: trim + minusculas.
 * - `phone`: a E.164 (ver `normalizePhoneToE164`).
 * - `documentType`: trim + mayusculas. `documentNumber`: trim, sin
 *   espacios/puntos/guiones, mayusculas.
 * - Nombres, direccion, ciudad: solo trim. No se colapsan espacios ni se
 *   altera capitalizacion a proposito.
 * - `password`: sin normalizacion; los espacios cuentan.
 */

const LETTER = /\p{L}/u;
const E164 = new RegExp(
	`^\\+[1-9]\\d{${RegisterLimits.PHONE_E164_MIN_DIGITS},${RegisterLimits.PHONE_E164_MAX_DIGITS}}$`,
);

const utcToday = (): string => {
	return new Date().toISOString().slice(0, 10);
};

const minusYears = (dateStr: string, years: number): string => {
	const [y, m, d] = dateStr.split("-").map(Number);
	return `${String((y ?? 0) - years).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

const nameField = (label: string) =>
	z
		.string()
		.trim()
		.min(1, `${label} es obligatorio.`)
		.max(
			RegisterLimits.NAME_MAX_LENGTH,
			`${label} no puede superar 100 caracteres.`,
		)
		.refine(
			(v) => LETTER.test(v),
			`${label} debe contener al menos una letra.`,
		);

/**
 * Campo de contrasena reutilizable (min 8, max 128, deny-list).
 *
 * Unica fuente de las reglas de contrasena: `register` y `passwordreset`
 * importan este esquema; `confirmPassword` solo valida y nunca se persiste.
 */
export const PasswordFieldSchema = z
	.string()
	.min(
		RegisterLimits.PASSWORD_MIN_LENGTH,
		"La contrasena debe tener al menos 8 caracteres.",
	)
	.max(
		RegisterLimits.PASSWORD_MAX_LENGTH,
		"La contrasena no puede superar 128 caracteres.",
	)
	.refine(
		(v) => !COMMON_PASSWORDS.has(v.toLowerCase()),
		"Elija una contrasena menos comun.",
	);

/** Regex del numero de documento (mismas reglas que en registro). */
export const documentNumberRegex = (): RegExp => {
	return new RegExp(
		`^[A-Z0-9]{${RegisterLimits.DOCUMENT_NUMBER_MIN_LENGTH},${RegisterLimits.DOCUMENT_NUMBER_MAX_LENGTH}}$`,
	);
};

export const RegisterInputSchema = z.object({
	firstName: nameField("Nombres"),
	lastName: nameField("Apellidos"),
	birthDate: z.iso
		.date()
		.refine(
			(v) => v <= utcToday(),
			"La fecha de nacimiento no puede ser futura.",
		)
		.refine(
			(v) => v >= minusYears(utcToday(), RegisterLimits.BIRTH_MAX_AGE_YEARS),
			"La fecha de nacimiento no es coherente.",
		),
	gender: z.enum(GENDERS),
	email: z.preprocess(
		(v) => (typeof v === "string" ? normalizeEmail(v) : v),
		z.email().max(RegisterLimits.EMAIL_MAX_LENGTH),
	),
	phone: z.preprocess(
		(v) => (typeof v === "string" ? normalizePhoneToE164(v) : v),
		z
			.string()
			.regex(E164, "Telefono invalido. Use formato internacional E.164."),
	),
	addressLine: z
		.string()
		.trim()
		.min(1, "Direccion es obligatoria.")
		.max(RegisterLimits.ADDRESS_MAX_LENGTH),
	city: z
		.string()
		.trim()
		.min(1, "Ciudad es obligatoria.")
		.max(RegisterLimits.CITY_MAX_LENGTH),
	documentType: z.preprocess(
		(v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
		z.enum(DOCUMENT_TYPES),
	),
	documentNumber: z.preprocess(
		(v) => (typeof v === "string" ? normalizeDocumentNumber(v) : v),
		z.string().regex(documentNumberRegex(), "Numero de documento invalido."),
	),
	password: PasswordFieldSchema,
	confirmPassword: z.string(),
});

export const RegisterSchema = RegisterInputSchema.refine(
	(v) => v.password === v.confirmPassword,
	{ path: ["confirmPassword"], message: "Las contrasenas no coinciden." },
);

export type RegisterRequest = z.infer<typeof RegisterSchema>;
