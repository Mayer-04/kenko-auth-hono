# Authentication para Appointments

## Qué hace Auth

Valida identidad y emite tokens. Appointments **no llama a Auth**, solo valida el `accessToken` que el frontend le envía.

## Flujo

1. Frontend: `POST /auth/login {documentType, documentNumber, password}` → `200 {accessToken, refreshToken, expiresIn: 900}`
2. Frontend llama a Appointments con: `Authorization: Bearer <accessToken>`
3. Appointments valida el JWT y usa `sub` como `userId` (dueño de la cita).
4. Si el access expira (15 min), el frontend pide uno nuevo a `POST /auth/refresh {refreshToken}`. Appointments no hace esto.

## Los 2 tokens

- **Access (JWT HS256, 15 min):** es el único que Appointments debe aceptar. Claims: `sub=userId`, `iss=kenko-auth`, `aud=kenko-api`, `exp`, `jti`, `sid=familia de sesión`.
- **Refresh (opaco, 7 días):** solo se usa contra Auth (`/refresh`, `/logout`). Nunca enviarlo a Appointments.

## Validación en Appointments

Verificar con el `JWT_SECRET` compartido:

- firma + `alg == HS256` (rechazar `none`/otros)
- `iss == kenko-auth`, `aud == kenko-api`, `exp` vigente

Fallo o header ausente → `401` genérico, sin detallar motivo.

> Limitación actual: al ser HS256 con secreto compartido, quien tenga el secreto podría emitir tokens. Se migrará a ES256/JWKS sin cambiar el servicio.

## Revocación

- `POST /auth/logout {refreshToken}` → revoca **todas** las sesiones activas del usuario (todos los dispositivos). Idempotente, siempre `200`.
- Reusar un refresh ya rotado → Auth revoca **toda la familia** (detección de robo) → siguientes requests dan `401`.
- Cambiar o resetear contraseña también revoca sesiones.

## Reglas clave

- Login/refresh/logout **no publican eventos**. No hay nada que consumir.
- Errores de credenciales/sesión son siempre el mismo `401 UNAUTHORIZED` (anti-enumeración).
- Tokens solo en BODY/Header, nunca en URL.

## AccessToken (JWT HS256) — lo que Appointments debe esperar

Formato estándar: `header.payload.signature` (3 partes base64url).

**1. Header**

```json
{ "alg": "HS256", "typ": "JWT", "kid": "hs256-01" }
```

Solo aceptar `HS256`. Rechazar `none` u otro.

**2. Payload (claims obligatorios)**

```json
{
	"sub": "0192b3d1-... (userId)",
	"iss": "kenko-auth",
	"aud": "kenko-api",
	"exp": 1730000000,
	"iat": 1729999100,
	"jti": "0192b3d1-... (id único del token)",
	"sid": "0192b3d1-... (familia de sesión refresh)"
}
```

| Claim       | Qué es             | Uso en Appointments                                 |
| ----------- | ------------------ | --------------------------------------------------- |
| `sub`       | userId (UUIDv7)    | Dueño de la cita. Es lo único que necesitan leer    |
| `iss`       | emisor             | Debe ser `kenko-auth`                               |
| `aud`       | audiencia          | Debe ser `kenko-api`                                |
| `exp`/`iat` | expiración/emisión | Rechazar si `exp` pasó (vida 15 min)                |
| `jti`       | id único del token | Trazabilidad                                        |
| `sid`       | familia refresh    | Pueden ignorarlo, solo sirve a Auth para revocación |

**3. Signature:** HMAC-SHA256 con `JWT_SECRET` compartido.

## RefreshToken (no es JWT)

String opaco aleatorio (32 bytes base64url). Appointments debe **ignorarlo/rechazarlo** — solo sirve para `POST /auth/refresh` y `POST /auth/logout` en Auth.

## Checklist mínimo en Appointments

1. Header `Authorization: Bearer <token>` presente.
2. Verificar firma con el secreto + `alg`, `iss`, `aud`, `exp`.
3. Usar `sub` como `userId`.
