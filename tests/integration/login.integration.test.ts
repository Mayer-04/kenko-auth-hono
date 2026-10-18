import type { SQL } from 'bun';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadEnv, resolveDatabase } from '../../src/config/env.js';
import {
  makeLoginService,
  makeLogoutService,
  makeRefreshService,
} from '../../src/features/login/index.js';
import { LoginLimits } from '../../src/features/login/login.limits.js';
import type { SessionStore } from '../../src/features/login/login.port.js';
import { createLoginRateLimiter } from '../../src/features/login/login.rate-limit.js';
import { AuthSessionStatus } from '../../src/features/login/login.types.js';
import { makeRegisterService } from '../../src/features/register/register.service.js';
import { makeRefreshTokenFactory } from '../../src/infra/auth/refresh-token.js';
import { makeAccessTokenIssuer } from '../../src/infra/auth/token-issuer.js';
import { createDb } from '../../src/infra/db/client.js';
import { makeLoginCredentialsRepository } from '../../src/infra/db/repositories/login-credentials.repository.js';
import { makeSessionRepository } from '../../src/infra/db/repositories/session.repository.js';
import { makeUserRepository } from '../../src/infra/db/repositories/user.repository.js';
import {
  authSessions,
  outbox,
  users,
} from '../../src/infra/db/schema/index.js';
import { makeArgon2Hasher } from '../../src/infra/password/argon2-hasher.js';
import { newId } from '../../src/shared/ids.js';

/**
 * Integracion del ciclo de sesion contra PostgreSQL local.
 * Flujo: register -> login -> refresh -> reuso -> logout, mas 401/400/429.
 * IPs distintas por test via `X-Forwarded-For` para aislar el rate limit.
 */
describe('ciclo de sesion /auth', () => {
  let sql: SQL;
  let close: () => void;
  let app: ReturnType<typeof buildApp>;
  let verifyToken: (token: string) => Promise<{
    userId: string;
    firstName: string;
    email: string;
  }>;
  const createdUserIds: string[] = [];
  let ipSeq = 0;
  let sessionStore: SessionStore;

  const uniqueEmail = () =>
    `login.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const uniqueDoc = () =>
    String(Math.floor(1000000000 + Math.random() * 9000000000));
  const ip = () => {
    ipSeq += 1;
    return `10.9.0.${ipSeq}`;
  };

  const registerBody = () => ({
    firstName: 'Maria Fernanda',
    lastName: 'Gomez Rojas',
    birthDate: '1995-03-21',
    gender: 'female',
    email: uniqueEmail(),
    phone: '+573001234567',
    addressLine: 'Cra 15 # 93-60 Apto 402',
    city: 'Bogota',
    documentType: 'CC',
    documentNumber: uniqueDoc(),
    password: 'correcta-segura-99',
    confirmPassword: 'correcta-segura-99',
  });

  beforeAll(() => {
    const env = loadEnv();
    const database = resolveDatabase(env);
    const client = createDb(database.url);
    sql = client.sql;
    close = client.close;
    const hasher = makeArgon2Hasher();
    const credentials = makeLoginCredentialsRepository(client);
    const sessions = makeSessionRepository(client);
    sessionStore = sessions;
    const refresher = makeRefreshTokenFactory();
    const issuer = makeAccessTokenIssuer({
      secret: env.JWT_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      ttlSec: LoginLimits.ACCESS_TOKEN_TTL_SEC,
    });
    verifyToken = (token) => issuer.verify(token);
    app = buildApp({
      registerService: makeRegisterService({
        users: makeUserRepository(client),
        hasher,
        newUserId: () => newId(),
        newEventId: () => newId(),
        nowIso: () => new Date().toISOString(),
      }),
      loginService: makeLoginService({
        credentials,
        sessions,
        verifier: hasher,
        signer: issuer,
        refresher,
        newSessionId: () => newId(),
        newFamilyId: () => newId(),
        nowIso: () => new Date().toISOString(),
      }),
      refreshService: makeRefreshService({
        credentials,
        sessions,
        signer: issuer,
        refresher,
        newSessionId: () => newId(),
        nowIso: () => new Date().toISOString(),
      }),
      logoutService: makeLogoutService({ sessions, refresher }),
      rateLimiter: createLoginRateLimiter(),
      cookieSecure: false,
    });
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const db = drizzle({ client: sql });
      for (const id of createdUserIds) {
        await db.delete(authSessions).where(eq(authSessions.userId, id));
        await db.delete(outbox).where(eq(outbox.aggregateId, id));
        await db.delete(users).where(eq(users.id, id));
      }
    }
    close();
  });

  const createUser = async () => {
    const body = registerBody();
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { userId: string } };
    createdUserIds.push(json.data.userId);
    return { body, userId: json.data.userId };
  };

  const login = async (
    documentNumber: string,
    password: string,
    fromIp: string,
  ) => {
    return app.request('/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': fromIp,
      },
      body: JSON.stringify({
        documentType: 'CC',
        documentNumber,
        password,
      }),
    });
  };

  const refreshCookieOf = (res: Response): string | null => {
    const header = res.headers.get('set-cookie');
    if (header === null) return null;
    const match = header.match(/kenko_refresh=([^;]*)/);
    return match?.[1] ?? null;
  };

  it('login valido emite access + cookie de refresh y sesion activa', async () => {
    const { body } = await createUser();
    const res = await login(body.documentNumber, body.password, ip());

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        accessToken: string;
        expiresIn: number;
        user: { userId: string; firstName: string; email: string };
      };
    };
    expect(json.data.expiresIn).toBe(900);
    expect(json.data.user.firstName).toBe('Maria Fernanda');
    expect(JSON.stringify(json)).not.toContain('correcta-segura-99');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('kenko_refresh=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/auth');

    const claims = await verifyToken(json.data.accessToken);
    expect(claims.userId).toBe(json.data.user.userId);
    expect(claims.email).toBe(body.email.toLowerCase());

    const db = drizzle({ client: sql });
    const rows = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, json.data.user.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
  });

  it('clave incorrecta y documento inexistente dan el mismo 401', async () => {
    const { body } = await createUser();

    const wrong = await login(body.documentNumber, 'otra-clave-99', ip());
    expect(wrong.status).toBe(401);
    const wrongJson = (await wrong.json()) as {
      error: { code: string; message: string };
    };
    expect(wrongJson.error.code).toBe('UNAUTHORIZED');
    expect(wrongJson.error.message).toBe('Credenciales invalidas.');

    const missing = await login('9999999999', 'cualquiera-99', ip());
    expect(missing.status).toBe(401);
    const missingJson = (await missing.json()) as {
      error: { code: string; message: string };
    };
    expect(missingJson.error.code).toBe(wrongJson.error.code);
    expect(missingJson.error.message).toBe(wrongJson.error.message);
  });

  it('entrada invalida responde 400', async () => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip() },
      body: JSON.stringify({ documentType: 'CC' }),
    });
    expect(res.status).toBe(400);
  });

  it('refresh rota y reutilizar el anterior revoca la familia', async () => {
    const { body } = await createUser();
    const first = await login(body.documentNumber, body.password, ip());
    expect(first.status).toBe(200);
    const oldCookie = refreshCookieOf(first);
    expect(oldCookie).toBeTruthy();

    const renewed = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `kenko_refresh=${oldCookie}` },
    });
    expect(renewed.status).toBe(200);
    const newCookie = refreshCookieOf(renewed);
    expect(newCookie).toBeTruthy();
    expect(newCookie).not.toBe(oldCookie);

    const reuse = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `kenko_refresh=${oldCookie}` },
    });
    expect(reuse.status).toBe(401);

    const afterTheft = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `kenko_refresh=${newCookie}` },
    });
    expect(afterTheft.status).toBe(401);
  });

  it('logout cierra la sesion y limpia la cookie', async () => {
    const { body } = await createUser();
    const first = await login(body.documentNumber, body.password, ip());
    const cookie = refreshCookieOf(first);
    expect(cookie).toBeTruthy();

    const out = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `kenko_refresh=${cookie}` },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie') ?? '').toContain('kenko_refresh=');

    const again = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `kenko_refresh=${cookie}` },
    });
    expect(again.status).toBe(401);
  });

  it('tras 5 fallos la IP recibe 429', async () => {
    const { body } = await createUser();
    const fromIp = ip();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await login(body.documentNumber, 'clave-mala-99', fromIp);
      expect(res.status).toBe(401);
    }
    const blocked = await login(body.documentNumber, 'clave-mala-99', fromIp);
    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as { error: { code: string } };
    expect(json.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('purgeStale borra muertas viejas y conserva vigentes y recientes', async () => {
    const db = drizzle({ client: sql });
    const oldIso = new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const deadIds = [newId(), newId(), newId()];
    const keptUserIds = [newId(), newId()];
    createdUserIds.push(...keptUserIds);
    await db.insert(authSessions).values([
      {
        id: deadIds[0] ?? '',
        familyId: newId(),
        userId: newId(),
        refreshHash: `purge-test-${deadIds[0]}`,
        status: AuthSessionStatus.REVOKED,
        expiresAt: new Date().toISOString(),
        lastUsedAt: oldIso,
      },
      {
        id: deadIds[1] ?? '',
        familyId: newId(),
        userId: newId(),
        refreshHash: `purge-test-${deadIds[1]}`,
        status: AuthSessionStatus.ROTATED,
        expiresAt: new Date().toISOString(),
        lastUsedAt: oldIso,
      },
      {
        id: deadIds[2] ?? '',
        familyId: newId(),
        userId: newId(),
        refreshHash: `purge-test-${deadIds[2]}`,
        status: AuthSessionStatus.ACTIVE,
        expiresAt: oldIso,
        lastUsedAt: oldIso,
      },
      {
        id: newId(),
        familyId: newId(),
        userId: keptUserIds[0] ?? '',
        refreshHash: `purge-keep-${keptUserIds[0]}`,
        status: AuthSessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: newId(),
        familyId: newId(),
        userId: keptUserIds[1] ?? '',
        refreshHash: `purge-keep-${keptUserIds[1]}`,
        status: AuthSessionStatus.REVOKED,
        expiresAt: new Date().toISOString(),
      },
    ]);

    const deleted = await sessionStore.purgeStale(30, 100);
    expect(deleted).toBe(3);

    const remaining = await db
      .select({ refreshHash: authSessions.refreshHash })
      .from(authSessions)
      .where(eq(authSessions.userId, keptUserIds[0] ?? ''));
    expect(remaining).toHaveLength(1);
    const recent = await db
      .select({ refreshHash: authSessions.refreshHash })
      .from(authSessions)
      .where(eq(authSessions.userId, keptUserIds[1] ?? ''));
    expect(recent).toHaveLength(1);
  });
});
