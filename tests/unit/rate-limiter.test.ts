import { describe, expect, it } from 'vitest';
import { MS_PER_SECOND } from '../../src/features/passwordreset/passwordreset.limits.js';
import { makeInMemoryRateLimiter } from '../../src/infra/ratelimit/in-memory-rate-limiter.js';

describe('makeInMemoryRateLimiter', () => {
  it('permite hasta el limite y rechaza con retryAfter en la ventana', () => {
    let clock = 0;
    const limiter = makeInMemoryRateLimiter({
      bucketsMax: 100,
      now: () => clock,
    });
    const windowMs = 10 * MS_PER_SECOND;

    expect(limiter.hit('k', 3, windowMs).allowed).toBe(true);
    expect(limiter.hit('k', 3, windowMs).allowed).toBe(true);
    expect(limiter.hit('k', 3, windowMs).allowed).toBe(true);

    clock = 4 * MS_PER_SECOND;
    const blocked = limiter.hit('k', 3, windowMs);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error('unreachable');
    expect(blocked.retryAfterSeconds).toBe(6);
  });

  it('vuelve a permitir tras la ventana', () => {
    let clock = 0;
    const limiter = makeInMemoryRateLimiter({
      bucketsMax: 100,
      now: () => clock,
    });
    const windowMs = 10 * MS_PER_SECOND;

    expect(limiter.hit('k', 1, windowMs).allowed).toBe(true);
    expect(limiter.hit('k', 1, windowMs).allowed).toBe(false);

    clock = 10 * MS_PER_SECOND;
    expect(limiter.hit('k', 1, windowMs).allowed).toBe(true);
  });

  it('las claves son independientes', () => {
    const limiter = makeInMemoryRateLimiter({ bucketsMax: 100 });
    expect(limiter.hit('a', 1, 60000).allowed).toBe(true);
    expect(limiter.hit('a', 1, 60000).allowed).toBe(false);
    expect(limiter.hit('b', 1, 60000).allowed).toBe(true);
  });

  it('purga buckets expirados al superar el tope de memoria', () => {
    let clock = 0;
    const limiter = makeInMemoryRateLimiter({
      bucketsMax: 2,
      now: () => clock,
    });
    const windowMs = 10 * MS_PER_SECOND;

    expect(limiter.hit('old-1', 5, windowMs).allowed).toBe(true);
    expect(limiter.hit('old-2', 5, windowMs).allowed).toBe(true);
    clock = 11 * MS_PER_SECOND;
    // Superar el tope purga los expirados y no debe bloquear 'new'.
    expect(limiter.hit('new', 1, windowMs).allowed).toBe(true);
  });
});
