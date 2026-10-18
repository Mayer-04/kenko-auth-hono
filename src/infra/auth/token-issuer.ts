import { sign, verify } from 'hono/jwt';

import { newId } from '../../shared/ids.js';

/**
 * Emision y verificacion de access tokens (JWT HS256 via `hono/jwt`).
 *
 * Contrato acordado con los consumidores:
 * - Algoritmo fijado a HS256 en ambos lados; el `alg` del encabezado nunca
 *   decide la verificacion (se rechaza cualquier otro).
 * - Claims: `sub` (= `userId` canonico) + `userId` (compatibilidad),
 *   `firstName`, `email`, `iat`, `exp`, `iss`, `aud`, `jti`.
 * - El secreto son los bytes UTF-8 tal cual del env en todos los servicios.
 * - Sin contrasenas, hashes ni refresh tokens en el payload (legible por
 *   quien tenga el token: firmado, no cifrado).
 */

export const ACCESS_TOKEN_ALG = 'HS256' as const;

/** Milisegundos por segundo (conversion `Date.now()` a tiempo Unix). */
const MS_PER_SEC = 1000;

export type AccessTokenSubject = {
  userId: string;
  firstName: string;
  email: string;
};

export type AccessTokenConfig = {
  secret: string;
  issuer: string;
  audience: string;
  ttlSec: number;
};

export type SignOptions = {
  /** Segundos Unix para pruebas deterministas. Por defecto, ahora. */
  nowSec?: number;
  /** Identificador del token. Por defecto, UUID v7. */
  jti?: string;
};

export type VerifiedAccessToken = AccessTokenSubject & {
  expiresAtSec: number;
  tokenId: string;
};

export type AccessTokenIssuer = {
  sign(subject: AccessTokenSubject, options?: SignOptions): Promise<string>;
  verify(token: string): Promise<VerifiedAccessToken>;
};

export const makeAccessTokenIssuer = (
  config: AccessTokenConfig,
): AccessTokenIssuer => {
  return {
    async sign(subject, options = {}) {
      const nowSec = options.nowSec ?? Math.floor(Date.now() / MS_PER_SEC);
      const payload = {
        sub: subject.userId,
        userId: subject.userId,
        firstName: subject.firstName,
        email: subject.email,
        iss: config.issuer,
        aud: config.audience,
        iat: nowSec,
        exp: nowSec + config.ttlSec,
        jti: options.jti ?? newId(),
      };
      return sign(payload, config.secret, ACCESS_TOKEN_ALG);
    },

    async verify(token) {
      const payload = (await verify(token, config.secret, {
        alg: ACCESS_TOKEN_ALG,
        iss: config.issuer,
        aud: config.audience,
      })) as Record<string, unknown>;

      const userId = payload.userId;
      const firstName = payload.firstName;
      const email = payload.email;
      const exp = payload.exp;
      const jti = payload.jti;
      if (
        typeof userId !== 'string' ||
        typeof firstName !== 'string' ||
        typeof email !== 'string' ||
        typeof exp !== 'number' ||
        typeof jti !== 'string'
      ) {
        throw new Error('Access token sin claims de identidad validos.');
      }
      return { userId, firstName, email, expiresAtSec: exp, tokenId: jti };
    },
  };
};
