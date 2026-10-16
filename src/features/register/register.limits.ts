/**
 * Limites de validacion de `register`.
 *
 * Separados del esquema para nombrar cada numero con su intencion.
 * Cambiar un limite aqui cambia el mensaje que lo usa de forma coherente;
 * los textos de mensaje se mantienen para no alterar el contrato de error.
 */
export const RegisterLimits = {
  NAME_MAX_LENGTH: 100,
  EMAIL_MAX_LENGTH: 254,
  PASSWORD_MIN_LENGTH: 8,
  PASSWORD_MAX_LENGTH: 128,
  DOCUMENT_NUMBER_MIN_LENGTH: 4,
  DOCUMENT_NUMBER_MAX_LENGTH: 20,
  ADDRESS_MAX_LENGTH: 200,
  CITY_MAX_LENGTH: 100,
  BIRTH_MAX_AGE_YEARS: 120,
  /** Digitos tras el primer digito en E.164 (`^\+[1-9]\d{7,14}$`: 8-15 digitos). */
  PHONE_E164_MIN_DIGITS: 7,
  PHONE_E164_MAX_DIGITS: 14,
} as const;

/**
 * Contrasenas demasiado comunes (comparacion en minusculas).
 * Lista minima inicial; ampliar sin tocar el esquema.
 */
export const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'colombia123',
  'kenko1234',
]);
