# Handover — Kenko Auth (`register` y `password-reset` hechos, resto pendiente)

> Resumen para un agente que continúe el trabajo. Alcance completado:
> **`Register` y `Recuperación de contraseña` (forgot/reset)**.
> Pendientes: **login, MFA**. Leer `AGENTS.md` primero.

## 1. Estado

- `POST /auth/register` → 201 `{data:{userId}}`, 400 inválido, 409 genérico en duplicado.
- `POST /auth/password/forgot` → 200 siempre igual (anti-enumeración); genera token
  (SHA-256 en DB) + outbox `PasswordResetRequested` en una transacción; 429 rate limit.
- `POST /auth/password/reset` → 200; `400 PASSWORD_RESET_INVALID` único para
  inválido/expirado/usado; consumo atómico + cambio de hash Argon2id en una transacción.
- `GET /health` → 200. Rama `password-reset`, sin commitear al escribir este handover.
- Tests: 45 unitarias + 14 integración en verde. `tsc` y Biome `check` limpios.
- OpenAPI: `docs/openapi.yaml` (endpoints de reset).

## 2. Stack (versiones exactas en `package.json`)

Bun 1.4.3 · Hono 4.13.13 · Zod 4.6.7 (API v4: `z.email()`, `z.iso.date()`, `z.uuidv7()`)
· Drizzle ORM 0.45.4 sobre SQL nativo de Bun (`drizzle-orm/bun-sql`) · `argon2` 0.45.1
· `@aws-sdk/client-eventbridge` 3.1152.0 · `@hono/zod-validator` 0.9.1 (devDep por
decisión del dueño) · Winston · `uuid` (v7) · Biome 2.5.15 (espacios ×2, comillas simples).

## 3. Arquitectura (no negociable)

- Vertical slice con puertos y adaptadores: `features/` declara `*.port.ts` y **nunca**
  importa de `infra/`; `container.ts` inyecta. `register.service.ts` se prueba con fakes.
- Outbox transaccional (opción B: worker separado `bun run relay`, intervalo 5s, backoff
  5s/30s/5min/1h, `FOR UPDATE SKIP LOCKED`). Estados: `pending/sent/dead`.
- Contrato `UserRegistered` (AGENTS.md 5.3): envelope `PutEvents`
  (`Source: kenko.auth`, `DetailType: UserRegistered`, bus `kenko-dev-bus`) con `Detail`
  serializado `{metadata, data}`. **No mezclar** con el sobre que entrega EventBridge.
- Reglas/colas las crean los consumidores. ⚠️ Verificado Oct-2026: el bus existe pero
  **no tiene reglas** (`Rules: []`) y la única cola es `kenko-dev-profile-auth` (nombres
  distintos a la especificación). Coordinar con Profile/Notifications antes del e2e.

## 4. Decisiones de negocio confirmadas

- Todos los campos obligatorios. Nombres: trim + ≥1 letra (Unicode).
- `birthDate`: `date` real, no futura, ≤120 años. Sin mayoría de edad (hay menores con TI).
- Enums cerrados ampliables: `gender male|female|other`, `document CC|TI|CE|PA`
  (dueños en `features/user`; columnas `text` sin enum PG).
- Unicidad: `email` + par `(document_type, document_number)`. Duplicado → **409 genérico**
  (anti-enumeración, Ley 1581), sin distinguir campo.
- Teléfono: normaliza a **E.164** (10 dígitos `3…` → `+57`); email a minúsculas;
  documento a mayúsculas sin separadores. Nombres/dirección: solo trim.
- Password: min 8 / máx 128, sin clases obligatorias, mini deny-list, `confirmPassword`
  solo valida. Argon2id `m=19456, t=2, p=1` (configurable), abstracción `PasswordHasher`.
- `correlationId`: reutiliza `X-Correlation-Id` válido o genera UUIDv7. IDs con UUIDv7.
- `timestamptz` para instantes, `date` para nacimiento. Sin fallback RDS→local (falla y
  reporta). Credenciales AWS por cadena estándar, nunca en código.

## 5. Convenciones de código

- Funciones flecha en todo `src/` y tests (sin `function`).
- Cero números/strings mágicos: `shared/http-status|headers|log-events|service|
request-limits`, `register.limits`, `event|relay|argon2.constants`.
- Tipos con `as const` + uniones (sin `enum` por `erasableSyntaxOnly`), `import type`,
  retornos explícitos. Rutas Hono con `app.route()`, `zValidator`, `createMiddleware`.
- Logs estructurados solo con IDs (`userId/eventId/correlationId`); jamás PII, passwords
  ni secretos. Errores al cliente: `{error:{code,message,correlationId}}` genéricos.

## 6. Comandos

```sh
bun install
docker compose up -d          # nunca -v salvo reset (borra datos)
bun run db:migrate            # runner Bun propio (drizzle-kit migrate exige driver pg)
bun run dev                   # API (verifica DB al arrancar, exit 1 si cae)
bun run relay                 # worker, otra terminal, requiere credenciales AWS
bun run test                  # unitarias (Node) | test:integration (Bun+PG)
bun run typecheck | lint | format
```

`POSTGRES_URL` con `?connect_timeout` lo depura `client.ts` solo. `db:generate` solo
ante cambios de esquema (verificado: sin deriva).

## 7. Hallazgos conocidos

- El stack Bun+Drizzle guarda el `jsonb` doblemente codificado; el relay lo normaliza
  con `normalizeDetail()` (test de regresión incluido; log `outbox.payload_normalized`).
  `MalformedDetail` en EventBridge = `Detail` entrecomillado, ya corregido y publicado OK.
- El contenedor Postgres del entorno se ha detenido solo un par de veces (pérdida de
  datos locales → re-migrar). No es bug del código.

## 8. Pendiente (para quien continúe)

1. Login (documento + contraseña), `MfaEnabled` (**sin contrato**).
   En el consumo atómico de reset quedó documentado el punto de extensión:
   revocar sesiones/refresh tokens en la MISMA transacción cuando existan.
2. **Coordinación Notifications (no es código de este repo):** la regla real
   `kenko-dev-auth-to-notifications` solo enruta `UserRegistered`; Notifications
   debe extender su patrón (o crear una regla) para `PasswordResetRequested`,
   y acordar la plantilla: construye la URL con su configuración base +
   fragmento `#token=` (el evento no lleva URL), idempotencia por `eventId`,
   tolerancia a duplicados. Verificado Oct-2026 (solo lectura): bus
   `kenko-dev-bus` con esa única regla; colas `kenko-dev-notifications-authentication`
   (+ DLQ, retención 24h/14d, SSE activo); no existen `kenko-dev-auth-to-profile`
   ni la cola de Profile que mencionaba el handover anterior.
3. Alarmas: `dead` en outbox debe alarmar (metric filter sobre
   `outbox.payload_dead` / CloudWatch) — pendiente de infra.
4. Terraform RDS: código listo en `terraform/`, `apply` manual del dueño (usuario `mayer`,
   password gestionada por RDS en Secrets Manager). `terraform/.terraform.lock.hcl` sin
   versionar (recomendado versionarlo).
5. Operación del relay en prod, alarmas de rezago, `Dockerfile` vacío, backend remoto de
   Terraform, `deletion_protection/multi_az`/VPC dedicada para prod.
6. Revisión jurídica Ley 1581/historia clínica (retención del payload con datos de
   contacto y token en outbox/DLQ) y tuning Argon2id en prod.
7. Para una feature nueva, clonar el recorte `register/` o `passwordreset/`:
   `types → schema → port → service (+fakes) → route → container → repo/migración →
   tests → relay agnostico (usa el eventType de la fila como DetailType)`.
