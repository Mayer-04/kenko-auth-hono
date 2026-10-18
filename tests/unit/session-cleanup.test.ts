import { describe, expect, it } from 'vitest';

import { LoginLimits } from '../../src/features/login/login.limits.js';
import type { SessionStore } from '../../src/features/login/login.port.js';
import { makeSessionCleanup } from '../../src/infra/db/session-cleanup.js';

const fakeStore = (
  batches: number[],
  calls: Array<{ retentionDays: number; limit: number }>,
): SessionStore => {
  return {
    create: async () => undefined,
    findByRefreshHash: async () => null,
    rotate: async () => 'rotated',
    revokeSession: async () => undefined,
    revokeFamily: async () => undefined,
    purgeStale: async (retentionDays, limit) => {
      calls.push({ retentionDays, limit });
      return batches.shift() ?? 0;
    },
  };
};

describe('makeSessionCleanup', () => {
  it('purga por lotes hasta agotar y respeta el intervalo', async () => {
    let now = 0;
    const calls: Array<{ retentionDays: number; limit: number }> = [];
    const cleanup = makeSessionCleanup(fakeStore([2, 2, 1], calls), {
      batchLimit: 2,
      intervalMs: 1000,
      nowMs: () => now,
    });

    const first = await cleanup.runIfDue();
    expect(first).toEqual({ ran: true, deleted: 5 });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      retentionDays: LoginLimits.SESSION_RETENTION_DAYS,
      limit: 2,
    });

    expect(await cleanup.runIfDue()).toEqual({ ran: false, deleted: 0 });
    expect(calls).toHaveLength(3);

    now = 1001;
    const second = await cleanup.runIfDue();
    expect(second.ran).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('sin nada que purgar corre igual y marca el intervalo', async () => {
    const calls: Array<{ retentionDays: number; limit: number }> = [];
    const cleanup = makeSessionCleanup(fakeStore([], calls));
    expect(await cleanup.runIfDue()).toEqual({ ran: true, deleted: 0 });
    expect(await cleanup.runIfDue()).toEqual({ ran: false, deleted: 0 });
    expect(calls).toHaveLength(1);
  });
});
