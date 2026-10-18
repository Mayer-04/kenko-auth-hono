import { invalidCredentials } from '../../shared/errors.js';
import { LoginLimits } from './login.limits.js';
import type {
  AccessTokenSigner,
  CredentialsStore,
  RefreshTokenFactory,
  SessionStore,
} from './login.port.js';
import type { LoginResult } from './login.types.js';
import { AuthSessionStatus } from './login.types.js';

/** Milisegundos por segundo (conversion de TTL a vencimiento ISO). */
const MS_PER_SEC = 1000;

export type RefreshDeps = {
  credentials: CredentialsStore;
  sessions: SessionStore;
  signer: AccessTokenSigner;
  refresher: RefreshTokenFactory;
  newSessionId: () => string;
  nowIso: () => string;
};

export type RefreshService = (
  refreshToken: string,
  correlationId: string,
) => Promise<LoginResult>;

/**
 * Caso de uso `refresh`: renueva la sesion sin pedir credenciales.
 *
 * - Rotacion: cada uso correcto invalida el refresh anterior y emite uno
 *   nuevo en la misma familia.
 * - Reutilizacion (`rotated`): indicio de robo; revoca la familia completa
 *   y responde el mismo 401 generico.
 * - `revoked`, desconocido o expirado: 401 generico sin revocar nada mas.
 * - Carrera perdida (`stale`): dos renovaciones concurrentes; la perdedora
 *   recibe 401 sin revocar la familia (la ganadora ya roto correctamente).
 */
export const makeRefreshService = (deps: RefreshDeps): RefreshService => {
  return async (refreshToken, correlationId) => {
    const now = deps.nowIso();
    const session = await deps.sessions.findByRefreshHash(
      deps.refresher.hash(refreshToken),
    );
    if (session === null || session.status === AuthSessionStatus.REVOKED) {
      throw invalidCredentials(correlationId);
    }
    if (Date.parse(session.expiresAt) <= Date.parse(now)) {
      await deps.sessions.revokeSession(session.id);
      throw invalidCredentials(correlationId);
    }
    if (session.status === AuthSessionStatus.ROTATED) {
      await deps.sessions.revokeFamily(session.familyId);
      throw invalidCredentials(correlationId);
    }

    const account = await deps.credentials.findById(session.userId);
    if (account === null) {
      await deps.sessions.revokeSession(session.id);
      throw invalidCredentials(correlationId);
    }

    const nextRefresh = deps.refresher.generate();
    const nextExpiresAt = new Date(
      Date.parse(now) + LoginLimits.REFRESH_TOKEN_TTL_SEC * MS_PER_SEC,
    ).toISOString();
    const outcome = await deps.sessions.rotate({
      sessionId: session.id,
      newSession: {
        id: deps.newSessionId(),
        familyId: session.familyId,
        userId: session.userId,
        refreshHash: deps.refresher.hash(nextRefresh),
        expiresAt: nextExpiresAt,
      },
      nowIso: now,
    });
    if (outcome === 'stale') {
      throw invalidCredentials(correlationId);
    }

    const identity = {
      userId: account.id,
      firstName: account.firstName,
      email: account.email,
    };
    const accessToken = await deps.signer.sign(identity);
    return {
      identity,
      accessToken,
      accessTokenExpiresInSec: LoginLimits.ACCESS_TOKEN_TTL_SEC,
      refreshToken: nextRefresh,
      refreshExpiresAt: nextExpiresAt,
    };
  };
};
