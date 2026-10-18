import type { AuthSessionRecord, LoginIdentity } from './login.types.js';

/**
 * Puertos que los casos de uso de `login` necesitan. `features/` declara
 * interfaces; `container.ts` inyecta implementaciones de `infra/`.
 *
 * Decisiones:
 * - `PasswordVerifier` (solo `verify`) en vez de reutilizar el
 *   `PasswordHasher` de `register`: evita acoplar `login` a otro caso de
 *   uso. El mismo hasher Argon2id satisface ambas interfaces.
 * - `CredentialsStore` separado de `UserRepository`: trae `firstName` para
 *   los claims sin modificar el repositorio ni los tests de `register`.
 */

/** Verifica contrasenas. Lo implementa el hasher Argon2id existente. */
export type PasswordVerifier = {
  verify(hash: string, password: string): Promise<boolean>;
};

/** Credenciales minimas para autenticar y emitir claims. */
export type LoginCredentials = {
  id: string;
  firstName: string;
  email: string;
  passwordHash: string;
};

export type CredentialsStore = {
  findByDocument(
    type: string,
    number: string,
  ): Promise<LoginCredentials | null>;
  findById(id: string): Promise<Omit<LoginCredentials, 'passwordHash'> | null>;
};

/** Datos para abrir una fila de sesion (el hash, nunca el crudo). */
export type NewSession = {
  id: string;
  familyId: string;
  userId: string;
  refreshHash: string;
  expiresAt: string;
};

/** `rotated`: exito. `stale`: la fila ya no estaba activa (carrera o reuso). */
export type RotateOutcome = 'rotated' | 'stale';

export type SessionStore = {
  create(input: NewSession): Promise<void>;
  findByRefreshHash(hash: string): Promise<AuthSessionRecord | null>;
  rotate(args: {
    sessionId: string;
    newSession: NewSession;
    nowIso: string;
  }): Promise<RotateOutcome>;
  revokeSession(id: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  /**
   * Purga por lotes las sesiones muertas: `rotated`/`revoked` no usadas
   * desde hace `retentionDays`, o vencidas hace mas de `retentionDays`.
   * El reloj es el de la DB (`NOW()`), no el de la app. Devuelve borradas.
   */
  purgeStale(retentionDays: number, limit: number): Promise<number>;
};

/** Firma de access tokens. Lo implementa el issuer HS256 de `infra/auth`. */
export type AccessTokenSigner = {
  sign(
    subject: LoginIdentity,
    options?: { nowSec?: number; jti?: string },
  ): Promise<string>;
};

/** Genera refresh opacos y sus hashes. Lo implementa `infra/auth`. */
export type RefreshTokenFactory = {
  generate(): string;
  hash(token: string): string;
};
