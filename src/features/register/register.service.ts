import { registerConflict } from '../../shared/errors.js';
import type { RegisterDeps, RegisterService } from './register.port.js';
import type { RegisterInput, UserRegisteredDetail } from './register.types.js';

/**
 * Caso de uso `Register`.
 *
 * - Puro en reglas: no importa `infra/`, recibe puertos.
 * - Verifica unicidad en app (email y documento) y delega la defensa final
 *   a las restricciones UNIQUE de DB (carrera concurrente -> 409 generico).
 * - Respuesta anti-enumeracion: cualquier duplicado es el mismo 409 generico,
 *   sin distinguir campo. Compromiso documentado: menos UX a cambio de no
 *   revelar que email/documento ya existe (Ley 1581).
 * - Nunca registra PII ni el hash; el llamador loguea solo IDs.
 */
export const makeRegisterService = (deps: RegisterDeps): RegisterService => {
  return async (input: RegisterInput, correlationId: string) => {
    const userId = deps.newUserId();
    const eventId = deps.newEventId();
    const occurredAt = deps.nowIso();

    const [byEmail, byDocument] = await Promise.all([
      deps.users.findByEmail(input.email),
      deps.users.findByDocument(input.documentType, input.documentNumber),
    ]);
    if (byEmail !== null || byDocument !== null) {
      throw registerConflict(correlationId);
    }

    const passwordHash = await deps.hasher.hash(input.password);

    const payload: UserRegisteredDetail = {
      metadata: { eventId, eventVersion: '1', occurredAt, correlationId },
      data: {
        userId,
        document: { type: input.documentType, number: input.documentNumber },
        person: {
          firstName: input.firstName,
          lastName: input.lastName,
          birthDate: input.birthDate,
          gender: input.gender,
        },
        contact: {
          email: input.email,
          emailVerified: false,
          phone: input.phone,
        },
        address: { line: input.addressLine, city: input.city },
      },
    };

    try {
      await deps.users.createWithOutbox({
        user: {
          id: userId,
          email: input.email,
          documentType: input.documentType,
          documentNumber: input.documentNumber,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          birthDate: input.birthDate,
          gender: input.gender,
          phone: input.phone,
          addressLine: input.addressLine,
          city: input.city,
        },
        outbox: {
          eventId,
          eventType: 'UserRegistered',
          eventVersion: '1',
          correlationId,
          payload,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw registerConflict(correlationId);
      throw err;
    }

    return { userId, correlationId };
  };
};

/** Postgres 23505 (UNIQUE). Evita acoplar el servicio a Drizzle. */
const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === '23505'
  );
};
