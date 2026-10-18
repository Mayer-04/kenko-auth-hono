import { describe, expect, it } from 'vitest';

import type { SessionStore } from '../../src/features/login/login.port.js';
import { AuthSessionStatus } from '../../src/features/login/login.types.js';
import { makeLogoutService } from '../../src/features/login/logout.service.js';

describe('makeLogoutService', () => {
  it('revoca solo la sesion actual', async () => {
    const revoked: string[] = [];
    const sessions: SessionStore = {
      create: async () => undefined,
      findByRefreshHash: async () => ({
        id: 'sesion-1',
        familyId: 'familia-1',
        userId: 'u1',
        refreshHash: 'hash:x',
        status: AuthSessionStatus.ACTIVE,
        expiresAt: '2026-10-23T12:00:00.000Z',
      }),
      rotate: async () => 'rotated',
      revokeSession: async (id) => {
        revoked.push(id);
      },
      revokeFamily: async () => undefined,
      purgeStale: async () => 0,
    };
    const res = await makeLogoutService({
      sessions,
      refresher: {
        generate: () => 'x',
        hash: (token: string) => `hash:${token}`,
      },
    })('x');
    expect(res).toEqual({ revoked: true });
    expect(revoked).toEqual(['sesion-1']);
  });

  it('es idempotente con cookie ausente o token desconocido', async () => {
    let calls = 0;
    const sessions: SessionStore = {
      create: async () => undefined,
      findByRefreshHash: async () => null,
      rotate: async () => 'rotated',
      revokeSession: async () => {
        calls += 1;
      },
      revokeFamily: async () => undefined,
      purgeStale: async () => 0,
    };
    const service = makeLogoutService({
      sessions,
      refresher: {
        generate: () => 'x',
        hash: (token: string) => `hash:${token}`,
      },
    });
    expect(await service(undefined)).toEqual({ revoked: false });
    expect(await service('desconocido')).toEqual({ revoked: false });
    expect(calls).toBe(0);
  });
});
