import { describe, expect, it } from 'vitest';

import {
  normalizeDocumentNumber,
  normalizePhoneToE164,
} from '../../src/features/register/register.normalize.js';
import { RegisterSchema } from '../../src/features/register/register.schema.js';

const BASE = {
  firstName: 'Maria Fernanda',
  lastName: 'Gomez Rojas',
  birthDate: '1995-03-21',
  gender: 'female',
  email: 'maria.gomez@example.com',
  phone: '+573001234567',
  addressLine: 'Cra 15 # 93-60 Apto 402',
  city: 'Bogota',
  documentType: 'CC',
  documentNumber: '1020304050',
  password: 'correcta-segura-99',
  confirmPassword: 'correcta-segura-99',
} as const;

describe('RegisterSchema', () => {
  it('acepta entrada valida y normaliza email', () => {
    const parsed = RegisterSchema.parse({
      ...BASE,
      email: '  MARIA@Example.COM ',
    });
    expect(parsed.email).toBe('maria@example.com');
  });

  it('normaliza telefono local a E.164', () => {
    expect(normalizePhoneToE164('3001234567')).toBe('+573001234567');
    expect(normalizePhoneToE164('003001234567'.replace('00', '00'))).toMatch(
      /^\+/,
    );
    const parsed = RegisterSchema.parse({ ...BASE, phone: '3001234567' });
    expect(parsed.phone).toBe('+573001234567');
  });

  it('normaliza documento', () => {
    expect(normalizeDocumentNumber(' 1020-304.050 ')).toBe('1020304050');
  });

  it('rechaza fecha futura', () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = RegisterSchema.safeParse({ ...BASE, birthDate: tomorrow });
    expect(res.success).toBe(false);
  });

  it('rechaza fecha incoherente (>120 anos)', () => {
    const res = RegisterSchema.safeParse({ ...BASE, birthDate: '1800-01-01' });
    expect(res.success).toBe(false);
  });

  it('rechaza fecha imposible', () => {
    const res = RegisterSchema.safeParse({ ...BASE, birthDate: '2026-02-30' });
    expect(res.success).toBe(false);
  });

  it('rechaza nombre sin letras y apellido vacio', () => {
    expect(
      RegisterSchema.safeParse({ ...BASE, firstName: '123' }).success,
    ).toBe(false);
    expect(RegisterSchema.safeParse({ ...BASE, lastName: '  ' }).success).toBe(
      false,
    );
  });

  it('rechaza email invalido y telefono invalido', () => {
    expect(
      RegisterSchema.safeParse({ ...BASE, email: 'no-es-email' }).success,
    ).toBe(false);
    expect(RegisterSchema.safeParse({ ...BASE, phone: 'abc' }).success).toBe(
      false,
    );
  });

  it('rechaza password corta, comun o sin confirmar', () => {
    expect(
      RegisterSchema.safeParse({
        ...BASE,
        password: 'corta1',
        confirmPassword: 'corta1',
      }).success,
    ).toBe(false);
    expect(
      RegisterSchema.safeParse({
        ...BASE,
        password: 'password123',
        confirmPassword: 'password123',
      }).success,
    ).toBe(false);
    expect(
      RegisterSchema.safeParse({ ...BASE, confirmPassword: 'otra' }).success,
    ).toBe(false);
  });

  it('rechaza genero y tipo documento fuera del enum', () => {
    expect(RegisterSchema.safeParse({ ...BASE, gender: 'x' }).success).toBe(
      false,
    );
    expect(
      RegisterSchema.safeParse({ ...BASE, documentType: 'XX' }).success,
    ).toBe(false);
  });
});
