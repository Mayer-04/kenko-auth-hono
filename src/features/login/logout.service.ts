import type { RefreshTokenFactory, SessionStore } from './login.port.js';

export type LogoutDeps = {
  sessions: SessionStore;
  refresher: RefreshTokenFactory;
};

export type LogoutResult = {
  revoked: boolean;
};

export type LogoutService = (
  refreshToken: string | undefined,
) => Promise<LogoutResult>;

/**
 * Caso de uso `logout`: cierra solo la sesion actual.
 *
 * Idempotente a proposito: cookie ausente o token desconocido responden
 * igual (`revoked: false`) sin revelar si la sesion existia.
 */
export const makeLogoutService = (deps: LogoutDeps): LogoutService => {
  return async (refreshToken) => {
    if (refreshToken === undefined || refreshToken === '') {
      return { revoked: false };
    }
    const session = await deps.sessions.findByRefreshHash(
      deps.refresher.hash(refreshToken),
    );
    if (session === null) {
      return { revoked: false };
    }
    await deps.sessions.revokeSession(session.id);
    return { revoked: true };
  };
};
