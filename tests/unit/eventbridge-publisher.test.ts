import { describe, expect, it } from 'vitest';
import type { UserRegisteredDetail } from '../../src/features/register/register.types.js';
import {
  normalizeDetail,
  toPutEventsEntry,
} from '../../src/infra/events/eventbridge-publisher.js';

const DETAIL: UserRegisteredDetail = {
  metadata: {
    eventId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    eventVersion: '1',
    occurredAt: '2026-10-13T20:15:30.000Z',
    correlationId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10',
  },
  data: {
    userId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    document: { type: 'CC', number: '1020304050' },
    person: {
      firstName: 'Maria Fernanda',
      lastName: 'Gomez Rojas',
      birthDate: '1995-03-21',
      gender: 'female',
    },
    contact: {
      email: 'maria.gomez@example.com',
      emailVerified: false,
      phone: '+573001234567',
    },
    address: { line: 'Cra 15 # 93-60', city: 'Bogota' },
  },
};

describe('toPutEventsEntry', () => {
  it('usa el envelope PutEvents con Detail serializado', () => {
    const entry = toPutEventsEntry(DETAIL, 'UserRegistered', 'kenko-dev-bus');
    expect(entry.Source).toBe('kenko.auth');
    expect(entry.DetailType).toBe('UserRegistered');
    expect(entry.EventBusName).toBe('kenko-dev-bus');
    const parsed = JSON.parse(entry.Detail) as UserRegisteredDetail;
    expect(parsed.metadata.eventVersion).toBe('1');
    expect(parsed.data.userId).toBe(DETAIL.data.userId);
  });

  it('publica PasswordResetRequested con su propio DetailType', () => {
    const resetDetail = {
      metadata: {
        eventId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
        eventVersion: '1',
        occurredAt: '2026-10-13T20:15:30.000Z',
        correlationId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10',
      },
      data: {
        userId: 'u1',
        email: 'a@example.com',
        firstName: 'A',
        resetUrl: 'http://localhost:8080/reset#token=tok',
        expiresAt: '2026-10-13T20:45:30.000Z',
      },
    };
    const entry = toPutEventsEntry(
      resetDetail,
      'PasswordResetRequested',
      'kenko-dev-bus',
    );
    expect(entry.DetailType).toBe('PasswordResetRequested');
    expect(entry.Source).toBe('kenko.auth');
  });

  it('no incluye password ni secretos', () => {
    const entry = toPutEventsEntry(DETAIL, 'UserRegistered', 'kenko-dev-bus');
    expect(entry.Detail).not.toContain('password');
    expect(entry.Detail).not.toContain('passwordHash');
  });
});

describe('normalizeDetail', () => {
  it('deja pasar el objeto tal cual', () => {
    expect(normalizeDetail(DETAIL)).toEqual(DETAIL);
  });

  it('abre payload doblemente codificado (string dentro de string)', () => {
    const once = JSON.stringify(DETAIL);
    const twice = JSON.stringify(once);
    const normalized = normalizeDetail(twice);
    expect(normalized).toEqual(DETAIL);
    // El Detail resultante debe parsear a objeto, no a string.
    const entry = toPutEventsEntry(
      normalized,
      'UserRegistered',
      'kenko-dev-bus',
    );
    expect(typeof JSON.parse(entry.Detail)).toBe('object');
  });

  it('rechaza texto no-JSON, escalares, arreglos y objetos sin metadata/data', () => {
    expect(() => normalizeDetail('no-json{{{')).toThrow();
    expect(() => normalizeDetail(42)).toThrow();
    expect(() => normalizeDetail(null)).toThrow();
    expect(() => normalizeDetail([])).toThrow();
    expect(() => normalizeDetail({ metadata: {} })).toThrow();
  });
});
