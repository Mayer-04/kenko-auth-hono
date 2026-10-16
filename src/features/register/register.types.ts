import type { DocumentType, Gender } from '../user/user.types.js';

/**
 * Dominio del caso de uso `register`.
 *
 * La identidad/persona vive en `features/user` y se reutiliza aqui:
 * `RegisterInput` es la forma del formulario y `UserRegisteredDetail` el
 * contrato del evento (AGENTS.md 5.3).
 */

/** Entrada ya normalizada lista para reglas de negocio. */
export type RegisterInput = {
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: Gender;
  email: string;
  phone: string;
  addressLine: string;
  city: string;
  documentType: DocumentType;
  documentNumber: string;
  password: string;
};

/** Resultado del caso de uso. Solo IDs, sin PII. */
export type RegisterResult = {
  userId: string;
  correlationId: string;
};

/** Contenido de `Detail` del evento `UserRegistered` (contrato AGENTS.md 5.3). */
export type UserRegisteredDetail = {
  metadata: {
    eventId: string;
    eventVersion: '1';
    occurredAt: string;
    correlationId: string;
  };
  data: {
    userId: string;
    document: { type: DocumentType; number: string };
    person: {
      firstName: string;
      lastName: string;
      birthDate: string;
      gender: Gender;
    };
    contact: { email: string; emailVerified: boolean; phone: string };
    address: { line: string; city: string };
  };
};
