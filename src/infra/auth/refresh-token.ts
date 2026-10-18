import { createHash, randomBytes } from 'node:crypto';

import type { RefreshTokenFactory } from '../../features/login/login.port.js';

/**
 * Refresh tokens opacos.
 *
 * No son JWT a proposito: la revocacion y la rotacion exigen estado en el
 * servidor. El valor crudo es aleatorio (32 bytes) y solo se conserva su
 * hash SHA-256 en la base de datos; el crudo vive lo minimo (entrega al
 * cliente via cookie `HttpOnly`). Nunca se registra en logs.
 */

const REFRESH_TOKEN_BYTES = 32;

export const newRefreshToken = (): string => {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
};

export const hashRefreshToken = (token: string): string => {
  return createHash('sha256').update(token, 'utf8').digest('hex');
};

/** Adaptador del puerto: las funciones puras de arriba como fabrica. */
export const makeRefreshTokenFactory = (): RefreshTokenFactory => {
  return { generate: newRefreshToken, hash: hashRefreshToken };
};
