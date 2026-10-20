import { createHash, randomBytes } from 'node:crypto';

import type { ResetTokenTool } from '../../features/passwordreset/passwordreset.port.js';

/**
 * Token de restablecimiento: opaco, aleatorio (CSPRNG de `node:crypto`),
 * base64url. NO es JWT: no lleva claims ni firma verificable; su validez
 * se determina unicamente por la fila en base de datos.
 *
 * El hash almacenado es SHA-256 en hex. Es correcto aqui a proposito: el
 * token ya tiene 256 bits de entropia aleatoria, por lo que no necesita
 * una KDF lenta como Argon2 (que protege contraseñas de baja entropia).
 * La validacion es una busqueda por `token_hash` unico, sin comparacion
 * en tiempo constante.
 *
 * Nunca se registra el token ni el hash.
 */

export const SHA256_HEX_LENGTH = 64;

export const makeResetTokenTool = (
  randomBytesCount: number,
): ResetTokenTool => {
  return {
    generate(): string {
      return randomBytes(randomBytesCount).toString('base64url');
    },
    hash(token: string): string {
      return createHash('sha256').update(token).digest('hex');
    },
  };
};
