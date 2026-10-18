import { describe, expect, it } from 'vitest';

import type { SessionStore } from '../../src/features/login/login.port.js';
import type { AuthSessionRecord } from '../../src/features/login/login.types.js';
import { AuthSessionStatus } from '../../src/features/login/login.types.js';
import { makeRefreshService } from '../../src/features/login/refresh.service.js';
import { AppError } from '../../src/shared/errors.js';

const SESSION: AuthSessionRecord = {
  id: 'sesion-1',
  familyId: 'familia-1',
  userId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  refreshHash: 'hash:refresh-crudo',
  status: AuthSessionStatus.ACTIVE,
  expiresAt: '2026-10-23T12:00:00.000Z',
};

type Calls = {
  rotated: Array<Parameters<SessionStore['rotate']>[0]>;
  revokedSessions: string[];
  revokedFamilies: string[];
};

const fakeSessions = (
  session: AuthSessionRecord | null,
  overrides: Partial<SessionStore> = {},
  calls?: Calls,
): SessionStore => {
  return {
    create: async () => undefined,
    findByRefreshHash: async () => (session === null ? null : { ...session }),
    rotate: async (args) => {
      calls?.rotated.push(args);
      return 'rotated';
    },
    revokeSession: async (id) => {
      calls?.revokedSessions.push(id);
    },
    revokeFamily: async (familyId) => {
      calls?.revokedFamilies.push(familyId);
    },
    purgeStale: async () => 0,
    ...overrides,
  };
};

const depsBase = (sessions: SessionStore) => ({
  credentials: {
    findByDocument: async () => null,
    findById: async () => ({
      id: SESSION.userId,
      firstName: 'Maria Fernanda',
      email: 'maria.gomez@example.com',
    }),
  },
  sessions,
  signer: {
    sign: async (subject: { userId: string }) => `access.${subject.userId}`,
  },
  refresher: {
    generate: () => 'refresh-nuevo',
    hash: (token: string) => `hash:${token}`,
  },
  newSessionId: () => 'sesion-2',
  nowIso: () => '2026-10-16T12:00:00.000Z',
});

describe('makeRefreshService', () => {
  it('sesion activa rota e emite tokens nuevos', async () => {
    const calls: Calls = {
      rotated: [],
      revokedSessions: [],
      revokedFamilies: [],
    };
    const service = makeRefreshService(
      depsBase(fakeSessions(SESSION, {}, calls)),
    );
    const res = await service('refresh-crudo', 'corr-1');

    expect(res.refreshToken).toBe('refresh-nuevo');
    expect(res.accessToken).toBe(`access.${SESSION.userId}`);
    expect(calls.rotated).toHaveLength(1);
    expect(calls.rotated[0]?.newSession.familyId).toBe(SESSION.familyId);
    expect(calls.revokedFamilies).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain('refresh-crudo');
  });

  it('token desconocido o revocado da 401 sin efectos', async () => {
    const calls: Calls = {
      rotated: [],
      revokedSessions: [],
      revokedFamilies: [],
    };
    const service = makeRefreshService(depsBase(fakeSessions(null, {}, calls)));
    await expect(service('desconocido', 'c1')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<AppError>);
    expect(calls.rotated).toHaveLength(0);

    const revoked = fakeSessions(
      { ...SESSION, status: AuthSessionStatus.REVOKED },
      {},
      calls,
    );
    await expect(
      makeRefreshService(depsBase(revoked))('refresh-crudo', 'c2'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls.revokedFamilies).toHaveLength(0);
  });

  it('token expirado da 401 y revoca la sesion', async () => {
    const calls: Calls = {
      rotated: [],
      revokedSessions: [],
      revokedFamilies: [],
    };
    const service = makeRefreshService(
      depsBase(
        fakeSessions(
          { ...SESSION, expiresAt: '2026-10-15T12:00:00.000Z' },
          {},
          calls,
        ),
      ),
    );
    await expect(service('refresh-crudo', 'c3')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls.revokedSessions).toEqual([SESSION.id]);
    expect(calls.rotated).toHaveLength(0);
  });

  it('reutilizar un token rotado revoca la familia completa', async () => {
    const calls: Calls = {
      rotated: [],
      revokedSessions: [],
      revokedFamilies: [],
    };
    const service = makeRefreshService(
      depsBase(
        fakeSessions(
          { ...SESSION, status: AuthSessionStatus.ROTATED },
          {},
          calls,
        ),
      ),
    );
    const err = await service('refresh-crudo', 'c4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(401);
    expect(calls.revokedFamilies).toEqual([SESSION.familyId]);
    expect(calls.rotated).toHaveLength(0);
  });

  it('carrera perdida (stale) da 401 sin revocar la familia', async () => {
    const calls: Calls = {
      rotated: [],
      revokedSessions: [],
      revokedFamilies: [],
    };
    const service = makeRefreshService(
      depsBase(fakeSessions(SESSION, { rotate: async () => 'stale' }, calls)),
    );
    await expect(service('refresh-crudo', 'c5')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls.revokedFamilies).toHaveLength(0);
  });
});
