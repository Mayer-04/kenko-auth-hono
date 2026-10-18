import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';

import { LoginLimits } from '../../src/features/login/login.limits.js';
import {
  ACCESS_TOKEN_ALG,
  makeAccessTokenIssuer,
} from '../../src/infra/auth/token-issuer.js';

const CONFIG = {
  secret: 'secreto-de-prueba-con-mas-de-32-caracteres-123',
  issuer: 'kenko.auth',
  audience: 'kenko-api',
  ttlSec: LoginLimits.ACCESS_TOKEN_TTL_SEC,
} as const;

const SUBJECT = {
  userId: '0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
  firstName: 'Maria Fernanda',
  email: 'maria.gomez@example.com',
} as const;

describe('makeAccessTokenIssuer', () => {
  it('firma y verifica un token con los claims acordados', async () => {
    const issuer = makeAccessTokenIssuer({ ...CONFIG });
    const token = await issuer.sign({ ...SUBJECT }, { nowSec: 1_700_000_000 });

    // Congela el reloj dentro de la vigencia para verificar.
    const realNow = Date.now;
    Date.now = () => 1_700_000_000 * 1000;
    try {
      const verified = await issuer.verify(token);
      expect(verified.userId).toBe(SUBJECT.userId);
      expect(verified.firstName).toBe(SUBJECT.firstName);
      expect(verified.email).toBe(SUBJECT.email);
      expect(verified.expiresAtSec).toBe(1_700_000_000 + CONFIG.ttlSec);
      expect(verified.tokenId).toBeTruthy();
    } finally {
      Date.now = realNow;
    }
  });

  it('rechaza firma con otro secreto', async () => {
    const issuer = makeAccessTokenIssuer({ ...CONFIG });
    const other = makeAccessTokenIssuer({
      ...CONFIG,
      secret: 'otro-secreto-distinto-de-mas-de-32-caracteres-x',
    });
    const token = await other.sign({ ...SUBJECT });
    await expect(issuer.verify(token)).rejects.toThrow();
  });

  it('rechaza tokens expirados', async () => {
    const issuer = makeAccessTokenIssuer({ ...CONFIG });
    const token = await issuer.sign({ ...SUBJECT }, { nowSec: 1_000 });
    await expect(issuer.verify(token)).rejects.toThrow();
  });

  it('rechaza un algoritmo distinto al permitido', async () => {
    const issuer = makeAccessTokenIssuer({ ...CONFIG });
    const nowSec = Math.floor(Date.now() / 1000);
    const foreign = await sign(
      {
        sub: SUBJECT.userId,
        userId: SUBJECT.userId,
        firstName: SUBJECT.firstName,
        email: SUBJECT.email,
        iss: CONFIG.issuer,
        aud: CONFIG.audience,
        iat: nowSec,
        exp: nowSec + 900,
        jti: 'x',
      },
      CONFIG.secret,
      'HS384',
    );
    await expect(issuer.verify(foreign)).rejects.toThrow();
    expect(ACCESS_TOKEN_ALG).toBe('HS256');
  });

  it('rechaza emisor o audiencia distintos', async () => {
    const issuer = makeAccessTokenIssuer({ ...CONFIG });
    const token = await issuer.sign({ ...SUBJECT });
    const wrongIss = makeAccessTokenIssuer({ ...CONFIG, issuer: 'otro' });
    const wrongAud = makeAccessTokenIssuer({ ...CONFIG, audience: 'otra' });
    await expect(wrongIss.verify(token)).rejects.toThrow();
    await expect(wrongAud.verify(token)).rejects.toThrow();
  });
});
