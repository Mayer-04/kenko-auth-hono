# Recuperación de contraseña — Kenko Auth

Resumen simple de la feature `password-reset`: qué hay, cómo se usa, cómo fluye el evento y qué falta por definir.

## Endpoints

| Endpoint                     | Qué hace                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /auth/password/forgot` | Pide el enlace. Se identifica por **documento**. Responde **siempre igual** (exista o no la cuenta). |
| `POST /auth/password/reset`  | Cambia la contraseña con el token del enlace (token en el **body**, nunca en la URL).                |

### Cómo ejecutarlos

```sh
# 1) Levantar la base y migrar (solo la primera vez o si cambia el esquema)
docker compose up -d
bun run db:migrate

# 2) Arrancar el API (usa el PORT de tu .env)
bun run dev

# 3) En otra terminal, el relay que publica los eventos (requiere credenciales AWS)
bun run relay
```

```sh
# Solicitud (siempre responde 200, con o sin cuenta)
curl -i -X POST http://localhost:3000/auth/password/forgot \
  -H 'Content-Type: application/json' \
  -d '{"documentType":"CC","documentNumber":"1020304050"}'

# Restablecimiento (el token viene en el body; lo da el correo que envía Notifications)
curl -i -X POST http://localhost:3000/auth/password/reset \
  -H 'Content-Type: application/json' \
  -d '{"token":"<token-del-correo>","password":"nueva-clave-2026","confirmPassword":"nueva-clave-2026"}'
```

Respuestas posibles:
- `forgot`: `200 {data:{}}` siempre · `400` documento inválido · `429` rate limit (`Retry-After`).
- `reset`: `200` ok · `400 PASSWORD_RESET_INVALID` (token inválido, expirado o ya usado: **un solo error**, no distingue) · `400 VALIDATION_ERROR` (contraseña inválida o igual a la actual) · `429` rate limit.

Contrato completo en `docs/openapi.yaml`.

## Flujo completo

```
Usuario                API kenko-auth           Base de datos         Relay (bun run relay)      EventBridge            Notifications
  │  POST /forgot           │                        │                        │                       │                       │
  │────────────────────────>│  1 transacción:        │                        │                       │                       │
  │                         │  • invalida tokens     │                        │                       │                       │
  │                         │    anteriores          │                        │                       │                       │
  │                         │  • guarda token (hash) │                        │                       │                       │
  │                         │  • crea outbox(pending)│                        │                       │                       │
  │  200 siempre            │<───────────────────────│                        │                       │                       │
  │<────────────────────────│                        │  lee pending cada 5s   │                       │                       │
  │                         │                        │───────────────────────>│                       │                       │
  │                         │                        │                        │  PutEvents            │                       │
  │                         │                        │                        │──────────────────────>│                       │
  │                         │                        │  marca sent + redacta   │                       │  enruta (¿regla?)     │
  │                         │                        │<───────────────────────│                       │──────────────────────>│
  │                         │                        │                        │                       │   cola                │  correo de
  │                         │                        │                        │                       │  notifications-       │  recuperación
  │                         │                        │                        │                       │  authentication       │
```

Puntos clave del flujo:
- El usuario y el evento se guardan **en la misma transacción** (outbox transaccional): no puede quedar un token sin evento ni un evento sin token.
- El token en la base de datos vive **solo como hash SHA-256**; en claro solo existe dentro del fragmento de `data.resetUrl` (y hasta que Notifications mande el correo).
- El relay es genérico: publica **cualquier** evento de la outbox usando el `eventType` de la fila como `DetailType`.
- Al publicar (`sent`) o morir (`dead`), la outbox **redacta el payload** (`{"redacted":true}`): la fila deja de retener la URL y el token.

## El evento que se envía

Envelope de `PutEvents` hacia el bus **`kenko-dev-bus`**:

```json
{
	"Source": "kenko.auth",
	"DetailType": "PasswordResetRequested",
	"EventBusName": "kenko-dev-bus",
	"Detail": "{\"metadata\":{\"eventId\":\"…uuidv7…\",\"eventVersion\":\"1\",\"occurredAt\":\"2026-10-18T21:45:30Z\",\"correlationId\":\"…uuidv7…\"},\"data\":{\"userId\":\"…uuidv7…\",\"email\":\"maria.gomez@example.com\",\"firstName\":\"Maria Fernanda\",\"resetUrl\":\"http://localhost:8080/reset#token=9fQ…43 chars base64url…\",\"expiresAt\":\"2026-10-18T22:15:30Z\"}}"
}
```

- Auth construye `data.resetUrl` con `PORTAL_BASE_URL` (`http://localhost:8080` en local): `<base>/reset#token=<token>`. `data` ya **no trae `resetToken` suelto**: el token solo viaja dentro del fragmento. Todo el payload se trata como **secreto**.
- El enlace usa el **fragmento** (`…/reset#token=…`), para que no viaje en logs de proxies ni en el `Referer`. Notifications usa `resetUrl` tal cual en su plantilla de correo.
- El token dura **30 minutos** y sirve **una sola vez**.

## ¿A qué cola llega y qué reglas existen? (estado real, solo lectura)

- Cola de destino: **`kenko-dev-notifications-authentication`** (con su DLQ `…-dlq`), que ya existe y está bien configurada (SSE activo, EventBridge con permiso de envío).
- Regla existente: **`kenko-dev-auth-to-notifications`** con patrón `{"detail-type":["UserRegistered","PasswordResetRequested"], "source":["kenko.auth"]}` (verificado por CLI en `us-east-1`): `PasswordResetRequested` **sí llega** a la cola de Notifications.

Ojo: según el AWS real de Oct-2026, la regla de Profile (`kenko-dev-auth-to-profile`) y su cola **no existen** (el handover anterior las mencionaba). Solo existen las de Notifications.

## Consideraciones de seguridad (ya implementadas)

- **Anti-enumeración**: `forgot` responde idéntico exista o no la cuenta (status, cuerpo y cabeceras). `reset` usa un único error genérico. Nunca se revela ni se enmascara el correo. Diferencia de tiempo medida: ~6.8 ms en local, aceptada y documentada.
- **Token**: opaco, CSPRNG de 256 bits, base64url (no es JWT). Expiración 30 min configurable en `passwordreset.limits.ts`.
- **Rate limiting**: por IP y por documento (con enfriamiento de 60 s) en `forgot`; por IP en `reset`. En memoria (una instancia); para producción se recomienda sumar WAF/API Gateway por IP.
- **Cabeceras**: `Cache-Control: no-store` en ambos endpoints; `secureHeaders()` ya añade `Referrer-Policy: no-referrer`.
- **Logs**: solo IDs (`userId`, `eventId`, `correlationId`). Jamás token, URL, email, documento ni contraseña (hay pruebas que lo verifican).
- **Body**: límite global de 64 KiB ya existente.

## Cómo verificarlo

```sh
bun run typecheck          # tipos
bun run lint               # Biome
bun run test               # 45 unitarias (sin base ni AWS)
bun run test:integration   # 14 de integración (requiere Postgres local)
```

## ¿Qué falta por definir?

1. **Regla de EventBridge para `PasswordResetRequested`** — verificado por CLI: la regla `kenko-dev-auth-to-notifications` ya incluye `["UserRegistered","PasswordResetRequested"]` y el target a la cola existe.
2. **Plantilla del correo** — Auth ya envía `data.resetUrl` construida con `PORTAL_BASE_URL` (`http://localhost:8080` en local). Notifications la usa tal cual en su plantilla; acordar si mantienen ese formato.
3. **Alarma del outbox `dead`** — falta infraestructura (metric filter/alarma de CloudWatch sobre `outbox.payload_dead`). Hoy solo queda el log de error.
4. **Retención de datos** — la DLQ de Notifications retiene mensajes hasta 14 días (ahí viaja la URL con el token hasta que expire a los 30 min). Definir política de retención y revisión jurídica (Ley 1581): el evento contiene email y nombre.
5. **Revocación de sesiones** — hoy no hay sesiones ni refresh tokens (login/MFA no existen). Cuando existan, deberán revocarse **en la misma transacción** del consumo del token (punto de extensión documentado en `passwordreset.port.ts`).
6. **Rate limiting en producción** — el actual es por instancia; definir si se complementa con WAF/API Gateway y/o un almacén compartido (Redis).
7. **Dónde se define la IP del cliente** — se usa `X-Forwarded-For`; definir el proxy de confianza en producción.

## Próximos pasos sugeridos (para terminar la feature sí o sí)

"Terminada" significa: el usuario pide el enlace, recibe el correo y restablece su contraseña de punta a punta en el entorno de desarrollo. En orden de prioridad:

### Paso 1 — Cometer el trabajo (yo puedo hacerlo ahora)

- [ ] Commit en incrementos en la rama `password-reset`: (a) esquema + migración, (b) relay agnóstico + redacción de outbox, (c) feature `passwordreset` (forgot/reset), (d) rate limiting + hardening, (e) tests, (f) docs.
- [ ] Verificar de nuevo `typecheck`, `lint`, `test`, `test:integration` después de commitear.
- _Bloqueante para el usuario final: no. Bloqueante para todo lo demás: sí (nada está guardado en git)._

### Paso 2 — Coordinación con Notifications (equipo de Notifications, es lo crítico)

Sin esto el evento se publica en el bus y **nadie lo consume**: el usuario nunca recibiría el correo. Acordar y ejecutar:
- [ ] **Regla de EventBridge**: añadir `"PasswordResetRequested"` al patrón de `kenko-dev-auth-to-notifications` (misma cola, ya genérica por "authentication") **o** crear una regla nueva para ese `detail-type`. Ellos crean/modifican el recurso; Authentication no toca recursos de otros equipos.
- [ ] \*\* plantilla del correo**: Auth ya envía `data.resetUrl` (`<PORTAL_BASE_URL>/reset#token=<token>`, ej. `http://localhost:8080/reset#token=<token>`). Notifications la usa tal cual en la plantilla, sin reconstruirla.
- [ ] **Tratamiento del payload**: tratarlo como secreto (contiene URL con token + email + nombre), borrar el mensaje tras procesarlo (si no, a los 3 recibos cae a la DLQ y retiene la URL 14 días), idempotencia por `eventId` y tolerancia a duplicados.
- [ ] Definir quién configura la **retención** de la DLQ (hoy 14 días) y si se baja.

### Paso 3 — Prueba end-to-end en dev (juntos, después del paso 2)

- [ ] `bun run relay` con credenciales AWS + un usuario de prueba real.
- [ ] Verificar con `aws events list-events` / métricas que el evento salió con `DetailType: PasswordResetRequested` y formato correcto.
- [ ] Verificar en la cola de Notifications que el mensaje llega y el correo sale con el enlace `#token=`.
- [ ] Clic en el enlace → `reset` con el token → 200 → login futuro con la contraseña nueva (hoy solo se verifica el cambio de hash en DB).
- _Nota: enviar un evento de prueba a la cola de Notifications es un efecto externo — coordinar con ese equipo antes._

### Paso 4 — Alarma de outbox `dead` (ops/infra, corto)

- [ ] Metric filter de CloudWatch sobre el log `outbox.payload_dead` (y `outbox.publish_failed`) + alarma. Un token que no se publica debe verse, no quedar silencioso.
- [ ] (Recomendado) limpieza periódica de filas `sent` viejas del outbox (hoy no hay job de purga; la redacción ya dejó el payload vacío, pero la tabla crece).

### Paso 5 — Revisión jurídica y retención (cumplimiento, puede ir en paralelo)

- [ ] Revisar con cumplimiento/legales: datos de contacto en el evento (Ley 1581), retención del payload en outbox (redactado en `sent`/`dead`) y de mensajes en la DLQ.
- [ ] Registrar la decisión de retención en el README/handover.

### Paso 6 — Punto de extensión futuro (NO bloquea cerrar esta feature)

- [ ] Cuando exista **login** (sesiones/refresh tokens): revocar todas las sesiones del usuario dentro de `consumeTokenAndUpdatePassword`, en la misma transacción (ya documentado en `passwordreset.port.ts`). MFA: definir interacción al restablecer con MFA activo.

**Ruta crítica real:** Paso 1 (commit) → Paso 2 (Notifications) → Paso 3 (e2e). El paso 2 es el único que depende de otro equipo: mientras no haya regla para `PasswordResetRequested`, la feature está "implementada pero no entregada".
