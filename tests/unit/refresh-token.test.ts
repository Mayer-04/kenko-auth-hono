import { describe, expect, it } from 'vitest';

import {
  hashRefreshToken,
  newRefreshToken,
} from '../../src/infra/auth/refresh-token.js';

describe('refresh-token', () => {
  it('genera valores unicos por sesion', () => {
    expect(newRefreshToken()).not.toBe(newRefreshToken());
  });

  it('el hash es determinista y no revela el valor crudo', () => {
    const token = newRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).not.toContain(token);
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });
});
