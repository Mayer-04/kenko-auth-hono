import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { describe, expect, it, vi } from 'vitest';
import type winston from 'winston';

import type {
  OutboxRepository,
  PendingOutbox,
} from '../../src/infra/db/repositories/outbox.repository.js';
import {
  backoffSeconds,
  runRelayOnce,
} from '../../src/infra/events/outbox-relay.js';

const DETAIL = {
  metadata: {
    eventId: 'e1',
    eventVersion: '1',
    occurredAt: '2026-10-13T20:15:30.000Z',
    correlationId: 'c1',
  },
  data: {
    userId: 'u1',
    document: { type: 'CC', number: '1020304050' },
    person: {
      firstName: 'A',
      lastName: 'B',
      birthDate: '1995-03-21',
      gender: 'female',
    },
    contact: {
      email: 'a@example.com',
      emailVerified: false,
      phone: '+573001234567',
    },
    address: { line: 'X', city: 'Bogota' },
  },
};

const stubLogger = (): winston.Logger => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as winston.Logger;
};

const stubOutbox = (rows: PendingOutbox[]) => {
  const sent: string[] = [];
  const dead: string[] = [];
  const rescheduled: Array<{ id: string; attempts: number }> = [];
  return {
    sent,
    dead,
    rescheduled,
    async claimPending() {
      return rows;
    },
    async markSent(id: string) {
      sent.push(id);
    },
    async markDead(id: string) {
      dead.push(id);
    },
    async reschedule(id: string, attempts: number) {
      rescheduled.push({ id, attempts });
    },
    async pendingCount() {
      return 0;
    },
  } as unknown as OutboxRepository & {
    sent: string[];
    dead: string[];
    rescheduled: Array<{ id: string; attempts: number }>;
  };
};

const stubBridge = (behavior: {
  entries?: Array<{ ErrorCode?: string }>;
  sentDetails?: string[];
  sentEntries?: Array<{ DetailType?: string; Source?: string }>;
}) => {
  return {
    async send(cmd: unknown) {
      const input = (
        cmd as {
          input: {
            Entries: Array<{
              Detail?: string;
              DetailType?: string;
              Source?: string;
            }>;
          };
        }
      ).input;
      const entry = input.Entries[0];
      const detail = entry?.Detail;
      if (detail !== undefined) behavior.sentDetails?.push(detail);
      if (entry !== undefined) behavior.sentEntries?.push(entry);
      return { Entries: behavior.entries ?? [{}] };
    },
  } as unknown as EventBridgeClient;
};

const row = (payload: unknown): PendingOutbox => {
  return {
    id: 'row1',
    eventId: 'e1',
    eventType: 'UserRegistered',
    correlationId: 'c1',
    payload,
    attempts: 0,
  };
};

describe('runRelayOnce', () => {
  it('publica payload doblemente codificado con Detail objeto valido', async () => {
    const outbox = stubOutbox([row(JSON.stringify(JSON.stringify(DETAIL)))]);
    const sentDetails: string[] = [];
    const deps = {
      outbox,
      eventBridge: stubBridge({ sentDetails }),
      eventBusName: 'kenko-dev-bus',
      logger: stubLogger(),
    };

    const outcome = await runRelayOnce(deps);

    expect(outcome).toEqual({ published: 1, failed: 0, dead: 0 });
    expect(outbox.sent).toEqual(['row1']);
    expect(sentDetails).toHaveLength(1);
    // Regresion MalformedDetail: el Detail debe parsear a objeto, no a string.
    expect(typeof JSON.parse(sentDetails[0] as string)).toBe('object');
    expect(
      (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[0] === 'outbox.payload_normalized',
      ),
    ).toBe(true);
  });

  it('publica PasswordResetRequested con su DetailType (fila, no hardcodeado)', async () => {
    const resetDetail = {
      metadata: {
        eventId: 'e1',
        eventVersion: '1',
        occurredAt: '2026-10-13T20:15:30.000Z',
        correlationId: 'c1',
      },
      data: {
        userId: 'u1',
        email: 'a@example.com',
        firstName: 'A',
        resetUrl: 'http://localhost:8080/reset#token=tok-en-claro',
        expiresAt: '2026-10-13T20:45:30.000Z',
      },
    };
    const outbox = stubOutbox([
      { ...row(resetDetail), eventType: 'PasswordResetRequested' },
    ]);
    const sentEntries: Array<{ DetailType?: string; Source?: string }> = [];

    const outcome = await runRelayOnce({
      outbox,
      eventBridge: stubBridge({ sentEntries }),
      eventBusName: 'kenko-dev-bus',
      logger: stubLogger(),
    });

    expect(outcome).toEqual({ published: 1, failed: 0, dead: 0 });
    expect(sentEntries[0]?.DetailType).toBe('PasswordResetRequested');
    expect(sentEntries[0]?.Source).toBe('kenko.auth');
  });

  it('marca dead el payload irreparable sin llamar a EventBridge', async () => {
    const outbox = stubOutbox([row('no-json{{{')]);
    const bridge = stubBridge({});
    const send = vi.spyOn(bridge, 'send');

    const outcome = await runRelayOnce({
      outbox,
      eventBridge: bridge,
      eventBusName: 'b',
      logger: stubLogger(),
    });

    expect(outcome).toEqual({ published: 0, failed: 0, dead: 1 });
    expect(outbox.dead).toEqual(['row1']);
    expect(send).not.toHaveBeenCalled();
  });

  it('reprograma con backoff cuando EventBridge rechaza', async () => {
    const outbox = stubOutbox([{ ...row(DETAIL), attempts: 0 }]);

    const outcome = await runRelayOnce({
      outbox,
      eventBridge: stubBridge({ entries: [{ ErrorCode: 'MalformedDetail' }] }),
      eventBusName: 'b',
      logger: stubLogger(),
    });

    expect(outcome).toEqual({ published: 0, failed: 1, dead: 0 });
    expect(outbox.rescheduled).toEqual([{ id: 'row1', attempts: 1 }]);
  });

  it('backoff crece 5s, 30s, 5min y tope 1h', () => {
    expect([
      backoffSeconds(0),
      backoffSeconds(1),
      backoffSeconds(2),
      backoffSeconds(9),
    ]).toEqual([5, 30, 300, 3600]);
  });
});
