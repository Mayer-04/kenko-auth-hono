import { describe, expect, it } from 'vitest';

import { PasswordResetLimits } from '../../src/features/passwordreset/passwordreset.limits.js';
import { makeResetTokenTool } from '../../src/infra/security/reset-token.js';

const tool = makeResetTokenTool(PasswordResetLimits.TOKEN_RANDOM_BYTES);

describe('reset token tool', () => {
  it('genera tokens base64url de 32 bytes (256 bits)', () => {
    const token = tool.generate();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('los tokens son unicos entre llamadas', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => tool.generate()));
    expect(tokens.size).toBe(100);
  });

  it('hash SHA-256 hex de 64 caracteres, deterministico y distinto del token', () => {
    const token = tool.generate();
    const hash = tool.hash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tool.hash(token)).toBe(hash);
    expect(hash).not.toBe(token);
    expect(tool.hash(tool.generate())).not.toBe(hash);
  });
});
