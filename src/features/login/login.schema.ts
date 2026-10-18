import { z } from 'zod';

import { DOCUMENT_TYPES } from '../user/user.types.js';
import { LoginLimits } from './login.limits.js';

/**
 * Validacion de entrada para `POST /auth/login`.
 *
 * Misma normalizacion de documento que en `register` (tipo en mayusculas;
 * numero sin espacios/puntos/guiones, en mayusculas), duplicada a proposito
 * para no acoplar esta feature a la de registro. La contrasena no se
 * normaliza: los espacios cuentan, igual que al registrarla.
 */

const DOCUMENT_NUMBER = new RegExp(
  `^[A-Z0-9]{${LoginLimits.DOCUMENT_NUMBER_MIN_LENGTH},${LoginLimits.DOCUMENT_NUMBER_MAX_LENGTH}}$`,
);

export const LoginSchema = z.object({
  documentType: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(DOCUMENT_TYPES),
  ),
  documentNumber: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .trim()
            .replace(/[\s.-]/g, '')
            .toUpperCase()
        : v,
    z.string().regex(DOCUMENT_NUMBER, 'Numero de documento invalido.'),
  ),
  password: z
    .string()
    .min(1, 'La contrasena es obligatoria.')
    .max(LoginLimits.PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof LoginSchema>;
