import type { DocumentType } from '../user/user.types.js';

/**
 * Dominio del caso de uso `login`.
 *
 * El documento (tipo + numero) es el identificador visible de acceso y la
 * contrasena se verifica con el `PasswordHasher` existente (Argon2id).
 * Ni la contrasena ni su hash salen nunca de la capa de verificacion.
 */

/** Entrada ya normalizada lista para reglas de negocio. */
export type LoginInput = {
  documentType: DocumentType;
  documentNumber: string;
  password: string;
};

/** Identidad minima que viaja en los claims del access token. */
export type LoginIdentity = {
  userId: string;
  firstName: string;
  email: string;
};

/** Resultado del caso de uso. El refresh crudo solo vive lo necesario. */
export type LoginResult = {
  identity: LoginIdentity;
  accessToken: string;
  /** Segundos de vigencia del access token (para `expiresIn` y la cookie). */
  accessTokenExpiresInSec: number;
  /** Refresh opaco de un solo uso (rotacion). Se entrega via cookie. */
  refreshToken: string;
  /** Instante UTC de vencimiento del refresh (ISO). */
  refreshExpiresAt: string;
};

/**
 * Estados de una fila de `auth_sessions`.
 *
 * - `active`: refresh vigente, unico utilizable de su familia.
 * - `rotated`: ya se uso para rotar; volver a presentarlo es reutilizacion
 *   sospechosa y revoca la familia completa.
 * - `revoked`: invalidado por logout, expiracion o robo. Reutilizarlo es 401.
 */
export const AuthSessionStatus = {
  ACTIVE: 'active',
  ROTATED: 'rotated',
  REVOKED: 'revoked',
} as const;

export type AuthSessionStatus =
  (typeof AuthSessionStatus)[keyof typeof AuthSessionStatus];

/** Proyeccion de una fila de `auth_sessions` para los casos de uso. */
export type AuthSessionRecord = {
  id: string;
  familyId: string;
  userId: string;
  refreshHash: string;
  status: string;
  expiresAt: string;
};
