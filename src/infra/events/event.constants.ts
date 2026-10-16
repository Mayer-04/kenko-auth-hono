/**
 * Constantes del contrato de eventos de autenticacion (AGENTS.md 5.3).
 *
 * `features/` no importa de aqui: el servicio de registro usa sus propios
 * literales del contrato (pasaran a `features/user` en el paso 3). Este
 * modulo es para `infra/events` y repositorios.
 */

/** `Source` del envelope `PutEvents`. */
export const AUTH_SOURCE = 'kenko.auth';

/** `DetailType` del registro. */
export const USER_REGISTERED_TYPE = 'UserRegistered';

/** Agregado dueño de la outbox. */
export const USER_AGGREGATE_TYPE = 'user';

/** Bus de desarrollo (mismo valor que el default de `EnvSchema`). */
export const DEFAULT_EVENT_BUS_NAME = 'kenko-dev-bus';

/** Estados de la outbox: `pending` / `sent` / `dead` (revision manual). */
export const OutboxStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  DEAD: 'dead',
} as const;

export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];
