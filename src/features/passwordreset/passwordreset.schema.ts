import { z } from 'zod';
import { normalizeDocumentNumber } from '../register/register.normalize.js';
import {
  documentNumberRegex,
  PasswordFieldSchema,
} from '../register/register.schema.js';
import { DOCUMENT_TYPES } from '../user/user.types.js';

/**
 * Validacion de entrada para los endpoints de recuperacion.
 *
 * Mismas capas que en registro: aqui solo forma y normalizacion explicita;
 * el servicio aplica reglas de negocio y la DB es la ultima defensa.
 *
 * Normalizaciones (las mismas que en registro, sin reglas nuevas):
 * - `documentType`: trim + mayusculas.
 * - `documentNumber`: trim, sin espacios/puntos/guiones, mayusculas.
 * - `password`: sin normalizacion; los espacios cuentan.
 * - `token`: NO se valida su formato aqui; cualquier cadena se hashea y se
 *   busca por hash. Un token basura simplemente no coincide y produce el
 *   unico error generico `PASSWORD_RESET_INVALID` (anti-enumeracion).
 */

export const ForgotPasswordSchema = z.object({
  documentType: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(DOCUMENT_TYPES),
  ),
  documentNumber: z.preprocess(
    (v) => (typeof v === 'string' ? normalizeDocumentNumber(v) : v),
    z.string().regex(documentNumberRegex(), 'Numero de documento invalido.'),
  ),
});

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Token invalido.'),
    password: PasswordFieldSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Las contrasenas no coinciden.',
  });

export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordSchema>;
