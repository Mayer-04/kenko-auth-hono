# Kenko Authentication — Análisis detallado para Microservicios y Frontend

> Fuente: código real del repositorio `kenko-auth-hono`.
> Contratos exactos: `docs/openapi.yaml` (v0.5.0), `README.md`, `frontend-auth-ux.md`.
> Fecha de análisis: 2026-11-16. No se ejecutaron tests ni se verificó AWS.

## 0. Resumen ejecutivo

Microservicio **Authentication** del portal Kenko (EPS Colombia). Responsabilidades:

* Registro de usuarios (`register`).
* Login con documento + contraseña, emisión de JWT + refresh opaco, rotación con reuse-detection, logout global.
* Recuperación por enlace con token de un solo uso (`forgot` / `reset`).
* Cuenta autenticada: cambio de contraseña, cambio de email, identidad mínima (`me`).
* Productor de eventos hacia **Amazon EventBridge** (`kenko-dev-bus`) con patrón **Transactional Outbox + Relay** sobre PostgreSQL.
* No consume eventos.

Stack: `Bun + TypeScript + Hono 4.13.18`, `PostgreSQL 18 + Drizzle ORM 0.45.4`, `Zod 4.6.7`, `Argon2id (argon2 0.45.2)`, `jose 6.2.17 (JWT HS256)`, `Winston 3.19.0`, `AWS SDK EventBridge 3.1166.0`, `Terraform (Lambda relay + ECR + IAM + Logs)`.

Arquitectura: **Vertical Slice con Puertos y Adaptadores**.
`src/features/*` contiene dominio y casos de uso sin importar `src/infra/*`.
Único cableado en `src/container.ts:86`. Rutas ensambladas en `src/app.ts:76`.

---

## 1. Estructura del código

```text
src/
  app.ts                 # Hono, CORS, bodyLimit 64KiB, correlation, rutas, 404/500
  container.ts           # DI: DB, repos, hasher, JWT, tokens, rate-limiter, servicios
  index.ts               # API HTTP, SELECT 1 pre-arranque, fail-fast
  relay.ts               # Worker loop outbox -> EventBridge (SIGINT/SIGTERM)
  relay-handler.ts       # Variante Lambda + aws-lambda-adapter (/health readiness)
  config/
    env.ts               # loadEnv / parseEnv / resolveDatabase
    cors.ts              # allowlist cerrada
    logger.ts            # Winston dev color vs prod JSON
  features/
    register/            # register.schema|service|route|port|types|limits|normalize
    login/               # login.schema|service|route|port|types|limits
    passwordreset/       # passwordreset.schema|service|route|port|types|limits
    account/             # account.schema|service|route|port|types + me
    user/                # user.types (DOCUMENT_TYPES, GENDERS), user.port|types
    mfa/                 # vacía (.gitkeep), fuera de alcance
  infra/
    db/schema/           # user.table, outbox.table, refresh-session.table, password-reset.table
    db/repositories/     # user, outbox, refresh-session, password-reset
    db/client.ts         # createDb
    db/migrate.ts        # runner migraciones
    events/              # event.constants, eventbridge-client/publisher, outbox-relay, relay.constants
    token/               # jwt-signer (HS256), refresh-token (opaco SHA-256)
    password/            # argon2-hasher + argon2.constants
    security/            # reset-token (opaco)
    ratelimit/           # in-memory-rate-limiter
  shared/
    errors.ts            # AppError + códigos estables
    http.ts              # ok/created/errorHandler/notFoundHandler, sobre {data}/{error}
    http-status.ts       # constantes HTTP
    validation.ts        # validationErrorHook Zod -> sobre común
    cookies.ts           # kenko_refresh httpOnly
    headers.ts           # CORRELATION_ID_HEADER, REFRESH_COOKIE_NAME, etc.
    ids.ts               # newId UUIDv7, resolveCorrelationId
    log-events.ts        # constantes de eventos de log
    request-limits.ts    # 64KiB, PORT_MIN/MAX
    service.ts           # SERVICE_NAME
    db-errors.ts         # isUniqueViolation (23505)
    middleware/          # correlation, request-logger, require-auth, no-store
    ratelimit/           # ratelimit.port + rate-limit-http (Retry-After, RateLimit-*)
docs/
  openapi.yaml           # v0.5.0, contrato exacto
  guia-postman-bruno.md  # orden de pruebas E2E
  logging.md             # qué se loguea y cómo buscar por correlationId
  password-reset.md      # detalle forgot/reset
  relay-lambda.md        # operación del relay en Lambda
frontend-auth-ux.md      # guía UX + 3 propuestas (recomienda A+B)
tests/unit (22) + tests/integration (4)
terraform/               # backend, ecr, iam, lambda, locals, logs, outputs, variables
compose.yml              # postgres:18 local
drizzle.config.ts        # reutiliza loadEnv/resolveDatabase
```

---

## 2. Configuración, arranque y transversales

### 2.1 Variables de entorno (`src/config/env.ts:52`, `.env.example:1`)

| Variable | Regla |
|---|---|
| `PORT` | int requerido |
| `ENVIRONMENT` | `development\|test\|production` |
| `EVENT_BUS_NAME` | default `kenko-dev-bus` |
| `AWS_REGION` | opcional, SDK resuelve por cadena estándar (no va en código) |
| `POSTGRES_URL` | `z.url()` requerida (local Docker) |
| `AWS_RDS_POSTGRES_URL` | opcional, `z.url()`. Si definida → target `rds`, si no → `local` |
| `PORTAL_BASE_URL` | default `http://localhost:8080`, usada para `resetUrl` |
| `CORS_ORIGINS` | CSV opcional, default dev `localhost\|127.0.0.1:3000,3001,3100,5000,5500,8000,8080` |
| `JWT_SECRET` | min 32 chars, nunca versionar ni loguear. Generar con `openssl rand -base64 32` |
| `JWT_ISSUER` | default `kenko-auth` |
| `JWT_AUDIENCE` | default `kenko-api` |

* `parseEnv()` es puro y testeable. `loadEnv()` memoriza, loguea `configuration.invalid` en stderr sin valores y hace `exit(1)`.
* `resolveDatabase()` (`src/config/env.ts:215`): prioridad RDS si su URL está definida. **Sin fallback silencioso**: si RDS falla, se reporta `database.unreachable` y no se arranca. Log `database.target {host,port,database}` sin usuario/password.
* `src/index.ts:33` hace `SELECT 1` antes de escuchar.
* `drizzle.config.ts:16` reutiliza el mismo `loadEnv/resolveDatabase` para migraciones.

### 2.2 HTTP global (`src/app.ts:76`)

* CORS primero (preflight antes de `bodyLimit/auth`): allowlist cerrada, `credentials:true`, sin `*` por cookie httpOnly.
* `secureHeaders()` siempre.
* `bodyLimit 64KiB` → `413 {error:{code:VALIDATION_ERROR,message:Cuerpo demasiado grande.,correlationId,details:[]}}` (`src/app.ts:97`).
* `correlationMiddleware` + `requestLogger`: propaga `X-Correlation-Id` (reutiliza si es UUID válido, si no genera UUIDv7), lo devuelve en respuesta y en `error.correlationId`.
* `GET /health → 200 {data:{status:ok}}`, excluido de logs.
* `notFoundHandler → 404 NOT_FOUND Recurso no encontrado.` `errorHandler → AppError` con sobre común, resto `500 INTERNAL_ERROR`.
* Sobre éxito `{data:T}` vía `ok()` / `created()`. Sobre error `{error:{code,message,correlationId,details?}}`. `details` solo en `VALIDATION_ERROR` (`src/shared/http.ts:26`, `src/shared/validation.ts:81`).
* `429` incluye `Retry-After` + `RateLimit-Limit/Remaining:0/Reset` (`src/shared/ratelimit/rate-limit-http.ts:1`).
* Respuestas sensibles con `Cache-Control: no-store` (`src/shared/middleware/no-store.ts:1`).

### 2.3 Auth middleware (`src/shared/middleware/require-auth.ts:26`)

* Exige `Authorization: Bearer <accessToken>`.
* Verifica firma `HS256`, `iss`, `aud`, `exp`, exige `sub` y `jti`. Cualquier fallo → mismo `401 UNAUTHORIZED Credenciales inválidas.` sin distinguir motivo.
* Fija `userId (sub)` y `sessionFamilyId (sid, ausente en tokens pre-sid)` en contexto. Nunca loguea el token.
* Aplicado en `src/app.ts:152` a `/auth/password/change`, `/auth/email/change`, `/auth/me`.

### 2.4 Cookies (`src/shared/cookies.ts:40`)

* Nombre `kenko_refresh`. Lectura `refreshTokenFromCookie()`.
* Fijar: `kenko_refresh=<opaco>; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax; Secure(si https)`.
* Limpiar logout: `Max-Age=0`.
* `login/refresh/logout` fijan/limpian cookie además del JSON (compatibilidad sin `localStorage`).

---

## 3. Funcionalidades y endpoints

Todos los ejemplos de cuerpos/estados están en `docs/openapi.yaml:18` y `docs/guia-postman-bruno.md:18`.

### 3.1 `POST /auth/register` → `201` (`src/features/register/`)

**Uso:** crear cuenta.

Request (todos obligatorios):

| Campo | Reglas (Zod + normalización) |
|---|---|
| `firstName` | `trim`, 1–100, `≥1 letra Unicode /\pL/u` |
| `lastName` | igual |
| `birthDate` | `YYYY-MM-DD`, `<=hoy UTC`, `>=hoy-120a` |
| `gender` | `male\|female\|other` |
| `email` | `trim+lower`, `z.email()`, max 254 |
| `phone` | normaliza a E.164: quita espacios/guiones/puntos/paréntesis, `00→+`, `10 díg. ^3→+57`, valida `^\+[1-9]\d{7,14}$`. Ej `+573001234567` |
| `addressLine` | `trim`, 1–200 |
| `city` | `trim`, 1–100 |
| `documentType` | `trim+upper ∈ CC\|TI\|CE\|PA` |
| `documentNumber` | sin espacios/puntos/guiones, upper, `^[A-Z0-9]{4,20}$` |
| `password` | 8–128, espacios cuentan, blacklist `password,password123,12345678,123456789,qwerty123,colombia123,kenko1234` (case-insensitive) |
| `confirmPassword` | idéntica a `password`, no se persiste |

Negocio (`src/features/register/register.service.ts:21`):

1. `newUserId() + newEventId() UUIDv7`, `occurredAt ISO UTC`.
2. `findByEmail + findByDocument` en paralelo → si existe alguno → `409` genérico + `register.failed warn` (anti-enumeración).
3. `argon2.hash(password)`.
4. Tx `createWithOutbox`: `INSERT users + INSERT outbox pending UserRegistered`. Carrera `23505 → 409` genérico.
5. `register.succeeded info {userId,eventId,correlationId}`.

Respuestas:

* `201 {data:{userId,maskedEmail}}` donde `maskedEmail=m***@dominio` (`src/features/register/register.normalize.ts:1`).
* `400 VALIDATION_ERROR` + `details:[{field,message}]` por campo.
* `409 REGISTER_CONFLICT No se pudo completar el registro.`
* `500 INTERNAL_ERROR`.

Frontend: mostrar `Te enviamos un correo de bienvenida a m***@dominio`. No reconstruir email completo. `409` → `No pudimos crear tu cuenta con estos datos. Revisa documento y correo o recupera contraseña.` (no indicar cuál existe).

### 3.2 `POST /auth/login` → `200` (`src/features/login/`)

Request `{documentType CC|TI|CE|PA, documentNumber ^[A-Z0-9]{4,20}$ normalizado, password 1–128 no vacía}`.
Rate: `IP 10/15min + documento 5/15min` (`src/features/login/login.limits.ts:1`).

Servicio (`src/features/login/login.service.ts:29`):

1. `findByDocument` → si null → `401` genérico + `login.failed`.
2. `argon2.verify` → si falla → mismo `401`.
3. Emite `access JWT HS256 15min (900s)` con claims `sub=userId, sid=familyId, iss, aud, exp, iat, jti`, header `kid`, + `refresh opaco 7d` (random, solo `SHA-256` en DB) + `createLoginSession active` en familia nueva UUIDv7.
4. `login.succeeded info {userId,sessionId,familyId,jwtId}`.

Respuestas:

* `200 {data:{accessToken,refreshToken,expiresIn:900}}` + `Set-Cookie kenko_refresh` + `Cache-Control: no-store`.
* `400` forma, `401 UNAUTHORIZED Credenciales inválidas.` único, `429`.
* No publica eventos.

Frontend: guardar nada en `localStorage` (usar cookie), llamar `GET /auth/me` para saludo, no decodificar JWT.

### 3.3 `POST /auth/refresh` → `200` (silencioso)

Entrada `{refreshToken?}` opcional: `body (prioridad) ?? Cookie kenko_refresh`, nunca URL. Si falta en ambos → `400` preservado. Rate `IP 20/15min`.

Servicio (`src/features/login/login.service.ts:112`):

* Hash `SHA-256` + `timingSafeEqual`, busca por hash. Basura → mismo `401`.
* Si `status==rotated` (ya usado o carrera) → `revokeFamily(familyId)` + `login.reuse_detected warn` + `401`.
* Si `revoked|expirado (expiresAt<=now)|desconocido` → `401`.
* Si `active` vigente: firma nuevo JWT + genera nuevo refresh, tx `rotateSession(old→rotated, new active misma familia)`. Si pierde carrera y el token ya está `rotated` → también revoca familia.
* `login.refreshed info`.

Respuestas: `200` par nuevo + cookie rotada; `400/401/429`. Sin UI propia: frontend lo ejecuta en background; si `401` → ir a login (+aviso `Cerramos tus sesiones por seguridad` si hubo revocación).

### 3.4 `POST /auth/logout` → `200` siempre

Misma resolución token. Rate `IP 20/15min`.
Servicio (`src/features/login/login.service.ts:201`): si token conocido → `revokeAllUserSessions(userId)` (todas familias/dispositivos) + `login.logged_out info`; si desconocido → no hace nada. Ambos `200 {data:{}}` + limpia cookie + `no-store`. Idempotente: frontend limpia estado local aunque falle red.

### 3.5 `POST /auth/password/forgot` → `200` siempre

Request `{documentType,documentNumber}`. Rate `IP 10/15min + doc 3/15min + cooldown 1/60s` (`src/features/passwordreset/passwordreset.limits.ts:1`).

Servicio (`src/features/passwordreset/passwordreset.service.ts:36`): si no existe → `password_reset.request_unknown warn` sin escribir. Si existe: `token opaco random (TOKEN_RANDOM_BYTES)`, `eventId UUIDv7`, `expiresAt now+30min`, `resetUrl=<PORTAL_BASE_URL>/reset#token=<token>` (fragmento, nunca query), tx `createTokenWithOutbox (invalida previos + crea token hash SHA-256 + outbox PasswordResetRequested pending)`, log `password_reset.requested info`.

Respuestas: siempre `200 {data:{}}` exista o no (anti-enumeración). `400` forma, `429`.
Frontend: `Si tus datos son correctos, te enviamos un correo. Revisa bandeja y spam.`

### 3.6 `POST /auth/password/reset` → `200`

Request `{token min1 opaco (en BODY, nunca URL), password 8–128+blacklist, confirmPassword igual}`. Rate `IP 10/15min`.

Servicio (`src/features/passwordreset/passwordreset.service.ts:109`): `findActiveTokenByHash (used IS NULL AND invalidated IS NULL AND expires>now)` → si null → `PASSWORD_RESET_INVALID 400`. Verifica usuario existe, `nueva != actual (argon2.verify)` si no `VALIDATION_ERROR`, `argon2.hash(nueva)`, `consumeTokenAndUpdatePassword` atómico (solo una gana en concurrencia) + revoca `refresh_sessions active`. Log `password_reset.completed`.

Respuestas: `200`; `400 VALIDATION_ERROR` (forma o igual a actual); `400 PASSWORD_RESET_INVALID El enlace no es válido o ha expirado.` único; `429`.
Token del enlace en local se obtiene de `outbox.payload.data.resetUrl` tras `#token=` (`docs/guia-postman-bruno.md:27`).

### 3.7 `GET /auth/me` → `200`

Requiere `Bearer`. Sin rate propio. Lee `findAccountById(sub)`; si no existe → `401` genérico + `me.failed warn`. Éxito no se loguea (ruido, cubierto por `http.request`).
Responde `200 {data:{userId,firstName,email}}` + `no-store`. Es identidad mínima para UI; `Profile` sigue dueño del perfil completo.

### 3.8 `POST /auth/password/change` → `200`

Requiere `Bearer`. Body `{currentPassword min1, newPassword 8–128+blacklist}` (sin `confirmPassword` en backend; frontend lo confirma). Rate `IP 20/15min + user 5/10min` (`src/features/account/account.limits.ts:1`).

Servicio (`src/features/account/account.service.ts:73`): `requireAccountWithPassword` → si actual mala o cuenta null → `401 Contraseña actual incorrecta.` + `password.change_failed`. Si `nueva==actual` (string u hash) → `400 La contraseña no puede ser igual a la actual.` Si contiene `email|firstName|lastName` completos case-insensitive → `400 La nueva contraseña no puede contener tu correo o tu nombre.` Si ok: `argon2.hash` + tx `changePasswordAndRevokeOthers (hash nuevo + revoca active de otras familias + invalida resets pendientes)` (`src/infra/db/repositories/user.repository.ts:131`). Familia actual sobrevive (con token pre-`sid` revoca todo). No publica eventos. Log `password.changed info`.

### 3.9 `POST /auth/email/change` → `200 {changed}`

Requiere `Bearer`. Body `{newEmail trim+lower email max254, currentPassword}`. Rate igual a change.

Servicio (`src/features/account/account.service.ts:138`): verifica actual; si `newEmail==actual` (normalizado) → `200 {changed:false}` sin escribir ni evento + `email.changed info` (idempotente). Si distinto: `findByEmail` → si ocupado → `409 UPDATE_CONFLICT No se pudo completar el cambio.` + `email.change_failed`. Si libre: `updateEmailWithOutbox (UPDATE email + INSERT outbox EmailChanged pending)` atómico; carrera `23505 → 409`. Sesiones no se tocan. Log `email.changed`.

---

## 4. Validación, normalización y errores

* Mensajes Zod en español vía `z.config(z.locales.es())` (`src/shared/validation.ts:14`). `validationErrorHook` unifica a `{error:{code:VALIDATION_ERROR,message:primerMensaje,correlationId,details:[{field?,message}]}}`.
* `PasswordFieldSchema` única fuente (`src/features/register/register.schema.ts:62`): reutilizada por register y passwordreset.
* Documento/email/teléfono normalizan con regla explícita; nombres/dirección solo `trim` (no colapsar espacios ni cambiar capitalización a propósito).
* `AppError` (`src/shared/errors.ts:34`): `code` estable + `status` mapeado. Helpers `registerConflict, invalidResetToken, reusedPassword, wrongCurrentPassword, passwordWithUserData, invalidCredentials, emailTaken, rateLimitedError, internalError`.
* `errorHandler` (`src/shared/http.ts:44`): `VALIDATION_ERROR → details:[]` si nace en servicio; `409/401/404` sin `details`.
* Catálogo frontend: `VALIDATION_ERROR 400`, `REGISTER_CONFLICT 409`, `UPDATE_CONFLICT 409`, `PASSWORD_RESET_INVALID 400`, `UNAUTHORIZED 401`, `RATE_LIMITED 429`, `NOT_FOUND 404`, `PAYLOAD_TOO_LARGE 413`, `INTERNAL_ERROR 500`. Usar `code`, mostrar `correlationId` como referencia.

---

## 5. Seguridad

* `Argon2id` (`src/infra/password/argon2-hasher.ts:1`, constantes en `argon2.constants.ts:1`). Interfaz `PasswordHasher` permite migrar algoritmo sin tocar casos de uso.
* Opacos (refresh, reset) nunca en claro en DB: solo `SHA-256`. Comparación `timingSafeEqual` para refresh.
* JWT `HS256` (`src/infra/token/jwt-signer.ts:37`): valida `alg==HS256`, `iss/aud/exp`, exige `sub/jti`. Interfaz `AccessTokenSigner/Verifier` permite migrar a `ES256+JWKS`. Limitación aceptada: con el secreto simétrico cualquier poseedor puede emitir.
* Access `15min`, refresh `7d`, reset `30min` (suposiciones de README/OpenAPI no verificadas en constantes de servicio salvo límites de rate).
* Anti-enumeración: `409` registro genérico, `401` login único, `200` forgot idéntico, `PASSWORD_RESET_INVALID` único, `409` email genérico.
* PII: nunca en logs (`password, tokens, resetUrl, email, documento, teléfono, bodies`). Solo IDs + `correlationId`. `GET /health` y éxito `GET /me` excluidos.
* `changePassword` revoca otras familias; `reset` revoca todas `active`; `refresh reuse` revoca familia completa; `logout` revoca todas del usuario. JWT ya emitido vive hasta `exp` (15min aceptado).
* Ley 1581 + historia clínica: eventos usan mínimos (`userId` + datos de contacto necesarios), payload redactado tras `sent/dead`, frontend debe pedir casilla Ley 1581 en registro.

---

## 6. Persistencia (PostgreSQL + Drizzle)

### 6.1 `users` (`src/infra/db/schema/user.table.ts:23`)

`id uuidv7 PK, document_type text, document_number text, first_name text, last_name text, birth_date date (calendario), gender text, email text, email_verified bool default false, phone text E.164, address_line text, city text, password_hash text, created_at timestamptz default now(), updated_at timestamptz`.
Únicos: `users_email_unique(email)`, `users_document_unique(type,number)`.
Enums como `text` sin check para ampliar `male/female/other` y `CC/TI/CE/PA` sin migración.

### 6.2 `outbox` (`src/infra/db/schema/outbox.table.ts:19`)

`id uuidv7 PK, event_id uuidv7 unique, aggregate_type default 'user', aggregate_id uuid, event_type text, event_version text, correlation_id text, payload jsonb, status pending|sent|dead default pending, attempts int default 0, next_attempt_at timestamptz, created_at, published_at null`.
Índices: `outbox_event_id_unique(event_id)`, `outbox_pending_idx(status,next_attempt_at)`.
Constantes `OutboxStatus`, `USER_AGGREGATE_TYPE`, `REDACTED_OUTBOX_PAYLOAD='{"redacted":true}'` (`src/infra/events/event.constants.ts:30`).

### 6.3 `refresh_sessions` (`src/infra/db/schema/refresh-session.table.ts:26`)

`id uuidv7, user_id FK users.id cascade, family_id uuidv7, token_hash text unique, status active|rotated|revoked default active, expires_at timestamptz, rotated_at null, revoked_at null, created_at, correlation_id`.
Índices `family, user`. Transacciones `createLoginSession, rotateSession (atómica), revokeFamily, revokeAllUserSessions` (`src/infra/db/repositories/refresh-session.repository.ts:1`).

### 6.4 `password_reset_tokens` (`src/infra/db/schema/password-reset.table.ts:12`)

`id uuidv7, user_id FK cascade, token_hash unique, expires_at, used_at null, invalidated_at null, created_at, correlation_id`.
Activo = `used IS NULL AND invalidated IS NULL AND expires>now`. Consumo `UPDATE condicional` atómico (`src/infra/db/repositories/password-reset.repository.ts:1`).

Repositorios exponen puertos para features (`UserRepository`, `AccountReader`, `PasswordChangeStore`, `EmailChangeStore`, `OutboxRepository`).

---

## 7. Eventos para Profile y Notifications

### 7.1 Bus, reglas y colas (acordado en AGENTS.md 5.2, no verificado en AWS)

* Bus: `kenko-dev-bus` (`src/config/env.ts:24`, `DEFAULT_EVENT_BUS_NAME`, `terraform/variables.tf:29`).
* `Source` fijo `kenko.auth` (`src/infra/events/event.constants.ts:10`).
* Reglas (las crean/consumen otros equipos): `kenko-dev-auth-to-notifications`, `kenko-dev-auth-to-profile`.
* Colas (las crean los consumidores): `kenko-dev-profile-authentication + dlq`, `kenko-dev-notifications-authentication + dlq`.
* Auth solo publica, no crea colas/reglas/DLQ.

### 7.2 Envelope de publicación (`src/infra/events/eventbridge-publisher.ts:18`)

```json
{
  "Source": "kenko.auth",
  "DetailType": "UserRegistered",
  "EventBusName": "kenko-dev-bus",
  "Detail": "{\"metadata\":{...},\"data\":{...}}"
}
```

`DetailType` = `eventType` de la fila outbox (`UserRegistered|PasswordResetRequested|EmailChanged`).
`Detail` es string JSON serializado de `{metadata,data}`. Construido por `toPutEventsEntry()`.

> Al recibir desde EventBridge el sobre usa minúsculas: `source, detail-type, time, detail`. No mezclar formatos.

### 7.3 `UserRegistered`

* Cuándo: `POST /auth/register 201` (`src/features/register/register.service.ts:38`).
* Consumidores: `Profile` crea perfil base, `Notifications` welcome.
* `data`:

```json
{
  "metadata": {"eventId": "uuidv7", "eventVersion": "1", "occurredAt": "2026-10-13T20:15:30Z", "correlationId": "uuidv7"},
  "data": {
    "userId": "uuidv7",
    "document": {"type": "CC", "number": "1020304050"},
    "person": {"firstName": "Maria Fernanda", "lastName": "Gomez Rojas", "birthDate": "1995-03-21", "gender": "female"},
    "contact": {"email": "maria.gomez@example.com", "emailVerified": false, "phone": "+573001234567"},
    "address": {"line": "Cra 15 # 93-60 Apto 402", "city": "Bogota"}
  }
}
```

### 7.4 `PasswordResetRequested` (v1.1)

* Cuándo: `forgot` con documento existente.
* Consumidor: `Notifications` envía correo con enlace.
* `data: {userId, email, firstName, resetUrl:<PORTAL_BASE_URL>/reset#token=<opaco>, expiresAt}`.
* `resetToken` no viaja suelto, solo en fragmento `#token=`. TTL 30min, solo hash en DB, payload redactado tras `sent/dead`. Todo el payload es secreto, nunca loguear URL/token.

### 7.5 `EmailChanged`

* Cuándo: `POST /auth/email/change` con `changed:true` (`src/features/account/account.service.ts:165`).
* Consumidores: `Profile` actualiza proyección email por `userId`, `Notifications` notifica a `oldEmail`.
* `data: {userId, oldEmail, newEmail, firstName}` + `metadata` común. Sin TTL, cambio inmediato.

### 7.6 Garantías que deben asumir los consumidores

* At-least-once: idempotentes por `eventId` (único en outbox), tolerar duplicados/desorden. Clave natural `userId` para upsert en Profile.
* Publicación confiable: tx `dominio+outbox pending` + relay separado (opción B). Sin doble escritura.
* Relay (`src/infra/events/outbox-relay.ts:50`): `claimPending BATCH_LIMIT (10, límite PutEvents) FOR UPDATE SKIP LOCKED`, `normalizeDetail()` (acepta objeto o string doblemente serializado por bug Bun+Drizzle documentado), `PutEvents` 1x1, éxito → `markSent + redacta payload`, `ErrorCode` → `reschedule(attempts+1, backoffSeconds)`, payload irreparable → `markDead + outbox.payload_dead error`. Backoff `5s,30s,5min,tope 1h` (`relay.constants.ts:1`). No envía `TraceHeader` (el `correlationId` ya va en `Detail.metadata`).
* Logs relay: `outbox.published info {eventId,eventType}`, `outbox.publish_failed warn {attempts,error}`, `outbox.payload_dead error`, `payload_normalized warn`.
* Ejecución: `bun run relay` loop (`src/relay.ts:18`) o `bun run relay:lambda` en Lambda con Scheduler 1/min (pendiente DB en AWS, actualmente sin Scheduler/VPC — `terraform/lambda.tf:1`).

---

## 8. Logs y observabilidad (`docs/logging.md:1`, `src/shared/log-events.ts:8`)

JSON `{service,timestamp,level,message=evento,campos}`. Dev con color, prod JSON para CloudWatch.

| Evento | Nivel | Campos |
|---|---|---|
| `http.request` | `info 2xx / warn 4xx / error 5xx` | `method,route,status,latencyMs,correlationId,userId?` |
| `register.succeeded/failed` | `info/warn` | `userId,eventId` / solo `correlationId` |
| `login.succeeded/refreshed/logged_out` | `info` | `userId,session/family/jwt` |
| `login.failed/refresh_failed/reuse_detected/rate_limited` | `warn` | `correlationId` o `scope,limit` |
| `password_reset.requested/completed` | `info` | `userId,eventId` |
| `password_reset.request_unknown/rate_limited` | `warn` | `correlationId` / `scope,limit` |
| `password/email.changed`, `me.failed`, `account.rate_limited` | `info/warn` | `userId` / `correlationId` |
| `outbox.published/publish_failed/payload_dead` | `info/warn/error` | `eventId,eventType,attempts,error` |
| `server/relay/database` | `info/error` | `port/target` |

Búsqueda: frontend muestra `error.correlationId` + header `X-Correlation-Id` como código de referencia. En CloudWatch filtrar `correlationId="<uuid>"` y seguir `http.request → negocio → outbox.published`.

---

## 9. Infra AWS actual (Terraform)

* `variables.tf:1`: `aws_region default us-east-1, project kenko, service auth, environment dev, app_environment development, event_bus_name kenko-dev-bus, image_tag 0.1.1, lambda 512MB/30s, log 14d, postgres_url sensitive, jwt_secret sensitive, portal_base_url, jwt_issuer/audience`.
* `lambda.tf:1`: función imagen `...-relay` `arm64`, env `PORT/ENVIRONMENT/EVENT_BUS/PORTAL/POSTGRES/JWT/* + AWS_LWA_READINESS_CHECK_PATH=/health`. Sin VPC (sin RDS no aporta, quita internet), sin Scheduler (sin DB solo daría 500s), sin concurrencia reservada por tope cuenta (SKIP LOCKED evita dobles).
* `iam.tf:1`: rol mínimo `WriteOwnLogs + PullOwnImage + events:PutEvents` solo al bus.
* `ecr.tf, logs.tf, outputs.tf, backend.tf`: repo relay, grupo CloudWatch, outputs, backend remoto.
* Sin `aws_db_instance`. Política RDS pendiente: sin password en tfvars/estado, cifrado on, público off, backups on, deletion protection según entorno.

---

## 10. Tests y verificación

* `package.json:4`: `dev, relay, relay:lambda, typecheck (tsc --noEmit), lint/format (biome), test (vitest unit), test:watch, test:coverage, test:integration (bun --bun vitest), db:generate/migrate/studio, docker compose up -d`.
* Unit 22: `register.schema/service, login.schema/service, passwordreset.schema/service, account.schema/service, me.route, jwt-signer, refresh/reset-token, cookies, mask-email, validation, rate-limiter, require-auth, request-logger, outbox-relay, eventbridge-publisher, relay-handler`.
* Integración 4: `register, login, passwordreset, account` contra Postgres real + `helpers.ts`.
* No ejecutados en este análisis. Definición de terminado exige: compila, tests verdes, biome sin errores nuevos, OpenAPI/eventos actualizados, sin PII en logs/eventos, diff revisado.

---

## 11. Guía Frontend (resumen operativo)

1. Base `http://127.0.0.1:PORT`, `Content-Type: application/json`, variables `baseUrl/accessToken/refreshToken`. Servidor `bun run dev` + `docker compose up -d` + `bun run db:migrate`.
2. Usar solo `code` para i18n, `details[].{field,message}` para pintar por campo (solo `VALIDATION_ERROR`).
3. Nunca `localStorage` para refresh (usar cookie `kenko_refresh`), nunca token en URL (reset `token` en BODY desde fragmento `#token=` del enlace), no decodificar JWT (usar `GET /auth/me`), no cachear sensibles (`no-store` ya lo pone backend), no loguear PII/secretos, respetar anti-enumeración (`409/401/200` genéricos).
4. `429` → countdown con `Retry-After/RateLimit-Reset`, sin reintento agresivo.
5. Flujos: register 4 pasos + Ley 1581 obligatoria → login documento+password → `me` saludo `Hola,{firstName}` → `refresh` silencioso → `logout` idempotente → `forgot` mismo mensaje + cooldown 60s → `reset` con `PASSWORD_RESET_INVALID → pedir nuevo` → `change password` (confirm solo frontend, checklist 8/no-común/sin nombre) → `change email` (`changed:false ya usas ese / true cambió`, `409` genérico).
6. Accesibilidad WCAG 2.2 AA, móvil primero, táctil ≥24px, `aria-describedby`, no solo color, lenguaje simple. Ver `frontend-auth-ux.md:190` (recomendación A paso a paso + centro seguridad B, C accesibilidad como mejora).
7. Orden pruebas: register → login (guardar tokens, verificar `Set-Cookie`) → me → refresh (nuevo ok, viejo `401` reuse) → login fresco → change password → change email (`true` luego `false`) → logout (`401` después) → forgot (outbox `resetUrl`) → reset.

---

## 12. Guía otros microservicios (qué construir)

**Profile:**

* Crear colas propias `kenko-dev-profile-authentication + dlq` y regla `kenko-dev-auth-to-profile` filtrando `Source=kenko.auth AND DetailType IN (UserRegistered, EmailChanged)`.
* `UserRegistered`: upsert por `userId` (idempotente por `eventId` guardado), proyectar `document/person/contact/address`. `emailVerified=false` inicial.
* `EmailChanged`: `UPDATE email WHERE userId` si `eventId` no visto.
* Parsear `detail` (minúsculas en entrega) → `metadata.correlationId` para traza, `data.*` para proyección. Tolerar reintentos y desorden.

**Notifications:**

* Crear `kenko-dev-notifications-authentication + dlq` y regla `kenko-dev-auth-to-notifications` filtrando 3 tipos.
* `UserRegistered → welcome a data.contact.email` (no revelar `userId` en asunto).
* `PasswordResetRequested → correo con data.resetUrl` (enlace fragmento, expira `expiresAt`, no loguear URL/token/email completo).
* `EmailChanged → aviso a oldEmail` (y opcional confirmación a newEmail fuera de este contrato).
* Alarmas DLQ + reintentos con backoff propios, idempotencia por `eventId`.

**Contratos futuros:** `MfaEnabled` sin payload acordado — no implementar hasta contrato. Cambios de contrato compatibles hacia atrás o bump `eventVersion`.

---

## 13. Riesgos, supuestos y pendientes

* AGENTS inicial pedía solo `Register`, el código ya trae `login/refresh/logout/forgot/reset/change/me/EmailChanged` (README v0.5.0). Este doc describe lo implementado.
* Supuestos no verificados en constantes: `access 15min, refresh 7d, reset 30min, PORTAL_BASE_URL local, emailVerified:false`.
* Sin RDS en AWS, sin Scheduler/VPC, HS256 simétrico pendiente ES256+JWKS, ventana 15min de JWT tras revocación aceptada.
* Revisar `terraform.tfvars` no versionado con secretos, rotar si se expuso password real.
* Pendiente: ejecutar `typecheck/lint/test/integration`, validar `openapi.yaml` contra rutas, crear reglas/colas en EventBridge, acuerdo `MfaEnabled`, revisión jurídica Ley 1581/historia clínica.
