# Guía: conectar el frontend al auth desplegado en AWS

El microservicio `kenko-auth` ya no solo vive en tu máquina: está desplegado en AWS y respondiendo en:

- **Producción (AWS): `http://52.203.252.87:3000`**
- **Local (como antes): `http://localhost:5500`**

Los caminos (`/auth/register`, `/auth/login`, etc.) son **idénticos** en ambos. Lo único que cambia es la base. Todo es `http`, no `https` (solo demo).

## 1. Lo primero: encuentra dónde se llama al auth local

En la raíz de tu frontend, busca cada mención a la URL vieja. Los culpables típicos son `fetch`, `axios`, `baseURL`, archivos `.env` y constantes:

```sh
grep -rn "localhost:5500" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" | head -50
grep -rn "baseURL\|BASE_URL\|API_URL\|apiUrl" src/ | head -30
ls -la .env* 2>/dev/null; cat .env.development 2>/dev/null; cat .env.production 2>/dev/null
```

Anota cada archivo que salga: esos son los que vas a tocar. Revisa también la feature `auth` completa y cualquier vista que importe cosas de ahí (`login`, `register`, `perfil`, `recuperar contraseña`, `cambio de email`).

## 2. Centraliza la URL en una variable de entorno

No dejes la URL quemada en el código. Usa una sola variable según tu framework:

- Vite: `VITE_API_URL`
- Create React App: `REACT_APP_API_URL`
- Next.js: `NEXT_PUBLIC_API_URL`
- Angular: `src/environments/environment.ts` y `environment.prod.ts`

Y define sus valores:

- Desarrollo (local): `VITE_API_URL=http://localhost:5500`
- Producción (AWS): `VITE_API_URL=http://52.203.252.87:3000`

Ejemplo con fetch centralizado:

```ts
const API_URL = import.meta.env.VITE_API_URL; // una sola vez en tu cliente http
fetch(`${API_URL}/auth/login`, { ... });
```

Con esto, cambiar de ambiente es cambiar una variable, no 20 archivos.

## 3. El contrato que debes respetar (vale para local y AWS)

- Todas las respuestas exitosas vienen como `{ "data": ... }`.
- Todos los errores vienen como `{ "error": { "code": "...", "message": "...", "correlationId": "..." } }`. Pinta mensajes con el `code` (es estable), no con el `message`.
- Endpoints disponibles (todos empiezan en `/auth`, todos reciben y devuelven JSON):
  - `GET /health` — prueba de vida, sin autenticación.
  - `POST /auth/register` — crea usuario. Responde `201 { data: { userId, maskedEmail } }`. El email viene enmascarado (`m***@dominio`): no esperes el email completo.
  - `POST /auth/login` — entra con tipo/número de documento + contraseña. Responde `{ data: { accessToken, refreshToken, expiresIn: 900 } }`.
  - `POST /auth/refresh` — renueva con el refresh en el body (prioridad) o en la cookie. Responde tokens nuevos.
  - `POST /auth/logout` — cierra todo, con el refresh en el body o en la cookie.
  - `POST /auth/password/forgot` — pide el link con el documento. Siempre responde `200 { data: {} }` exista o no el usuario: no muestres mensajes distintos.
  - `POST /auth/password/reset` — cambia la contraseña con `{ token, password, confirmPassword }`. El token va en el body, nunca en la URL.
  - `GET /auth/me` — identidad mínima `{ data: { userId, firstName, email } }`. Lleva `Authorization: Bearer <accessToken>`. **No decodifiques el JWT en la UI para esto**: usa este endpoint.
  - `POST /auth/password/change` — con token Bearer. Pide `currentPassword` + `newPassword` (sin confirmación en el backend).
  - `POST /auth/email/change` — con token Bearer. Pide `newEmail` + `currentPassword`. Responde `{ data: { changed } }`: si es `false`, era el mismo correo y no pasó nada.
- Límites: cuerpo máximo 64 KiB (`413` si te pasas). Si ves `429`, respeta `Retry-After` y muestra cuenta regresiva con `RateLimit-Reset`.
- Guarda el `correlationId` de cada error: con eso se busca el fallo en los logs del servidor.

## 4. Cómo manejar los tokens en el navegador (importante)

Usa el flujo por JSON, no el de cookies:

- Guarda el `accessToken` **en memoria** (no en `localStorage`).
- Manda `Authorization: Bearer <accessToken>` en cada petición privada.
- El `refreshToken` también viene en el JSON: guárdalo igual (o mejor, pide uno nuevo con `/auth/refresh` cada vez que el access caduque a los 15 min; el viejo se invalida solo por rotación).
- Si tu cliente http manda `credentials: "include"`, no pasa nada, pero no dependas de la cookie `kenko_refresh`: solo viaja bien en `https` y mismo sitio; entre tu front y la IP de AWS no siempre llega. El flujo por body funciona en todos los casos.
- Nunca guardes la contraseña ni el documento más de lo necesario, y nunca pongas tokens en la URL.

## 5. CORS: avísame tu URL final

Hoy el servidor solo acepta orígenes `localhost` (puertos de desarrollo). En cuanto tu front tenga URL de producción (ej. `https://app.tudominio.com`), pásamela y la agrego a la lista permitida en el servidor. Sin ese paso, el navegador bloqueará las llamadas aunque la API responda bien.

## 6. Aviso sobre recuperar contraseña (léeme)

El link de reset que llega por correo se arma con la URL del portal configurada en el servidor, que hoy es `http://localhost:3000` (`<esa-url>/reset#token=...`). Tu página `/reset` debe leer el token del **fragmento** (`#token=`, después del `#`, nunca se envía al servidor) y llamar a `POST /auth/password/reset`.

Cuando tengas la URL real del front, dímela y actualizo esa configuración en el servidor (está en SSM, se cambia sin recrear nada, lo hago yo).

## 7. Checklist de pruebas contra AWS

Cambia tu variable a `http://52.203.252.87:3000` y recorre esto en orden (usa documentos/emails distintos por prueba, son únicos):

- `GET /health` responde `{"data":{"status":"ok"}}`.
- Registro `201` con `maskedEmail` enmascarado.
- Registro duplicado (mismo email o documento) responde `409` genérico, sin decir cuál existe.
- Login `200` con los 3 campos; login con clave mala responde `401` genérico.
- `GET /auth/me` con el Bearer devuelve tu `firstName`.
- `refresh` con el refresh del login devuelve tokens nuevos; usar el viejo otra vez da `401` (rotación).
- `logout` responde `200` y limpia.
- `forgot` responde `200` siempre, exista o no el documento.
- `changePassword` y `email/change` con Bearer funcionan; `changed:false` si mandas el mismo email.
- Revisa que ningún error muestre emails, documentos ni tokens en pantalla (solo mensajes genéricos).

## 8. Volver atrás (rollback)

Si algo falla, vuelve tu variable a `http://localhost:5500` y levanta el back local (`bun run dev` + Postgres local). No hay que tocar nada en AWS: tu variable decide a dónde habla el front.

## 9. Lo que necesito de ti para cerrar

- La URL final del front en producción (para CORS y para el link de reset).
- Confirmarme que el flujo de tokens va por JSON + header `Authorization` (recomendado arriba).
- Si tu front de producción usa `https`, avísame antes: el navegador bloqueará llamadas a nuestra API `http` y habrá que ponerle HTTPS al servidor (te digo cómo).
