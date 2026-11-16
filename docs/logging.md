# Logging del microservicio Authentication

Guía operativa: qué se registra, con qué nivel y cómo buscarlo.
Regla madre (producción 2026): **JSON estructurado, 1 línea por evento,
solo IDs** (`correlationId`, `userId`, `eventId`, `familyId`, `jwtId`...).
Nunca `password`, tokens, `resetUrl`, emails, documentos, teléfonos ni bodies.

## Formato por entorno

| Entorno | Formato | Nivel mínimo |
|---|---|---|
| `development` (`bun run dev`) | Legible con color: `info`=verde, `warn`=amarillo, `error`=rojo. Misma info que en prod. | `debug` |
| `production` | JSON (`service`, `timestamp`, `level`, `message`=evento, campos) para CloudWatch/agregador. | `info` |
| `test` | JSON, `warn` mínimo (evita ruido en `vitest`). | `warn` |

El color solo cambia la presentación local (`src/config/logger.ts`); en prod
siempre JSON sin color.

## Niveles: cuándo usar cada uno

- `info` — éxito de negocio o ciclo de vida: request `2xx`, `register.succeeded`,
  `login.succeeded/refreshed/logged_out`, `password_reset.requested/completed`,
  `password/email.changed`, `outbox.published`, arranques.
- `warn` — fallo esperado o reintentable (no requiere acción inmediata):
  request `4xx` (incluye `400` de validación y `429`), `login.failed`,
  `refresh_failed`, `register.failed`, `me.failed`, `rate_limited.*`,
  `outbox.publish_failed` (se reintenta con backoff), `payload_normalized`.
- `error` — requiere revisión: request `5xx`, `outbox.payload_dead`,
  `relay_tick_failed`, `database.unreachable`, `configuration.invalid`.

## Tabla de eventos (categoria -> `message`)

| Evento | Nivel | Dónde | Campos |
|---|---|---|---|
| `http.request` | `info` 2xx / `warn` 4xx / `error` 5xx | middleware acceso | `method, route, status, latencyMs, correlationId, userId?` |
| `register.succeeded` | `info` | `register.service` | `userId, eventId, correlationId` |
| `register.failed` | `warn` | `register.service` | `correlationId` (genérico, anti-enumeración) |
| `login.succeeded` | `info` | `login.service` | `userId, sessionId, familyId, jwtId, correlationId` |
| `login.failed` | `warn` | `login.service` | `correlationId` |
| `login.refreshed` | `info` | `login.service` | `userId, familyId, jwtId, correlationId` |
| `login.refresh_failed` | `warn` | `login.service` | `correlationId` |
| `login.reuse_detected` | `warn` | `login.service` | `userId, familyId, correlationId` |
| `login.logged_out` | `info` | `login.service` | `userId, correlationId` (solo si el token existía) |
| `login.rate_limited` | `warn` | `login.route` | `scope, limit, correlationId` |
| `password_reset.requested` | `info` | `passwordreset.service` | `userId, eventId, correlationId` |
| `password_reset.request_unknown` | `warn` | `passwordreset.service` | `correlationId` (genérico, anti-enumeración) |
| `password_reset.completed` | `info` | `passwordreset.service` | `userId, correlationId` |
| `password_reset.rate_limited` | `warn` | `passwordreset.route` | `scope, limit, correlationId` |
| `password.changed` / `email.changed` | `info` | `account.service` | `userId, correlationId` |
| `password.change_failed` / `email.change_failed` | `warn` | `account.service` | `correlationId` |
| `account.rate_limited` | `warn` | `account.route` | `scope, limit, correlationId` |
| `me.failed` | `warn` | `account.route (GET /auth/me)` | `userId, correlationId` |
| `outbox.published` | `info` | `outbox-relay` | `eventId, eventType, correlationId` |
| `outbox.publish_failed` | `warn` | `outbox-relay` | `eventId, eventType, correlationId, attempts, error` |
| `outbox.payload_normalized` | `warn` | `outbox-relay` | `eventId, correlationId` |
| `outbox.payload_dead` | `error` | `outbox-relay` | `eventId, eventType, correlationId, error` |
| `outbox.relay_tick_failed` | `error` | `outbox-relay` | `error` |
| `server.starting`, `relay.starting/stopping` | `info` | `index/relay(-handler)` | `port` / — |
| `database.target/unreachable` | `info` / `error` | `container/index` | `target` / `error` |

Lo que **no** se loguea nunca: `GET /health` y éxitos de `GET /auth/me`
(ruido), ni `email/documento/teléfono/dirección/password/token/resetUrl`.

## Cómo buscar un fallo

1. El frontend muestra `error.correlationId` (y header `X-Correlation-Id`)
   como "código de referencia".
2. En prod filtra por ese id:
   `fields.correlationId = "<uuid>"` (o `correlationId` según el agregador).
3. Sigue la cadena: `http.request` (status/ruta/latencia) ->
   evento de negocio (`register.failed`, `login.reuse_detected`,
   `outbox.publish_failed`...) -> `outbox.published` del relay.

Ejemplo local (dev, con color):

```text
2026-11-11T10:00:00.000Z [kenko-auth] info: register.succeeded {"userId":"...","eventId":"...","correlationId":"..."}
2026-11-11T10:00:01.000Z [kenko-auth] warn: http.request {"method":"POST","route":"/auth/login","status":"401","latencyMs":"12","correlationId":"..."}
2026-11-11T10:00:02.000Z [kenko-auth] info: outbox.published {"eventId":"...","eventType":"UserRegistered","correlationId":"..."}
```

Ejemplo prod (CloudWatch Logs Insights):

```sql
fields @timestamp, message, status, route, correlationId
| filter correlationId = "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10"
| sort @timestamp asc
```

## Añadir un evento nuevo

1. Añade la constante en `src/shared/log-events.ts`.
2. Registra **una sola línea** en el borde (servicio o ruta), nivel según la tabla.
3. Solo IDs en el segundo argumento; verifica con `JSON.stringify` que no haya PII.
4. Documenta la fila en la tabla de arriba.
