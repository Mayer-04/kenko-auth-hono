import { invalidCredentials } from '../../shared/errors.js';
import { LoginLimits } from './login.limits.js';
import type {
  AccessTokenSigner,
  CredentialsStore,
  PasswordVerifier,
  RefreshTokenFactory,
  SessionStore,
} from './login.port.js';
import type { LoginInput, LoginResult } from './login.types.js';

/** Milisegundos por segundo (conversion de TTL a vencimiento ISO). */
const MS_PER_SEC = 1000;

export type LoginDeps = {
  credentials: CredentialsStore;
  sessions: SessionStore;
  verifier: PasswordVerifier;
  signer: AccessTokenSigner;
  refresher: RefreshTokenFactory;
  newSessionId: () => string;
  newFamilyId: () => string;
  nowIso: () => string;
};

export type LoginService = (
  input: LoginInput,
  correlationId: string,
) => Promise<LoginResult>;

/**
 * Caso de uso `login`.
 *
 * - Anti-enumeracion: cuenta inexistente y clave incorrecta dan el mismo
 *   401 generico (Ley 1581). Limitacion conocida: cuando la cuenta no
 *   existe se omite el `verify` de Argon2id, asi que el tiempo de respuesta
 *   difiere ligeramente (el ruido de red lo domina; documentado).
 * - Abre una familia de sesion nueva y guarda solo el hash del refresh.
 * - Nunca devuelve ni registra la contrasena ni su hash.
 */
export const makeLoginService = (deps: LoginDeps): LoginService => {
  return async (input, correlationId) => {
    const found = await deps.credentials.findByDocument(
      input.documentType,
      input.documentNumber,
    );
    const matches =
      found === null
        ? false
        : await deps.verifier.verify(found.passwordHash, input.password);
    if (found === null || !matches) {
      throw invalidCredentials(correlationId);
    }

    const now = deps.nowIso();
    const refreshToken = deps.refresher.generate();
    const refreshExpiresAt = new Date(
      Date.parse(now) + LoginLimits.REFRESH_TOKEN_TTL_SEC * MS_PER_SEC,
    ).toISOString();
    await deps.sessions.create({
      id: deps.newSessionId(),
      familyId: deps.newFamilyId(),
      userId: found.id,
      refreshHash: deps.refresher.hash(refreshToken),
      expiresAt: refreshExpiresAt,
    });

    const identity = {
      userId: found.id,
      firstName: found.firstName,
      email: found.email,
    };
    const accessToken = await deps.signer.sign(identity);

    return {
      identity,
      accessToken,
      accessTokenExpiresInSec: LoginLimits.ACCESS_TOKEN_TTL_SEC,
      refreshToken,
      refreshExpiresAt,
    };
  };
};
