import { createHash } from 'node:crypto';
import type { SQL } from 'bun';
import { and, desc, sql as drizzleSql, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv, resolveDatabase } from '../../src/config/env.js';
import {
  MS_PER_MINUTE,
  PasswordResetLimits,
} from '../../src/features/passwordreset/passwordreset.limits.js';
import { createDb } from '../../src/infra/db/client.js';
import {
  outbox,
  passwordResetTokens,
  users,
} from '../../src/infra/db/schema/index.js';
import { makeArgon2Hasher } from '../../src/infra/password/argon2-hasher.js';
import { newId } from '../../src/shared/ids.js';
import { buildTestApp, TEST_ROUTE_LIMITS } from './helpers.js';

/**
 * Integracion de recuperacion de contrasena contra PostgreSQL local.
 * No toca AWS: la outbox se escribe en la base y el relay no corre.
 *
 * Cubre: token solo-hash en DB, outbox atomica, invalidacion de tokens,
 * expiracion, consumo concurrente, politica de reutilizacion, respuesta
 * identica anti-enumeracion, cabeceras no-store, rate limiting y logs sin PII.
 */

type Json = Record<string, unknown>;

const hasher = makeArgon2Hasher();
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** El token en claro solo vive en el fragmento de `resetUrl`. */
const tokenFromResetUrl = (resetUrl: string): string => {
  const marker = '#token=';
  const idx = resetUrl.indexOf(marker);
  if (idx === -1) throw new Error('resetUrl sin fragmento #token=');
  return resetUrl.slice(idx + marker.length);
};

describe('password reset (integracion)', () => {
  let sql: SQL;
  let close: () => void;
  let app: ReturnType<typeof buildTestApp>['app'];
  let captured: ReturnType<typeof buildTestApp>['captured'];
  const createdUserIds: string[] = [];

  const uniqueEmail = () =>
    `it.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
  const uniqueDoc = () =>
    String(Math.floor(1000000000 + Math.random() * 9000000000));

  const registerUser = async (
    documentNumber: string,
    password = 'correcta-segura-99',
  ): Promise<string> => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Maria Fernanda',
        lastName: 'Gomez Rojas',
        birthDate: '1995-03-21',
        gender: 'female',
        email: uniqueEmail(),
        phone: '+573001234567',
        addressLine: 'Cra 15 # 93-60 Apto 402',
        city: 'Bogota',
        documentType: 'CC',
        documentNumber,
        password,
        confirmPassword: password,
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { userId: string } };
    createdUserIds.push(json.data.userId);
    return json.data.userId;
  };

  const forgot = (documentNumber: string, forwardedFor = '10.0.0.1') =>
    app.request('/auth/password/forgot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': forwardedFor,
      },
      body: JSON.stringify({ documentType: 'CC', documentNumber }),
    });

  const reset = (token: string, password: string, forwardedFor = '10.0.0.2') =>
    app.request('/auth/password/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': forwardedFor,
      },
      body: JSON.stringify({ token, password, confirmPassword: password }),
    });

  /** Lee el payload del evento mas reciente, tolerando la doble codificacion jsonb. */
  const outboxPayloadOf = async (userId: string): Promise<Json> => {
    const db = drizzle({ client: sql });
    const rows = await db
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.aggregateId, userId),
          eq(outbox.eventType, 'PasswordResetRequested'),
        ),
      )
      .orderBy(desc(outbox.createdAt))
      .limit(1);
    let payload: unknown = rows[0]?.payload;
    for (let i = 0; i < 3 && typeof payload === 'string'; i += 1) {
      payload = JSON.parse(payload) as unknown;
    }
    return payload as Json;
  };

  /** `expires_at` como epoch (segundos), sin depender del formato de texto. */
  const expiresEpochOf = async (tokenHash: string): Promise<number> => {
    const db = drizzle({ client: sql });
    const rows = await db
      .select({
        epoch: drizzleSql<number>`extract(epoch from ${passwordResetTokens.expiresAt}) as epoch`,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);
    return Number(rows[0]?.epoch ?? 0);
  };

  const tokensOf = async (userId: string) => {
    const db = drizzle({ client: sql });
    return db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, userId));
  };

  beforeAll(() => {
    const env = loadEnv();
    const database = resolveDatabase(env);
    const client = createDb(database.url);
    sql = client.sql;
    close = client.close;
    const built = buildTestApp(sql);
    app = built.app;
    captured = built.captured;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const db = drizzle({ client: sql });
      for (const id of createdUserIds) {
        await db.delete(outbox).where(eq(outbox.aggregateId, id));
        await db
          .delete(passwordResetTokens)
          .where(eq(passwordResetTokens.userId, id));
        await db.delete(users).where(eq(users.id, id));
      }
    }
    close();
  });

  it('forgot guarda SOLO el hash del token y crea la outbox pendiente', async () => {
    const doc = uniqueDoc();
    const userId = await registerUser(doc);

    const res = await forgot(doc);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { data: Json };
    expect(body.data).toEqual({});

    const rows = await tokensOf(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('token no encontrado');

    const payload = await outboxPayloadOf(userId);
    const data = payload.data as {
      resetUrl: string;
      userId: string;
      expiresAt: string;
      email: string;
    };
    const token = tokenFromResetUrl(data.resetUrl);
    const metadata = payload.metadata as {
      eventId: string;
      eventVersion: string;
      correlationId: string;
      occurredAt: string;
    };

    // En DB solo vive el hash SHA-256; jamas el token en claro.
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Expiracion ~ TTL 30 min desde ahora (tolerancia de 5 min).
    // Se compara via epoch de Postgres: el texto de `timestamptz` trae el
    // offset de la sesion y `Date.parse` lo interpreta de forma leniente.
    const expiresEpoch = await expiresEpochOf(row.tokenHash);
    const expectedEpoch =
      (Date.now() + PasswordResetLimits.TOKEN_TTL_MINUTES * MS_PER_MINUTE) /
      1000;
    expect(Math.abs(expiresEpoch - expectedEpoch)).toBeLessThan(
      (5 * MS_PER_MINUTE) / 1000,
    );
    expect(row.usedAt).toBeNull();
    expect(row.invalidatedAt).toBeNull();

    // Outbox pending con el contrato v1 minimo.
    expect(metadata.eventVersion).toBe('1');
    expect(metadata.eventId).toBeTruthy();
    expect(metadata.correlationId).toBeTruthy();
    expect(data.userId).toBe(userId);
    expect(data.email).toContain('@');

    const db = drizzle({ client: sql });
    const events = await db
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.aggregateId, userId),
          eq(outbox.eventType, 'PasswordResetRequested'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('pending');
  });

  it('forgot responde IDENTICO exista o no la cuenta (anti-enumeracion)', async () => {
    const doc = uniqueDoc();
    await registerUser(doc);

    const known = await forgot(doc);

    const db = drizzle({ client: sql });
    const countResetEvents = async (): Promise<number> => {
      const rows = await db
        .select()
        .from(outbox)
        .where(eq(outbox.eventType, 'PasswordResetRequested'));
      return rows.length;
    };
    const eventsBefore = await countResetEvents();

    const unknown = await forgot(uniqueDoc());

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toEqual(await unknown.text());
    // Cache-Control identico; X-Correlation-Id puede variar por peticion.
    expect(known.headers.get('Cache-Control')).toBe(
      unknown.headers.get('Cache-Control'),
    );

    // La peticion inexistente no escribio ni token ni evento.
    expect(await countResetEvents()).toBe(eventsBefore);
  });

  it('solicitar de nuevo invalida el token anterior', async () => {
    const doc = uniqueDoc();
    const userId = await registerUser(doc);

    expect((await forgot(doc)).status).toBe(200);
    expect((await forgot(doc)).status).toBe(200);

    const rows = await tokensOf(userId);
    expect(rows).toHaveLength(2);
    const active = rows.filter(
      (r) => r.invalidatedAt === null && r.usedAt === null,
    );
    expect(active).toHaveLength(1);
    expect(rows.filter((r) => r.invalidatedAt !== null)).toHaveLength(1);
  });

  it('atomicidad: si la fila outbox falla, el token no persiste', async () => {
    const doc = uniqueDoc();
    const fixedEventId = newId();
    const built = buildTestApp(sql, { newEventId: () => fixedEventId });
    // Colision deliberada: outbox.event_id es unico.
    const userId = await (async () => {
      const res = await built.app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Atomico',
          lastName: 'Prueba',
          birthDate: '1990-01-01',
          gender: 'other',
          email: uniqueEmail(),
          phone: '+573001112233',
          addressLine: 'Cra 1 # 1-1',
          city: 'Bogota',
          documentType: 'CC',
          documentNumber: doc,
          password: 'correcta-segura-99',
          confirmPassword: 'correcta-segura-99',
        }),
      });
      const json = (await res.json()) as { data: { userId: string } };
      createdUserIds.push(json.data.userId);
      return json.data.userId;
    })();
    const db = drizzle({ client: sql });
    await db.insert(outbox).values({
      id: newId(),
      eventId: fixedEventId,
      aggregateType: 'user',
      aggregateId: userId,
      eventType: 'Seed',
      eventVersion: '1',
      correlationId: 'seed',
      payload: {},
      status: 'pending',
      attempts: 0,
    });

    const res = await built.app.request('/auth/password/forgot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.0.0.9',
      },
      body: JSON.stringify({ documentType: 'CC', documentNumber: doc }),
    });
    // Falla la transaccion completa: 500 y NINGUN token persistido.
    expect(res.status).toBe(500);
    expect(await tokensOf(userId)).toHaveLength(0);
  });

  it('reset exitoso: cambia el hash, marca used_at e invalida los demas', async () => {
    const doc = uniqueDoc();
    const userId = await registerUser(doc, 'contrasena-original-1');
    expect((await forgot(doc)).status).toBe(200);
    const firstPayload = await outboxPayloadOf(userId);
    const firstToken = tokenFromResetUrl(
      (firstPayload.data as { resetUrl: string }).resetUrl,
    );

    // Segundo token: invalida al primero y queda como unico activo.
    expect((await forgot(doc)).status).toBe(200);
    const latestPayload = await outboxPayloadOf(userId);
    const latestToken = tokenFromResetUrl(
      (latestPayload.data as { resetUrl: string }).resetUrl,
    );
    expect(latestToken).not.toBe(firstToken);

    const res = await reset(latestToken, 'contrasena-nueva-2026');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const db = drizzle({ client: sql });
    const rows = await db.select().from(users).where(eq(users.id, userId));
    const hash = rows[0]?.passwordHash ?? '';
    expect(await hasher.verify(hash, 'contrasena-nueva-2026')).toBe(true);
    expect(await hasher.verify(hash, 'contrasena-original-1')).toBe(false);

    const tokens = await tokensOf(userId);
    const consumed = tokens.find((t) => t.tokenHash === sha256(latestToken));
    const superseded = tokens.find((t) => t.tokenHash === sha256(firstToken));
    expect(consumed?.usedAt).not.toBeNull();
    // El token anterior quedo invalidado al solicitar el nuevo.
    expect(superseded?.invalidatedAt).not.toBeNull();
    // Ningun token queda activo: el consumido y los demas invalidados.
    expect(
      tokens.filter((t) => t.usedAt === null && t.invalidatedAt === null),
    ).toHaveLength(0);
  });

  it('reset da el MISMO error para token invalido, expirado y usado', async () => {
    const doc = uniqueDoc();
    const userId = await registerUser(doc);
    expect((await forgot(doc)).status).toBe(200);
    const payload = await outboxPayloadOf(userId);
    const token = tokenFromResetUrl(
      (payload.data as { resetUrl: string }).resetUrl,
    );

    // Invalido (basura que no coincide con ningun hash).
    const invalid = await reset(
      'esto-no-es-un-token-valido',
      'nueva-clave-2026',
    );
    const invalidBody = (await invalid.json()) as { error: Json };

    // Usado (tras exito).
    expect((await reset(token, 'nueva-clave-2026')).status).toBe(200);
    const used = await reset(token, 'otra-clave-2026');
    const usedBody = (await used.json()) as { error: Json };

    // Expirado (fila directa con expires_at en el pasado).
    const expiredUserId = newId();
    const expiredToken = 'token-expirado-para-prueba';
    const db = drizzle({ client: sql });
    await db.insert(users).values({
      id: expiredUserId,
      documentType: 'CC',
      documentNumber: uniqueDoc(),
      firstName: 'Exp',
      lastName: 'Irado',
      birthDate: '1990-01-01',
      gender: 'other',
      email: uniqueEmail(),
      phone: '+573001112233',
      addressLine: 'Cra 1 # 1-1',
      city: 'Bogota',
      passwordHash: 'x',
    });
    createdUserIds.push(expiredUserId);
    await db.insert(passwordResetTokens).values({
      id: newId(),
      userId: expiredUserId,
      tokenHash: sha256(expiredToken),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      correlationId: 'it-expired',
    });
    const expired = await reset(expiredToken, 'nueva-clave-2026');
    const expiredBody = (await expired.json()) as { error: Json };

    for (const [status, body] of [
      [invalid.status, invalidBody],
      [used.status, usedBody],
      [expired.status, expiredBody],
    ] as const) {
      expect(status).toBe(400);
      expect(body.error.code).toBe('PASSWORD_RESET_INVALID');
      expect(body.error.message).toBe(
        'El enlace de restablecimiento no es valido o ha expirado.',
      );
    }
  });

  it('reset rechaza reutilizar la contrasena actual sin consumir el token', async () => {
    const doc = uniqueDoc();
    const userId = await registerUser(doc, 'misma-contrasena-1');
    expect((await forgot(doc)).status).toBe(200);
    const payload = await outboxPayloadOf(userId);
    const token = tokenFromResetUrl(
      (payload.data as { resetUrl: string }).resetUrl,
    );

    const res = await reset(token, 'misma-contrasena-1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // El token sigue activo: no se consumio.
    const tokens = await tokensOf(userId);
    expect(
      tokens.filter((t) => t.usedAt === null && t.invalidatedAt === null),
    ).toHaveLength(1);
  });

  it('dos reset concurrentes con el mismo token: solo uno gana', async () => {
    const doc = uniqueDoc();
    const userId = await registerUser(doc);
    expect((await forgot(doc)).status).toBe(200);
    const payload = await outboxPayloadOf(userId);
    const token = tokenFromResetUrl(
      (payload.data as { resetUrl: string }).resetUrl,
    );

    const [a, b] = await Promise.all([
      reset(token, 'concurrente-clave-a1'),
      reset(token, 'concurrente-clave-b2'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
  });

  it('ambos endpoints responden 429 con Retry-After cuando se supera el limite', async () => {
    const built = buildTestApp(sql, {
      limits: { ...TEST_ROUTE_LIMITS, forgotIpMax: 2, resetIpMax: 1 },
    });
    const doc = uniqueDoc();

    const r1 = await built.app.request('/auth/password/forgot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.9.9.1',
      },
      body: JSON.stringify({ documentType: 'CC', documentNumber: doc }),
    });
    const r2 = await built.app.request('/auth/password/forgot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.9.9.1',
      },
      body: JSON.stringify({ documentType: 'CC', documentNumber: doc }),
    });
    const r3 = await built.app.request('/auth/password/forgot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.9.9.1',
      },
      body: JSON.stringify({ documentType: 'CC', documentNumber: doc }),
    });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get('Retry-After')).toBeTruthy();
    expect(r3.headers.get('Cache-Control')).toBe('no-store');
    const body = (await r3.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');

    // Otra IP no esta bloqueada por la IP anterior.
    const otherIp = await built.app.request('/auth/password/forgot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.9.9.2',
      },
      body: JSON.stringify({ documentType: 'CC', documentNumber: uniqueDoc() }),
    });
    expect(otherIp.status).toBe(200);
  });

  it('los logs capturados no contienen token, URL ni email', () => {
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('resetUrl');
    expect(serialized).not.toContain('#token=');
    expect(serialized).not.toContain('@example.com');
    expect(serialized).toMatch(/"userId"/);
  });

  it('medicion de tiempo forgot (informativa, sin asertacion): existente vs inexistente', async () => {
    // El camino existente hace token+SHA-256+2 inserts; el inexistente solo
    // consulta. Se mide para documentar la diferencia residual; no se
    // aserta para no generar pruebas flaky y no se anade retardo artificial
    // (sobreingenieria): sobre red el jitter domina la diferencia local.
    const doc = uniqueDoc();
    await registerUser(doc);
    const runs = 5;
    const timeOf = async (target: string): Promise<number> => {
      const start = performance.now();
      for (let i = 0; i < runs; i += 1) {
        expect((await forgot(target)).status).toBe(200);
      }
      return (performance.now() - start) / runs;
    };
    const knownMs = await timeOf(doc);
    const unknownMs = await timeOf(uniqueDoc());
    // Diferencia observable en este entorno (se reporta en el resumen de la etapa 8).
    console.log(
      `[timing] forgot existente=${knownMs.toFixed(1)}ms inexistente=${unknownMs.toFixed(1)}ms delta=${(knownMs - unknownMs).toFixed(1)}ms`,
    );
    expect(knownMs).toBeGreaterThanOrEqual(0);
    expect(unknownMs).toBeGreaterThanOrEqual(0);
  });
});
