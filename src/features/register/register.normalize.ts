/**
 * Normalizacion explicita de entrada (unicas permitidas por el contrato).
 *
 * - `email`: trim + minusculas.
 * - `phone`: a E.164 (10 digitos locales `3…` se asumen Colombia `+57`).
 * - `documentNumber`: trim, sin espacios/puntos/guiones, mayusculas.
 * Nombres, direccion y ciudad solo hacen trim en el esquema: no se altera
 * capitalizacion ni espacios internos a proposito.
 */

export const normalizeEmail = (value: string): string => {
	return value.trim().toLowerCase();
};

/**
 * Normaliza a E.164.
 *
 * Reglas: quita espacios/guiones/puntos/parentesis; `00` inicial pasa a `+`;
 * 10 digitos empezando en `3` se asumen Colombia (`+57`); `57` + 10 digitos
 * pasa a `+57...`; solo digitos de 8-15 se prefijan con `+`. Supuesto
 * confirmado: pais por defecto Colombia.
 */
export const normalizePhoneToE164 = (value: string): string => {
	const cleaned = value.replace(/[\s\-().]/g, "");
	if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
	if (cleaned.startsWith("+")) return cleaned;
	if (/^3\d{9}$/.test(cleaned)) return `+57${cleaned}`;
	if (/^57\d{10}$/.test(cleaned)) return `+${cleaned}`;
	if (/^\d{8,15}$/.test(cleaned)) return `+${cleaned}`;
	return cleaned;
};

/** Trim + sin separadores + mayusculas. */
export const normalizeDocumentNumber = (value: string): string => {
	return value
		.trim()
		.replace(/[\s.-]/g, "")
		.toUpperCase();
};
