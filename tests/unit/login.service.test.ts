import { describe, expect, it } from 'vitest';

import type {
  CredentialsStore,
  SessionStore,
} from '../../src/features/login/login.port.js';
import { makeLoginService } from '../../src/features/login/login.service.js';
import { AppError } from '../../src/shared/errors.js';

const CREDENTIALS = {
  id: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  firstName: 'Maria Fernanda',
  email: 'maria.gomez@example.com',
  passwordHash: 'hashed:correcta-segura-99',
} as const;

const fakeCredentials = (
  overrides: Partial<CredentialsStore> = {},
): CredentialsStore => {
  return {
    findByDocument: async () => ({ ...CREDENTIALS }),
    findById: async () => ({
      id: CREDENTIALS.id,
      firstName: CREDENTIALS.firstName,
      email: CREDENTIALS.email,
    }),
    ...overrides,
  };
};

const fakeSessions = (): SessionStore & {
  created: Array<Parameters<SessionStore['create']>[0]>;
} => {
  const created: Array<Parameters<SessionStore['create']>[0]> = [];
  return {
    created,
    create: async (input) => {
      created.push(input);
    },
    findByRefreshHash: async () => null,
    rotate: async () => 'rotated',
    revokeSession: async () => undefined,
    revokeFamily: async () => undefined,
    purgeStale: async () => 0,
  };
};

const depsBase = (credentials: CredentialsStore, sessions: SessionStore) => ({
  credentials,
  sessions,
  verifier: {
    verify: async (hash: string, password: string) =>
      hash === `hashed:${password}`,
  },
  signer: {
    sign: async (subject: { userId: string }) => `access.${subject.userId}`,
  },
  refresher: {
    generate: () => 'refresh-crudo',
    hash: (token: string) => `hash:${token}`,
  },
  newSessionId: () => 'sesion-1',
  newFamilyId: () => 'familia-1',
  nowIso: () => '2026-10-16T12:00:00.000Z',
});

describe('makeLoginService', () => {
  it('credenciales validas emiten tokens y guardan solo el hash', async () => {
    const sessions = fakeSessions();
    const service = makeLoginService(depsBase(fakeCredentials(), sessions));
    const res = await service(
      {
        documentType: 'CC',
        documentNumber: '1020304050',
        password: 'correcta-segura-99',
      },
      'corr-1',
    );

    expect(res.identity).toEqual({
      userId: CREDENTIALS.id,
      firstName: CREDENTIALS.firstName,
      email: CREDENTIALS.email,
    });
    expect(res.accessToken).toBe(`access.${CREDENTIALS.id}`);
    expect(res.accessTokenExpiresInSec).toBe(15 * 60);
    expect(sessions.created).toHaveLength(1);
    const created = sessions.created[0];
    expect(created).toBeDefined();
    if (created === undefined) throw new Error('unreachable');
    expect(created.refreshHash).toBe('hash:refresh-crudo');
    expect(created.refreshHash).not.toBe(res.refreshToken);
    // La respuesta no filtra la contrasena ni su hash.
    expect(JSON.stringify(res)).not.toContain('correcta-segura-99');
    expect(JSON.stringify(res)).not.toContain('hashed:');
  });

  it('documento inexistente y clave incorrecta dan el mismo 401', async () => {
    const unknown = fakeCredentials({ findByDocument: async () => null });
    const errMissing = await makeLoginService(
      depsBase(unknown, fakeSessions()),
    )({ documentType: 'CC', documentNumber: '999', password: 'x' }, 'c1').catch(
      (e: unknown) => e,
    );
    expect(errMissing).toBeInstanceOf(AppError);
    expect((errMissing as AppError).code).toBe('UNAUTHORIZED');
    expect((errMissing as AppError).status).toBe(401);

    const errWrong = await makeLoginService(
      depsBase(fakeCredentials(), fakeSessions()),
    )(
      {
        documentType: 'CC',
        documentNumber: '1020304050',
        password: 'otra-clave',
      },
      'c2',
    ).catch((e: unknown) => e);
    expect(errWrong).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Credenciales invalidas.',
    } satisfies Partial<AppError>);
  });

  it('fallo de autenticacion no crea sesion', async () => {
    const sessions = fakeSessions();
    await makeLoginService(
      depsBase(fakeCredentials({ findByDocument: async () => null }), sessions),
    )({ documentType: 'CC', documentNumber: '999', password: 'x' }, 'c3').catch(
      () => undefined,
    );
    expect(sessions.created).toHaveLength(0);
  });
});
