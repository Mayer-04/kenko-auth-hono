import { HttpStatus } from './http-status.js';

/**
 * Errores de aplicacion con codigo estable y estado HTTP.
 *
 * El `code` viaja al cliente; el `message` es generico y seguro.
 * Los detalles internos (valores PII, SQL, stack) nunca salen en la respuesta:
 * se registran en el servidor con `correlationId`.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'REGISTER_CONFLICT'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'DB_UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  REGISTER_CONFLICT: HttpStatus.CONFLICT,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  DB_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  INTERNAL_ERROR: HttpStatus.INTERNAL_ERROR,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly correlationId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { correlationId?: string; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (options?.correlationId !== undefined) {
      this.correlationId = options.correlationId;
    }
  }
}

/** Conflicto generico de registro: no distingue email vs documento (anti-enumeracion). */
export const registerConflict = (correlationId: string): AppError => {
  return new AppError(
    'REGISTER_CONFLICT',
    'No se pudo completar el registro.',
    { correlationId },
  );
};

export const internalError = (
  correlationId: string,
  cause?: unknown,
): AppError => {
  return new AppError(
    'INTERNAL_ERROR',
    'Error interno. Intente de nuevo mas tarde.',
    {
      correlationId,
      cause,
    },
  );
};
