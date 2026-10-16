import winston from 'winston';

import { SERVICE_NAME } from '../shared/service.js';
import type { Environment } from './env.js';

/**
 * Logger unico del servicio (Winston).
 *
 * - JSON estructurado con `service`, `timestamp` y `level`.
 * - Nunca registrar contrasenas, tokens, secretos ni PII completa
 *   (documento, direccion, telefono, correo). Los llamadores pasan solo
 *   `correlationId`, `userId`, `eventId` u otros IDs no sensibles.
 * - `src/config/env.ts` no usa este logger a proposito: debe funcionar
 *   antes de que exista configuracion valida.
 */

let rootLogger: winston.Logger | undefined;

const levelFor = (environment: Environment): string => {
  if (environment === 'production') return 'info';
  if (environment === 'test') return 'warn';
  return 'debug';
};

export const initLogger = (environment: Environment): winston.Logger => {
  if (rootLogger !== undefined) return rootLogger;

  rootLogger = winston.createLogger({
    level: levelFor(environment),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    defaultMeta: { service: SERVICE_NAME },
    transports: [new winston.transports.Console()],
  });

  return rootLogger;
};

export const getLogger = (): winston.Logger => {
  if (rootLogger === undefined) {
    throw new Error('Logger no inicializado. Llame a initLogger() primero.');
  }
  return rootLogger;
};

/** Logger hijo con correlacion, sin PII. */
export const withCorrelation = (correlationId: string): winston.Logger => {
  return getLogger().child({ correlationId });
};
