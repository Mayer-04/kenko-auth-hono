import type { PasswordHasher } from '../register/register.port.js';
import type {
  ForgotInput,
  PasswordResetRequestedDetail,
  PasswordResetResult,
  ResetInput,
} from './passwordreset.types.js';

/**
 * Puertos que los casos de uso de recuperacion necesitan.
 * `features/` declara interfaces; `container.ts` inyecta `infra/`.
 */

/**
 * Herramientas criptograficas del token (inyectadas):
 * - `generate`: token opaco aleatorio (CSPRNG, base64url). No es JWT.
 * - `hash`: hash irreversible (SHA-256) guardado en DB. La validacion se
 *   hace por busqueda del hash unico, sin comparacion en tiempo constante.
 */
export type ResetTokenTool = {
  generate(): string;
  hash(token: string): string;
};

/**
 * Logger minimo que el feature necesita (solo IDs).
 * El contenedor lo implementa con Winston; los tests usan un fake que
 * verifica que nunca se registre PII, token ni password.
 */
export type PasswordResetLogger = {
  info(event: string, ids: Record<string, string>): void;
  warn(event: string, ids: Record<string, string>): void;
};

/** Persistencia de tokens y sus eventos, atomica en ambas operaciones. */
export type PasswordResetRepository = {
  /**
   * Atomica: invalida los tokens anteriores del usuario, inserta el nuevo
   * (`token_hash` unico) y la fila outbox `pending` del evento, en UNA
   * transaccion. O bien persiste todo, o no persiste nada.
   */
  createTokenWithOutbox(args: {
    token: {
      id: string;
      userId: string;
      tokenHash: string;
      expiresAt: string;
      correlationId: string;
    };
    outbox: {
      eventId: string;
      eventType: 'PasswordResetRequested';
      eventVersion: '1';
      correlationId: string;
      payload: PasswordResetRequestedDetail;
    };
  }): Promise<void>;

  /** Token activo (no usado, no invalidado, no expirado) por su hash. */
  findActiveTokenByHash(tokenHash: string): Promise<{ userId: string } | null>;

  /**
   * Consumo ATOMICO: la actualizacion condicional del token (no usado y no
   * expirado), el cambio del hash de contrasena y la invalidacion de los
   * demas tokens pendientes del usuario ocurren en UNA transaccion.
   * `false` si otro request concurrente gano la carrera: solo uno tiene exito.
   *
   * Punto de extension (login/MFA, fuera de alcance hoy): cuando existan
   * sesiones y refresh tokens, la revocacion de todas las sesiones del
   * usuario debe ocurrir AQUI, en esta misma transaccion. Lo mismo aplica a
   * cualquier paso que exija la politica MFA vigente.
   */
  consumeTokenAndUpdatePassword(args: {
    tokenHash: string;
    userId: string;
    passwordHash: string;
  }): Promise<boolean>;
};

/** Consultas sobre `users` que este feature necesita (via `features/user`). */
export type PasswordResetUserReader = {
  findByDocument(
    type: string,
    number: string,
  ): Promise<{
    id: string;
    email: string;
    firstName: string;
  } | null>;
  findUserById(
    id: string,
  ): Promise<{ id: string; passwordHash: string } | null>;
};

export type ForgotDeps = {
  users: PasswordResetUserReader;
  tokens: PasswordResetRepository;
  tokenTool: ResetTokenTool;
  newTokenId: () => string;
  newEventId: () => string;
  now: () => Date;
  ttlMinutes: number;
  /** Base del portal para construir `data.resetUrl` (`.../reset#token=...`). */
  baseUrl: string;
  logger: PasswordResetLogger;
};

export type ForgotService = (
  input: ForgotInput,
  correlationId: string,
) => Promise<PasswordResetResult>;

export type ResetDeps = {
  users: PasswordResetUserReader;
  tokens: PasswordResetRepository;
  hasher: PasswordHasher;
  tokenTool: ResetTokenTool;
  logger: PasswordResetLogger;
};

export type ResetService = (
  input: ResetInput,
  correlationId: string,
) => Promise<PasswordResetResult>;
