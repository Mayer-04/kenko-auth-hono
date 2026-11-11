# kenko-auth-hono

## 1. ¿Qué hace el proyecto?

Es el microservicio **Authentication** del portal de salud **Kenko** (EPS en Colombia). Se encarga de la gestión de identidad y credenciales de los usuarios:

- Registro de usuarios nuevos.
- Inicio de sesión (emisión de JWT de acceso + Refresh Token opaco), rotación de sesión (con detección de reúso) y cierre de sesión.
- Recuperación de contraseña olvidada mediante enlace con token de un solo uso.
- Gestión autenticada de la cuenta: cambio de contraseña y cambio de correo electrónico.
- Publicación asíncrona y confiable de eventos de dominio hacia **Amazon EventBridge** (`kenko-dev-bus`) implementando el patrón **Transactional Outbox + Relay** sobre **PostgreSQL**.

Está construido con **Bun + TypeScript + Hono**, **PostgreSQL + Drizzle ORM**, **Zod v4**, **Argon2id**, **jose (JWT HS256)**, **Winston** y **Terraform** (para infraestructura en AWS). Sigue una arquitectura **Vertical Slice con Puertos y Adaptadores**, donde `src/features/` contiene la lógica de dominio y casos de uso sin depender directamente de `src/infra/`.

---

## 2. Comandos utilizados para ejecutarlo y verificarlo

Definidos en `package.json`:

| Comando | Descripción |
| :--- | :--- |
| `bun install` | Instala las dependencias del proyecto. |
| `bun run dev` | Inicia el servidor HTTP en modo desarrollo con recarga en caliente (`bun run --hot src/index.ts`). |
| `bun run relay` | Inicia el worker en bucle continuo (`src/relay.ts`) que lee la tabla `outbox` y publica en EventBridge. |
| `bun run relay:lambda` | Inicia el servidor HTTP mínimo (`src/relay-handler.ts`) diseñado para correr en AWS Lambda con `aws-lambda-adapter` (invocado por EventBridge Scheduler). |
| `bun run db:generate` | Genera archivos de migración SQL a partir del esquema Drizzle (`drizzle-kit generate`). |
| `bun run db:migrate` | Aplica las migraciones pendientes en la base de datos (`src/infra/db/migrate.ts`). |
| `bun run db:studio` | Abre Drizzle Studio (interfaz visual para explorar la base de datos). |
| `bun run typecheck` | Verifica los tipos de TypeScript sin emitir archivos (`tsc --noEmit`). |
| `bun run lint` | Ejecuta el linter y verificador de formato con Biome (`biome check .`). |
| `bun run format` | Aplica formato y correcciones automáticas con Biome (`biome check --write .`). |
| `bun run test` | Ejecuta las pruebas unitarias y de rutas con Vitest (`vitest run tests/unit`). |
| `bun run test:watch` | Ejecuta Vitest en modo interactivo/watch. |
| `bun run test:coverage` | Ejecuta las pruebas unitarias generando reporte de cobertura. |
| `bun run test:integration` | Ejecuta las pruebas de integración contra PostgreSQL real (`bun --bun vitest run tests/integration`). |
| `docker compose up -d` | Levanta el contenedor local de PostgreSQL 18 definido en `compose.yml`. |

---

## 3. Funcionalidades y explicación corta de cada una

1. **Registro de usuario (`register`)**: Valida y normaliza los datos personales, de contacto y documento del paciente, hashea la contraseña con Argon2id y guarda en una única transacción al usuario (`users`) junto con el evento `UserRegistered` en la `outbox`.
2. **Inicio de sesión (`login`)**: Autentica al usuario por tipo/número de documento y contraseña. Si es válido, firma un Access Token JWT (HS256, 15 min) con claim `sid` (ID de familia de sesión) y genera un Refresh Token opaco (7 días, guardado como hash SHA-256 en `refresh_sessions`).
3. **Renovación de sesión (`refresh`)**: Recibe un Refresh Token opaco, verifica que esté activo y vigente, y lo rota atómicamente (marca el anterior como `rotated` y crea uno nuevo `active` en la misma familia). Si detecta que se intenta usar un token ya rotado (*reuse detection*), revoca toda la familia de sesiones por seguridad.
4. **Cierre de sesión (`logout`)**: Recibe el Refresh Token y revoca todas las sesiones activas del usuario en todos sus dispositivos. Es idempotente (siempre responde `200`).
5. **Solicitud de recuperación de contraseña (`forgot`)**: Recibe el documento del usuario. Si existe, invalida tokens de reset previos, genera un token opaco aleatorio (TTL 30 min, guardado como SHA-256 en `password_reset_tokens`) y encola el evento `PasswordResetRequested` en la `outbox` con el `resetUrl` (`<PORTAL_BASE_URL>/reset#token=<token>`). Siempre responde `200` (anti-enumeración).
6. **Restablecimiento de contraseña (`reset`)**: Consume de forma atómica el token de recuperación, verifica que la nueva contraseña no sea igual a la actual, actualiza el hash Argon2id, invalida otros tokens pendientes y revoca las sesiones activas del usuario.
7. **Cambio autenticado de contraseña (`changePassword`)**: Para usuarios con sesión iniciada (JWT Bearer). Verifica la contraseña actual, valida que la nueva no sea igual a la actual ni contenga el nombre, apellido o email del usuario, actualiza el hash, invalida resets pendientes y revoca las sesiones de otras familias (conservando activa la familia `sid` actual).
8. **Cambio autenticado de correo (`changeEmail`)**: Para usuarios con sesión iniciada (JWT Bearer). Verifica la contraseña actual, comprueba que el nuevo email no esté ocupado por otro usuario y actualiza el email en `users` encolando atómicamente el evento `EmailChanged` en la `outbox`. Si el correo enviado es igual al actual, responde `200` de forma idempotente sin escribir en BD.
9. **Publicación de eventos (`outbox-relay`)**: Reclama eventos en estado `pending` de la tabla `outbox`, los publica en Amazon EventBridge y los marca como `sent` (o los reprograma con backoff exponencial si falla; si el payload es inválido/irreparable lo marca como `dead`). Al pasar a un estado terminal (`sent` o `dead`), redacta el payload (`{"redacted":true}`) para no retener datos personales ni tokens en la tabla.

*(Nota: Existe la carpeta `src/features/mfa/`, actualmente vacía con `.gitkeep`, reservada para una futura etapa de MFA con TOTP).*

---

## 4. Endpoints de la API

Todos los endpoints aplican un límite global de tamaño de body de **64 KiB** (`413 PAYLOAD_TOO_LARGE` si se excede), propagan la cabecera `X-Correlation-Id` (si llega un UUID válido lo reutiliza; si no, genera un UUID v7) y devuelven respuestas JSON con el sobre `{ "data": ... }` en éxito o `{ "error": { "code", "message", "correlationId" } }` en error.

| Método | Ruta | Autenticación | Descripción corta | Éxito |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/health` | Pública | Healthcheck del servicio HTTP (y readiness del adapter en Lambda). | `200 OK` `{ data: { status: "ok" } }` |
| `POST` | `/auth/register` | Pública | Registro de un nuevo usuario. | `201 Created` `{ data: { userId } }` |
| `POST` | `/auth/login` | Pública | Inicio de sesión con documento y contraseña. | `200 OK` `{ data: { accessToken, refreshToken, expiresIn: 900 } }` |
| `POST` | `/auth/refresh` | Pública (Token en body) | Rotación de par de tokens (`accessToken` + `refreshToken`). | `200 OK` `{ data: { accessToken, refreshToken, expiresIn: 900 } }` |
| `POST` | `/auth/logout` | Pública (Token en body) | Cierre de todas las sesiones activas del usuario. | `200 OK` `{ data: {} }` |
| `POST` | `/auth/password/forgot` | Pública | Solicita enlace de restablecimiento de contraseña por documento. | `200 OK` `{ data: {} }` |
| `POST` | `/auth/password/reset` | Pública (Token en body) | Restablece la contraseña usando el token del enlace. | `200 OK` `{ data: {} }` |
| `POST` | `/auth/password/change` | `Bearer <JWT>` | Cambia la contraseña del usuario autenticado. | `204 No Content` *(sin cuerpo)* |
| `POST` | `/auth/email/change` | `Bearer <JWT>` | Cambia el correo electrónico del usuario autenticado. | `200 OK` `{ data: {} }` |

---

## 5. Eventos que publica

El servicio actúa como **productor** hacia el bus de Amazon EventBridge (`kenko-dev-bus` por defecto) con `Source: "kenko.auth"`. Todos los eventos usan el patrón Outbox y comparten el sobre `{ metadata: { eventId, eventVersion: "1", occurredAt, correlationId }, data: { ... } }`:

1. **`UserRegistered`**
   - **Cuándo se emite**: Al completarse con éxito `POST /auth/register`.
   - **Consumidores esperados**: `Profile` (crea el perfil base) y `Notifications` (envía correo de bienvenida).
   - **Datos (`data`)**: `userId`, `document: { type, number }`, `person: { firstName, lastName, birthDate, gender }`, `contact: { email, emailVerified: false, phone }`, `address: { line, city }`.
2. **`PasswordResetRequested`**
   - **Cuándo se emite**: En `POST /auth/password/forgot` cuando el documento corresponde a un usuario existente.
   - **Consumidores esperados**: `Notifications` (envía correo con enlace de recuperación).
   - **Datos (`data`)**: `userId`, `email`, `firstName`, `resetUrl` (`<PORTAL_BASE_URL>/reset#token=<token>`), `expiresAt`.
3. **`EmailChanged`**
   - **Cuándo se emite**: En `POST /auth/email/change` cuando el correo nuevo es distinto al actual y se actualiza con éxito.
   - **Consumidores esperados**: `Profile` (actualiza su proyección de correo por `userId`) y `Notifications` (notifica al correo anterior).
   - **Datos (`data`)**: `userId`, `oldEmail`, `newEmail`, `firstName`.

---

## 6. Bases de datos y tablas

### Selección de base de datos

- Motor: **PostgreSQL** (en local se levanta PostgreSQL 18 mediante `compose.yml`, base por defecto `app`).
- Resolución de conexión (`src/config/env.ts`): Si `AWS_RDS_POSTGRES_URL` está definida, se conecta a **AWS RDS**; si está vacía o ausente, usa `POSTGRES_URL` (**local**). No hace fallback silencioso de RDS a local para evitar escribir en la base equivocada si RDS falla.

### Tablas creadas (Esquema Drizzle y migraciones `0000`, `0001`, `0002`)

1. **`users`** (`src/infra/db/schema/user.table.ts`)
   - **Columnas**: `id` (UUID v7 PK), `document_type` (text), `document_number` (text), `first_name` (text), `last_name` (text), `birth_date` (date), `gender` (text), `email` (text), `email_verified` (boolean, default `false`), `phone` (text), `address_line` (text), `city` (text), `password_hash` (text), `created_at` (timestamptz), `updated_at` (timestamptz).
   - **Índices únicos**: `users_email_unique` sobre `(email)` y `users_document_unique` sobre `(document_type, document_number)`.

2. **`outbox`** (`src/infra/db/schema/outbox.table.ts`)
   - **Columnas**: `id` (UUID v7 PK), `event_id` (UUID v7), `aggregate_type` (text, default `'user'`), `aggregate_id` (UUID), `event_type` (text), `event_version` (text), `correlation_id` (text), `payload` (jsonb), `status` (text: `'pending' | 'sent' | 'dead'`), `attempts` (integer, default `0`), `next_attempt_at` (timestamptz), `created_at` (timestamptz), `published_at` (timestamptz nullable).
   - **Índices**: único `outbox_event_id_unique` sobre `(event_id)` e índice compuesto `outbox_pending_idx` sobre `(status, next_attempt_at)`.

3. **`refresh_sessions`** (`src/infra/db/schema/refresh-session.table.ts`)
   - **Columnas**: `id` (UUID v7 PK), `user_id` (UUID FK → `users.id` `ON DELETE CASCADE`), `family_id` (UUID v7), `token_hash` (text, SHA-256), `status` (text: `'active' | 'rotated' | 'revoked'`), `expires_at` (timestamptz), `rotated_at` (timestamptz nullable), `revoked_at` (timestamptz nullable), `created_at` (timestamptz), `correlation_id` (text).
   - **Índices**: único `refresh_sessions_token_hash_unique` sobre `(token_hash)`, `refresh_sessions_family_idx` sobre `(family_id)`, `refresh_sessions_user_idx` sobre `(user_id)`.

4. **`password_reset_tokens`** (`src/infra/db/schema/password-reset.table.ts`)
   - **Columnas**: `id` (UUID v7 PK), `user_id` (UUID FK → `users.id` `ON DELETE CASCADE`), `token_hash` (text, SHA-256), `expires_at` (timestamptz), `used_at` (timestamptz nullable), `invalidated_at` (timestamptz nullable), `created_at` (timestamptz), `correlation_id` (text).
   - **Índices**: único `password_reset_tokens_hash_unique` sobre `(token_hash)` e índice `password_reset_tokens_user_idx` sobre `(user_id)`.

---

## 7. Validaciones, Rate Limiting, estados HTTP y códigos de error por funcionalidad

### Reglas transversales de validación y errores

- **Política de contraseña (`PasswordFieldSchema`)**: Mínimo 8 caracteres, máximo 128 caracteres, sin normalización (los espacios cuentan) y rechaza contraseñas comunes de una lista negra (`password`, `password123`, `12345678`, `123456789`, `qwerty123`, `colombia123`, `kenko1234`).
- **Normalización de documento**: `documentType` hace `trim().toUpperCase()` y valida contra `["CC", "TI", "CE", "PA"]`. `documentNumber` hace `trim()`, elimina espacios, puntos y guiones, pasa a mayúsculas y exige regex `^[A-Z0-9]{4,20}$`.
- **Normalización de email**: `trim().toLowerCase()`, formato de email válido (`z.email()`) y máximo 254 caracteres.
- **Normalización de teléfono**: Elimina espacios, guiones, puntos y paréntesis; convierte prefijo `00` en `+`; si tiene 10 dígitos empezando en `3` asume Colombia (`+57`); valida regex E.164 `^\+[1-9]\d{7,14}$` (8 a 15 dígitos en total).
- **Errores transversales**:
  - Cuerpo > 64 KiB → `413 PAYLOAD_TOO_LARGE` (`VALIDATION_ERROR`: `"Cuerpo demasiado grande."`).
  - Ruta inexistente → `404 NOT_FOUND` (`NOT_FOUND`: `"Recurso no encontrado."`).
  - Fallo no controlado → `500 INTERNAL_ERROR` (`INTERNAL_ERROR`: `"Error interno. Intente de nuevo mas tarde."`).

---

### Detalle por endpoint

#### 1. `POST /auth/register`

- **Validaciones de entrada (Zod)**:
  - `firstName` y `lastName`: `trim()`, entre 1 y 100 caracteres, al menos una letra Unicode (`/\p{L}/u`).
  - `birthDate`: fecha ISO (`YYYY-MM-DD`), no puede ser futura (`<= hoy UTC`) ni mayor a 120 años atrás.
  - `gender`: enum `["male", "female", "other"]`.
  - `email`: normalizado, máx. 254 caracteres.
  - `phone`: normalizado a E.164.
  - `addressLine`: `trim()`, 1 a 200 caracteres.
  - `city`: `trim()`, 1 a 100 caracteres.
  - `documentType` y `documentNumber`: normalizados según reglas transversales.
  - `password`: aplica `PasswordFieldSchema`.
  - `confirmPassword`: debe coincidir exactamente con `password` (`"Las contrasenas no coinciden."`).
- **Validaciones de negocio**:
  - Unicidad de `email` y del par `(documentType, documentNumber)` tanto en aplicación como por índice `UNIQUE` en BD (código PG `23505`).
- **Respuestas HTTP**:
  - `201 Created`: `{ data: { userId } }`.
  - `400 Bad Request` (`VALIDATION_ERROR`): Si falla cualquier regla de Zod.
  - `409 Conflict` (`REGISTER_CONFLICT`: `"No se pudo completar el registro."`): Respuesta única genérica si el email o el documento ya existen (anti-enumeración).

#### 2. `POST /auth/login`

- **Validaciones de entrada (Zod)**:
  - `documentType` y `documentNumber`: normalizados y validados igual que en registro.
  - `password`: string no vacío (mín. 1, máx. 128 caracteres).
- **Rate Limiting**:
  - Por IP: máx. **10** peticiones cada 15 min.
  - Por documento (`tipo:numero`): máx. **5** peticiones cada 15 min.
- **Validaciones de negocio**:
  - Existencia del usuario por documento y verificación del hash Argon2id.
- **Respuestas HTTP** (con cabecera `Cache-Control: no-store`):
  - `200 OK`: `{ data: { accessToken, refreshToken, expiresIn: 900 } }`.
  - `400 Bad Request` (`VALIDATION_ERROR`): Error de formato en la entrada.
  - `401 Unauthorized` (`UNAUTHORIZED`: `"Credenciales invalidas."`): Único error genérico tanto si el usuario no existe como si la contraseña no coincide.
  - `429 Too Many Requests` (`RATE_LIMITED` + header `Retry-After`): Si supera el límite por IP o por documento.

#### 3. `POST /auth/refresh`

- **Validaciones de entrada (Zod)**:
  - `refreshToken`: string no vacío (`min(1)`).
- **Rate Limiting**:
  - Por IP: máx. **20** peticiones cada 15 min.
- **Validaciones de negocio**:
  - Busca sesión por hash SHA-256 y compara con `timingSafeEqual`.
  - Si la sesión está en estado `rotated` (token ya usado previamente o en carrera concurrente), **revoca toda la familia (`family_id`)** por detección de reúso y rechaza con `401`.
  - Si no existe, está `revoked` o `expiresAt <= now()`, rechaza con `401`.
- **Respuestas HTTP** (con `Cache-Control: no-store`):
  - `200 OK`: `{ data: { accessToken, refreshToken, expiresIn: 900 } }`.
  - `400 Bad Request` (`VALIDATION_ERROR`): Si falta `refreshToken`.
  - `401 Unauthorized` (`UNAUTHORIZED`: `"Credenciales invalidas."`): Token desconocido, expirado, revocado o reusado.
  - `429 Too Many Requests` (`RATE_LIMITED` + `Retry-After`).

#### 4. `POST /auth/logout`

- **Validaciones de entrada (Zod)**:
  - `refreshToken`: string no vacío (`min(1)`).
- **Rate Limiting**:
  - Por IP: máx. **20** peticiones cada 15 min.
- **Respuestas HTTP** (con `Cache-Control: no-store`):
  - `200 OK`: `{ data: {} }` (siempre `200` aunque el token no exista o ya esté revocado).
  - `400 Bad Request` (`VALIDATION_ERROR`): Si el body no incluye un `refreshToken` válido en forma.
  - `429 Too Many Requests` (`RATE_LIMITED` + `Retry-After`).

#### 5. `POST /auth/password/forgot`

- **Validaciones de entrada (Zod)**:
  - `documentType` y `documentNumber`: normalizados y validados.
- **Rate Limiting**:
  - Por IP: máx. **10** peticiones cada 15 min.
  - Por documento: máx. **3** peticiones cada 15 min.
  - Cooldown por documento: máx. **1** petición cada **60 segundos**.
- **Respuestas HTTP** (con `Cache-Control: no-store`):
  - `200 OK`: `{ data: {} }` (respuesta idéntica exista o no el usuario).
  - `400 Bad Request` (`VALIDATION_ERROR`): Documento con formato inválido.
  - `429 Too Many Requests` (`RATE_LIMITED` + `Retry-After`).

#### 6. `POST /auth/password/reset`

- **Validaciones de entrada (Zod)**:
  - `token`: string no vacío (`min(1)`).
  - `password`: aplica `PasswordFieldSchema`.
  - `confirmPassword`: debe coincidir con `password`.
- **Rate Limiting**:
  - Por IP: máx. **10** peticiones cada 15 min.
- **Validaciones de negocio**:
  - El hash SHA-256 del token debe existir y estar activo (`used_at IS NULL`, `invalidated_at IS NULL`, `expires_at > now()`).
  - La nueva contraseña no puede ser igual a la contraseña actual del usuario.
- **Respuestas HTTP** (con `Cache-Control: no-store`):
  - `200 OK`: `{ data: {} }`.
  - `400 Bad Request` (`VALIDATION_ERROR`): Error de forma Zod, o si la nueva contraseña es igual a la actual (`"La contrasena no puede ser igual a la actual."`).
  - `400 Bad Request` (`PASSWORD_RESET_INVALID`: `"El enlace de restablecimiento no es valido o ha expirado."`): Token inexistente, expirado, invalidado o ya utilizado.
  - `429 Too Many Requests` (`RATE_LIMITED` + `Retry-After`).

#### 7. `POST /auth/password/change`

- **Autenticación (`requireAuth`)**:
  - Exige header `Authorization: Bearer <accessToken>`. Verifica firma HS256, `iss`, `aud` y `exp`.
- **Validaciones de entrada (Zod)**:
  - `currentPassword`: string no vacío (`min(1)`).
  - `newPassword`: aplica `PasswordFieldSchema` (no pide `confirmPassword` en backend).
- **Rate Limiting / Bloqueo temporal**:
  - Por IP: máx. **20** peticiones cada 15 min.
  - Por usuario (`userId` del JWT): máx. **5** intentos totales cada **10 minutos**.
- **Validaciones de negocio**:
  - `currentPassword` debe coincidir con el hash actual del usuario.
  - `newPassword` no puede ser igual a `currentPassword`.
  - `newPassword` no puede contener (insensible a mayúsculas/minúsculas) el `email`, `firstName` o `lastName` del usuario.
- **Respuestas HTTP** (con `Cache-Control: no-store`):
  - `204 No Content`: Sin cuerpo.
  - `400 Bad Request` (`VALIDATION_ERROR`): Falla de esquema Zod, contraseña igual a la actual (`"La contrasena no puede ser igual a la actual."`), o contiene datos del usuario (`"La nueva contrasena no puede contener tu correo o tu nombre."`).
  - `401 Unauthorized` (`UNAUTHORIZED`): `"Credenciales invalidas."` si el JWT falta o es inválido/expirado; o `"Contrasena actual incorrecta."` si el JWT es válido pero `currentPassword` no coincide.
  - `429 Too Many Requests` (`RATE_LIMITED` + `Retry-After`).

#### 8. `POST /auth/email/change`

- **Autenticación (`requireAuth`)**:
  - Exige header `Authorization: Bearer <accessToken>`.
- **Validaciones de entrada (Zod)**:
  - `newEmail`: normalizado (`trim` + minúsculas), email válido, máx. 254 caracteres.
  - `currentPassword`: string no vacío (`min(1)`).
- **Rate Limiting / Bloqueo temporal**:
  - Por IP: máx. **20** peticiones cada 15 min.
  - Por usuario (`userId` del JWT): máx. **5** intentos totales cada **10 minutos**.
- **Validaciones de negocio**:
  - `currentPassword` debe coincidir con el hash actual del usuario.
  - Si `newEmail === account.email`, termina con éxito sin escribir en BD ni emitir evento (idempotente).
  - Si `newEmail` ya está registrado por otro usuario (en chequeo previo o por restricción `UNIQUE` `23505`), rechaza con conflicto genérico.
- **Respuestas HTTP** (con `Cache-Control: no-store`):
  - `200 OK`: `{ data: {} }`.
  - `400 Bad Request` (`VALIDATION_ERROR`): Formato de email inválido o falta `currentPassword`.
  - `401 Unauthorized` (`UNAUTHORIZED`): `"Credenciales invalidas."` (fallo de JWT) o `"Contrasena actual incorrecta."` (fallo de `currentPassword`).
  - `409 Conflict` (`UPDATE_CONFLICT`: `"No se pudo completar el cambio."`): El nuevo correo ya está en uso.
  - `429 Too Many Requests` (`RATE_LIMITED` + `Retry-After`).
