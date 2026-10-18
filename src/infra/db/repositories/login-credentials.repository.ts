import { and, eq } from 'drizzle-orm';

import type { CredentialsStore } from '../../../features/login/login.port.js';
import type { DbClient } from '../client.js';
import { users } from '../schema/index.js';

/**
 * Credenciales para `login`, separadas de `UserRepository` a proposito.
 *
 * `register` solo necesita existencia (email/documento); `login` necesita
 * `firstName` para los claims. Extender el repositorio compartido rompería
 * sus fakes y tests, asi que este adaptador consulta solo lo necesario:
 * `id`, `firstName`, `email` y `passwordHash` por documento.
 */
export const makeLoginCredentialsRepository = (
  client: DbClient,
): CredentialsStore => {
  const { db } = client;

  return {
    async findByDocument(type: string, number: string) {
      const rows = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          email: users.email,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(
          and(eq(users.documentType, type), eq(users.documentNumber, number)),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        firstName: row.firstName,
        email: row.email,
        passwordHash: row.passwordHash,
      };
    },

    async findById(id: string) {
      const rows = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          email: users.email,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { id: row.id, firstName: row.firstName, email: row.email };
    },
  };
};
