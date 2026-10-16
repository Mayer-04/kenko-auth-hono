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
| `bun run relay`            | Worker outbox → EventBridge (proceso separado) |
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
`register` es la primera; `login`, `mfa`, `passwordreset` y `user` siguen el
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
│   │   ├── schema/               tablas Drizzle (users, outbox)
│   │   ├── repositories/         implementaciones de los puertos
│   │   └── migrations/           generadas por drizzle-kit
│   ├── password/
│   │   └── argon2-hasher.ts      implementa PasswordHasher
│   └── events/
│       ├── eventbridge-client.ts cliente y configuración del bus
│       ├── eventbridge-publisher.ts escribe el evento en la outbox
│       └── outbox-relay.ts       publica los pendientes y los marca
│
└── features/
    └── register/
        ├── register.types.ts     dominio de la feature
        ├── register.schema.ts    esquema Zod de entrada
        ├── register.port.ts      UserRepository, PasswordHasher, EventPublisher
        ├── register.service.ts   caso de uso
        ├── register.route.ts     POST /auth/register
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
