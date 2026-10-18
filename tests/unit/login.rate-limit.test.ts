import { describe, expect, it } from 'vitest';

import { createLoginRateLimiter } from '../../src/features/login/login.rate-limit.js';

describe('createLoginRateLimiter', () => {
  it('bloquea tras el maximo de fallos y libera en ventana nueva', () => {
    let now = 0;
    const limiter = createLoginRateLimiter({
      maxAttempts: 2,
      windowMs: 1000,
      now: () => now,
    });

    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.registerFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.registerFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);

    now = 1001;
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  it('un exito limpia los fallos de la IP y no afecta a otras', () => {
    const limiter = createLoginRateLimiter({ maxAttempts: 1 });
    limiter.registerFailure('a');
    expect(limiter.isBlocked('a')).toBe(true);
    expect(limiter.isBlocked('b')).toBe(false);
    limiter.reset('a');
    expect(limiter.isBlocked('a')).toBe(false);
  });
});
