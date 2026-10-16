import type { UserRegisteredDetail } from '../register/register.types.js';

/**
 * Puerto de persistencia de usuarios.
 *
 * Vive en `features/user` porque describe la entidad `User`, no el caso
 * de uso que la crea. `container.ts` inyecta la implementacion de `infra/`.
 * `createWithOutbox` es atomica: usuario + evento `pending` en una transaccion.
 */
export type StoredUser = {
  id: string;
  email: string;
  documentType: string;
  documentNumber: string;
  passwordHash: string;
};

export type UserRepository = {
  findByEmail(email: string): Promise<StoredUser | null>;
  findByDocument(type: string, number: string): Promise<StoredUser | null>;
  createWithOutbox(args: {
    user: Omit<StoredUser, 'id'> & {
      id: string;
      firstName: string;
      lastName: string;
      birthDate: string;
      gender: string;
      phone: string;
      addressLine: string;
      city: string;
    };
    outbox: {
      eventId: string;
      eventType: 'UserRegistered';
      eventVersion: '1';
      correlationId: string;
      payload: UserRegisteredDetail;
    };
  }): Promise<void>;
};
