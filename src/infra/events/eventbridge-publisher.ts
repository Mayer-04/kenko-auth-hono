import type { UserRegisteredDetail } from '../../features/register/register.types.js';
import { AUTH_SOURCE, USER_REGISTERED_TYPE } from './event.constants.js';
import { NORMALIZE_MAX_DEPTH } from './relay.constants.js';

export { AUTH_SOURCE, USER_REGISTERED_TYPE } from './event.constants.js';

/**
 * Formato de publicacion (AGENTS.md 5.3).
 *
 * Al publicar se usa el envelope de `PutEvents` (`Source`, `DetailType`,
 * `EventBusName`, `Detail` serializado). No mezclar con el sobre que
 * EventBridge entrega a consumidores (`source`, `detail-type`, `detail`).
 */
export type PutEventsEntry = {
  Source: string;
  DetailType: string;
  EventBusName: string;
  Detail: string;
};

export const toPutEventsEntry = (
  detail: UserRegisteredDetail,
  eventBusName: string,
): PutEventsEntry => {
  return {
    Source: AUTH_SOURCE,
    DetailType: USER_REGISTERED_TYPE,
    EventBusName: eventBusName,
    Detail: JSON.stringify(detail),
  };
};

/**
 * Normaliza el payload leido de la outbox al `Detail` del contrato.
 *
 * Acepta el objeto o su forma serializada (una o varias capas de string).
 * Causa verificada (Bun 1.4.3 + drizzle-orm 0.45.4, Oct-2026): el insert via
 * Drizzle guarda el `jsonb` doblemente codificado (string JSON dentro de
 * string JSON) aunque el parametro construido sea correcto; las lecturas
 * tipadas lo devuelven como objeto, pero la lectura cruda del relay recibe
 * texto. Sin esta normalizacion el `Detail` viajaba entrecomillado (un
 * string, no un objeto) y EventBridge lo rechaza con `MalformedDetail`.
 * Si no se obtiene un objeto con `metadata` y `data`, lanza.
 */
export const normalizeDetail = (payload: unknown): UserRegisteredDetail => {
  let value = payload;
  for (let depth = 0; depth < NORMALIZE_MAX_DEPTH; depth += 1) {
    if (typeof value !== 'string') break;
    try {
      value = JSON.parse(value) as unknown;
    } catch (err) {
      throw new Error('Outbox payload is not valid JSON.', { cause: err });
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Outbox payload is not an object.');
  }
  const detail = value as Record<string, unknown>;
  if (
    typeof detail.metadata !== 'object' ||
    detail.metadata === null ||
    typeof detail.data !== 'object' ||
    detail.data === null
  ) {
    throw new Error('Outbox payload misses metadata/data.');
  }
  return value as UserRegisteredDetail;
};
