# kenko-auth

Microservicio de **Authentication** de la plataforma de salud Kenko: registro de
usuarios, autenticación y emisión de tokens.

**Stack:** Bun + TypeScript + Hono · PostgreSQL + Drizzle ORM · Zod · Argon2id ·
Amazon EventBridge · Terraform

## Puesta en marcha

```sh
bun install
bun run dev
```

El servidor escucha en el puerto definido por `PORT` en el entorno.

## Scripts

| Comando                    | Qué hace                                       |
| -------------------------- | ---------------------------------------------- |
| `bun run dev`              | Servidor con recarga en caliente               |
| `bun run relay`            | Worker outbox → EventBridge + purga diaria de sesiones |
| `bun run typecheck`        | `tsc --noEmit`                                 |
| `bun run lint`             | Biome `check` (linter + formato, sin escribir) |
| `bun run format`           | Biome `check --write` (aplica formato y fixes) |
| `bun run test`             | Pruebas unitarias y de ruta                    |
| `bun run test:integration` | Pruebas que requieren PostgreSQL               |
| `bun run test:coverage`    | Pruebas con cobertura                          |
| `bun run db:generate`      | Genera la migración desde el esquema Drizzle   |
| `bun run db:migrate`       | Aplica las migraciones pendientes              |
| `bun run db:studio`        | Inspector visual de la base de datos           |

## Arquitectura

Vertical slice con puertos y adaptadores. Cada feature es una carpeta autónoma:
`register` y `login` están implementadas; `mfa`, `passwordreset` y `user` siguen el
mismo recorte.

### Flujo y dirección de las dependencias

```
                      petición HTTP
                           │
                           ▼
   ┌───────────────────────────────────────────────────────┐
   │  features/<feature>/                                  │
   │                                                       │
   │    *.route.ts      valida la entrada, responde        │
   │         │                                             │
   │    *.service.ts    reglas de negocio                  │
   │         │                                             │
   │    *.port.ts       interfaces que la feature necesita │
   └─────────┼─────────────────────────────────────────────┘
             │        container.ts inyecta las implementaciones
             ▼
   ┌───────────────────────────────────────────────────────┐
   │  infra/             adaptadores                       │
   │    db/              PostgreSQL, esquema, repositorios │
   │    password/        Argon2id                          │
   │    events/          outbox + EventBridge              │
   └───────────────────────────────────────────────────────┘

   config/    env validado (fail fast) y logger
   shared/    errores, respuestas HTTP y UUID v7 — sin IO
```

**Regla central:** `features/` nunca importa de `infra/`. La feature declara lo
que necesita en `*.port.ts` y `container.ts` le entrega la implementación. Por
eso `register.service.ts` se prueba sin base de datos ni AWS.

### Estructura

```
src/
├── index.ts                      carga el env, arma el container, sirve
├── app.ts                        instancia de Hono y middlewares
├── container.ts                  inyección de dependencias
│
├── config/                       transversal, sin reglas de negocio
│   ├── env.ts                    Zod sobre process.env; log estructurado y exit 1
│   └── logger.ts                 Winston, único punto de configuración
│
├── shared/                       puro: sin IO, sin dependencias de infra
│   ├── errors.ts                 AppError y códigos de error
│   ├── http.ts                   errorHandler y respuestas consistentes
│   └── ids.ts                    UUID v7
│
├── infra/                        tecnología, no reglas de negocio
│   ├── db/
│   │   ├── client.ts             drizzle sobre el SQL nativo de Bun
│   │   ├── schema/               tablas Drizzle (users, outbox, auth_sessions)
│   │   ├── repositories/         implementaciones de los puertos
│   │   └── migrations/           generadas por drizzle-kit
│   ├── password/
│   │   └── argon2-hasher.ts      implementa PasswordHasher
│   ├── auth/
│   │   ├── token-issuer.ts       access tokens JWT HS256 (hono/jwt)
│   │   └── refresh-token.ts      refresh opacos (solo hash en DB)
│   └── events/
│       ├── eventbridge-client.ts cliente y configuración del bus
│       ├── eventbridge-publisher.ts escribe el evento en la outbox
│       └── outbox-relay.ts       publica los pendientes y los marca
│
└── features/
    ├── register/
    │   ├── register.types.ts     dominio de la feature
    │   ├── register.schema.ts    esquema Zod de entrada
    │   ├── register.port.ts      UserRepository, PasswordHasher, EventPublisher
    │   ├── register.service.ts   caso de uso
    │   ├── register.route.ts     POST /auth/register
    │   └── index.ts              punto de entrada de la feature
    └── login/
        ├── login.types.ts        dominio e identidad de claims
        ├── login.schema.ts       esquema Zod de entrada
        ├── login.port.ts         CredentialsStore, SessionStore, firmas
        ├── login.service.ts      POST /auth/login
        ├── refresh.service.ts    POST /auth/refresh (rotacion)
        ├── logout.service.ts     POST /auth/logout (una sesion)
        ├── login.route.ts        rutas y cookies (hono/cookie)
        ├── login.rate-limit.ts   limite simple de intentos por IP
        └── index.ts              punto de entrada de la feature

tests/integration/                pruebas que requieren PostgreSQL
terraform/                        RDS PostgreSQL
```

### Decisiones de diseño

| Decisión                | Motivo                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox transaccional    | El usuario y el evento `UserRegistered` se confirman en la misma transacción y el relay publica después. Evita un usuario guardado sin evento. |
| `timestamptz` / `date`  | `timestamptz` para instantes; `date` para la fecha de nacimiento, que es fecha de calendario.                                                  |
| UUID v7                 | Ordenable por tiempo y con menos colisiones en el índice.                                                                                      |
| Sin fallback de RDS     | Si la base configurada no responde se falla y se reporta. Escribir en la base equivocada es peor que no arrancar.                              |
| Credenciales AWS aparte | No viven en el entorno: el SDK las resuelve por la cadena estándar (AWS CLI o rol de IAM).                                                     |

## Login y sesiones (feature `login`)

Implementado: `POST /auth/login`, `POST /auth/refresh` y `POST /auth/logout`.
El access token es un **JWT HS256 de 15 minutos** que los demás microservicios
verifican localmente; el refresh es un **token opaco de 7 días** que viaja solo
en una cookie `HttpOnly`, con rotación y detección de reutilización. Logout
cierra **una sola** sesión (dispositivo/navegador). Fuera de alcance: MFA,
recuperación de contraseña y logout global.

### Qué necesitas para probarlo

| Requisito               | Cómo se cumple                                                       |
| ----------------------- | -------------------------------------------------------------------- |
| Bun instalado           | `bun --version` (probado con Bun 1.4.3)                              |
| PostgreSQL local        | `docker compose up -d`                                               |
| Migraciones aplicadas   | `bun run db:migrate`                                                 |
| `.env` con `JWT_SECRET` | En dev basta `kenko-auth`; en producción ≥32 caracteres aleatorios   |
| Un usuario registrado   | Primero `POST /auth/register` (no hay login sin registro previo)     |
| `curl` (y `jq` opcional) | Los ejemplos usan `python3` (ya instalado aquí) para leer JSON |

Variables de entorno de esta feature (validadas al arrancar en `config/env.ts`):

| Variable       | Obligatoria | Default      | Uso                                             |
| -------------- | ----------- | ------------ | ----------------------------------------------- |
| `JWT_SECRET`   | Sí          | —            | Firma HS256. En `production` se exige ≥32 chars |
| `JWT_ISSUER`   | No          | `kenko.auth` | Claim `iss`                                     |
| `JWT_AUDIENCE` | No          | `kenko-api`  | Claim `aud`                                     |

### Los tres endpoints

| Método y ruta        | Qué hace                                                    | Entrada                                            | Salida                                           |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `POST /auth/login`   | Autentica con documento + contraseña y abre una sesión      | JSON: `documentType`, `documentNumber`, `password` | 200 con access token + `Set-Cookie` del refresh  |
| `POST /auth/refresh` | Rota el refresh y emite un par nuevo sin pedir credenciales | Solo la cookie `kenko_refresh`                     | 200 con access token nuevo + cookie rotada       |
| `POST /auth/logout`  | Revoca la sesión actual y borra la cookie                   | Cookie (opcional)                                  | 204 sin cuerpo                                   |

### Contratos

#### `POST /auth/login`

```json
{
  "documentType": "CC",
  "documentNumber": "1020304050",
  "password": "correcta-segura-99"
}
```

- `documentType`: `CC`, `TI`, `CE` o `PA` (se normaliza a mayúsculas).
- `documentNumber`: se limpian espacios, puntos y guiones, y se pasa a mayúsculas.
- `password`: obligatoria, máximo 128 caracteres. No se normaliza.

Respuesta `200`:

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresIn": 900,
    "user": {
      "userId": "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
      "firstName": "Maria Fernanda",
      "email": "maria.gomez@example.com"
    }
  }
}
```

Cabeceras de la misma respuesta:

```
Set-Cookie: kenko_refresh=<token-opaco>; Max-Age=604800; Path=/auth; HttpOnly; SameSite=Lax
X-Correlation-Id: <uuid-v7>
```

`expiresIn` son segundos (900 = 15 minutos). `Secure` se añade a la cookie
solo cuando `ENVIRONMENT=production`.

Errores posibles:

| Código | Cuándo                                               | Cuerpo                                          |
| ------ | ---------------------------------------------------- | ----------------------------------------------- |
| 400    | JSON inválido o campos mal formados                  | `issues` de Zod (validador, no el sobre normal) |
| 401    | Documento inexistente **o** contraseña incorrecta    | `{"error":{"code":"UNAUTHORIZED",...}}`         |
| 413    | Cuerpo mayor a 64 KiB                                | `{"error":{"code":"VALIDATION_ERROR",...}}`     |
| 429    | 5 fallos de credenciales en 10 min desde la misma IP | `{"error":{"code":"TOO_MANY_REQUESTS",...}}`    |
| 500    | Error interno                                        | `{"error":{"code":"INTERNAL_ERROR",...}}`       |

El 401 es deliberadamente idéntico exista o no la cuenta (anti-enumeración,
Ley 1581). Todos los errores incluyen `correlationId` para soporte.

#### `POST /auth/refresh`

Sin cuerpo. Solo requiere la cookie `kenko_refresh` (el navegador la envía
sola si la petición es al mismo origen). Responde igual que el login:

```json
{
  "data": {
    "accessToken": "eyJ...",
    "expiresIn": 900,
    "user": { "userId": "...", "firstName": "...", "email": "..." }
  }
}
```

y reemplaza la cookie por un refresh **nuevo**. El anterior queda inutilizable.

| Código | Cuándo                                                                  |
| ------ | ----------------------------------------------------------------------- |
| 401    | Cookie ausente, token desconocido, expirado, revocado o **reutilizado** |
| 500    | Error interno                                                           |

Si se detecta reutilización de un refresh ya rotado (posible robo), se revoca
la **familia completa**: esa sesión/dispositivo queda cerrado, pero las demás
sesiones del usuario siguen activas.

#### `POST /auth/logout`

Sin cuerpo. La cookie es opcional y la respuesta es `204` siempre
(idempotente, no revela si la sesión existía). Invalida el refresh actual y
manda `Set-Cookie` con `Max-Age=0` para borrarlo del navegador.

### El access token: qué contiene

Payload de ejemplo (valores ilustrativos, no datos reales):

```json
{
  "sub": "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "userId": "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "firstName": "Maria Fernanda",
  "email": "maria.gomez@example.com",
  "iss": "kenko.auth",
  "aud": "kenko-api",
  "iat": 1760626530,
  "exp": 1760627430,
  "jti": "0192b3d1-..."
}
```

- `sub` y `userId` llevan el mismo valor (compatibilidad con consumidores).
- `exp - iat` = 900 segundos. El token **expira**; los consumidores deben
  exigirlo.
- Firma HS256 con `JWT_SECRET`. **No está cifrado**: cualquiera que tenga el
  token puede leer los claims. Nunca incluir datos clínicos ni credenciales.
- El refresh **no es un JWT**: es una cadena aleatoria de 32 bytes y en la
  base solo se guarda su hash SHA-256.

### Cookies: cómo quedan configuradas

| Atributo   | Valor               | Por qué                                      |
| ---------- | ------------------- | -------------------------------------------- |
| Nombre     | `kenko_refresh`     | —                                            |
| `HttpOnly` | Sí                  | JavaScript no puede leerla (mitiga XSS)      |
| `SameSite` | `Lax`               | Bloquea envíos en peticiones cruzadas (CSRF) |
| `Path`     | `/auth`             | Solo viaja a `/auth/*`, no a toda la API     |
| `Secure`   | Solo en `production`| En dev no hay HTTPS local                    |
| `Max-Age`  | 604800 (7 días)     | Igual que la vida del refresh                |

Supuesto actual: el frontend es **mismo sitio** (`SameSite=Lax` funciona). Si
queda en otro dominio, habría que evaluar `SameSite=None` (obliga `Secure`) y
CORS con credenciales.

### Flujo paso a paso

#### A. En el servidor (qué hace `Authentication` en cada llamada)

**Login:**

1. `login.route.ts` valida el JSON con Zod y revisa el límite de intentos por IP.
2. Busca el usuario por `(documentType, documentNumber)` y verifica la
   contraseña con Argon2id.
3. Si algo falla: suma un intento y responde el 401 genérico. Si tiene éxito:
   limpia el contador de esa IP.
4. Genera un refresh opaco nuevo y guarda en `auth_sessions` solo su hash, con
   estado `active` y vencimiento a 7 días, en una **familia nueva**.
5. Firma el access JWT (15 min, claims de arriba).
6. Envía la cookie `kenko_refresh` y responde el JSON con el access token.

**Refresh:**

1. Lee la cookie y busca la fila por hash del token.
2. Verifica estado: desconocida/revocada → 401; vencida → revoca y 401;
   `rotated` (reutilización) → revoca la **familia** y 401.
3. Si está `active`, en una transacción (`FOR UPDATE`) marca la vieja como
   `rotated` e inserta la nueva `active` en la misma familia.
4. Firma un access nuevo y responde con cookie fresca.

**Logout:**

1. Si hay cookie, revoca la fila correspondiente (`revoked`).
2. Responde 204 y borra la cookie. Nunca revela si existía.

Las filas muertas (`rotated`/`revoked`) se purgan: el worker `bun run relay`
ejecuta una limpieza cada 24 h y borra lo que lleve 30+ días sin uso.

#### B. En el cliente (frontend)

1. El usuario escribe documento y contraseña. **La contraseña nunca se guarda**
   en el cliente; se envía una vez al login.
2. Si el login responde 200: guarda el `accessToken` **en memoria** (no en
   `localStorage`) y los datos de `user`. La cookie del refresh la guarda el
   navegador solo (el JS no la ve).
3. Para llamar a otro microservicio: `Authorization: Bearer <accessToken>`.
4. Cuando una petición devuelva 401 por token vencido (15 min), llama a
   `POST /auth/refresh` **una sola vez**; con el par nuevo reintenta la petición.
   Importante: si varias peticiones fallan a la vez, usa un único refresh
   compartido (single-flight); dos refresh en paralelo harán que uno rote y el
   otro sea rechazado por diseño.
5. Si el refresh también da 401 (sesión vencida o revocada): pide login de nuevo.
6. "Cerrar sesión" = `POST /auth/logout` y descartar el token en memoria.

### Probarlo tú mismo con curl (paso a paso)

0. Prepara el entorno (en terminales separadas si hace falta):

```sh
docker compose up -d        # PostgreSQL local
bun run db:migrate          # crea/actualiza tablas
bun run dev                 # API; usa PORT del .env (ej. 3000)

BASE=http://localhost:3000  # ajusta al PORT de tu .env
```

1. Registra un usuario ficticio (12 campos, todos obligatorios):

```sh
curl -i -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{
    "firstName": "Maria Fernanda",
    "lastName": "Gomez Rojas",
    "birthDate": "1995-03-21",
    "gender": "female",
    "email": "maria.gomez@example.com",
    "phone": "3001234567",
    "addressLine": "Cra 15 # 93-60 Apto 402",
    "city": "Bogota",
    "documentType": "CC",
    "documentNumber": "1020304050",
    "password": "correcta-segura-99",
    "confirmPassword": "correcta-segura-99"
  }'
```

Espera `201` con `{"data":{"userId":"..."}}`. Si repites el mismo documento o
email, responde `409` genérico (normal).

2. Inicia sesión guardando la cookie en un archivo (`-c`):

```sh
curl -i -c cookies.txt -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"documentType":"CC","documentNumber":"1020304050","password":"correcta-segura-99"}'
```

Espera `200` con `accessToken`, `expiresIn: 900` y la cabecera
`Set-Cookie: kenko_refresh=...`. Si quieres el token en una variable:

```sh
curl -s -c cookies.txt -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"documentType":"CC","documentNumber":"1020304050","password":"correcta-segura-99"}' \
  -o login.json
TOKEN=$(python3 -c "import json; print(json.load(open('login.json'))['data']['accessToken'])")
echo "$TOKEN"
```

(Si prefieres `jq`: `... | jq -r '.data.accessToken'`.)

3. Así usarías el token en otro microservicio (este servicio aún no tiene
   rutas protegidas; el token es para los consumidores):

```sh
curl -H "Authorization: Bearer $TOKEN" https://otro-servicio/lo-que-sea
```

Para ver su contenido en dev: pégalo en https://jwt.io (nunca en producción)
o decodifícalo sin red:

```sh
bun -e "const {decode}=await import('hono/jwt'); console.log(decode(process.argv[1]))" "$TOKEN"
```

4. Renueva la sesión (rota el refresh; vuelve a guardar la cookie con `-c`):

```sh
curl -i -b cookies.txt -c cookies.txt -X POST "$BASE/auth/refresh"
```

Espera `200` con un `accessToken` nuevo y una cookie distinta.

5. Demuestra la detección de robo: guarda el valor viejo antes de un refresh,
   úsalo después y verás que se cae **toda esa familia**:

```sh
OLD=$(grep kenko_refresh cookies.txt | awk '{print $NF}')   # antes de rotar
curl -s -b cookies.txt -c cookies.txt -X POST "$BASE/auth/refresh" > /dev/null
curl -i -X POST "$BASE/auth/refresh" -H "Cookie: kenko_refresh=$OLD"   # -> 401
curl -i -b cookies.txt -X POST "$BASE/auth/refresh"                    # -> 401 (familia revocada)
```

6. Cierra sesión y comprueba que ya no hay refresh:

```sh
curl -i -b cookies.txt -c cookies.txt -X POST "$BASE/auth/logout"   # -> 204
curl -i -b cookies.txt -X POST "$BASE/auth/refresh"                 # -> 401
```

7. Comprueba la respuesta anti-enumeración (misma respuesta para contraseña
   mala y documento inexistente):

```sh
curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"documentType":"CC","documentNumber":"1020304050","password":"clave-mala"}' | python3 -m json.tool
curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"documentType":"CC","documentNumber":"9999999999","password":"clave-mala"}' | python3 -m json.tool
```

8. Comprueba el límite de intentos (la 6.ª respuesta es `429`):

```sh
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.7' \
    -d '{"documentType":"CC","documentNumber":"1020304050","password":"mala"}'
done
```

`X-Forwarded-For` en las pruebas sirve para simular IPs distintas. Sin proxy
de confianza, las peticiones directas cuentan como IP `unknown`.

9. Entrada inválida:

```sh
curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"documentType":"XX"}' | head -c 300     # -> 400 con issues de Zod
```

### Pruebas automatizadas

```sh
bun run test              # 43 unitarias (sin DB): servicios, tokens, rate limit
bun run test:integration  # 10 contra PostgreSQL real: flujo completo y purga
bun run typecheck && bun run lint
```

Las de integración crean y borran sus propios usuarios; no tocan AWS.

### Qué necesita un microservicio consumidor

- El **mismo** `JWT_SECRET` byte por byte (UTF-8 tal cual, sin Base64).
- Verificar con el algoritmo **fijado** en HS256: nunca aceptar el `alg` del
  encabezado. Con `hono/jwt`:
  `verify(token, secret, { alg: 'HS256', iss: 'kenko.auth', aud: 'kenko-api' })`.
- Exigir `exp` y validar `iss`/`aud` como arriba.
- Leer la identidad de `userId` (o `sub`), `firstName` y `email`.
- Recibir el token en `Authorization: Bearer <token>`.
