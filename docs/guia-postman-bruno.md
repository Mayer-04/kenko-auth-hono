# Guía de pruebas: Authentication en Postman / Bruno

Guía para probar el microservicio `kenko-auth` con un cliente HTTP
(Postman o Bruno), de principio a fin.

## 0. Base y variables

Crea un entorno con una variable `baseUrl = http://127.0.0.1:TU_PUERTO`
(el `PORT` de tu `.env`). Todas las peticiones llevan la cabecera
`Content-Type: application/json`. Guarda además dos variables que irás
llenando: `accessToken` y `refreshToken`.

El servidor debe estar corriendo (`bun run dev`) con PostgreSQL arriba
(`docker compose up -d`) y las migraciones aplicadas (`bun run db:migrate`).

## 1. Endpoints públicos (sin autenticación)

| #   | Método y URL                            | Body                                                                                                                                                                                                                                | Respuesta esperada                                                                                           |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | `POST {{baseUrl}}/auth/register`        | Usuario completo: `firstName`, `lastName`, `birthDate: "1995-03-21"`, `gender: "female"`, `email`, `phone: "+573001234567"`, `addressLine`, `city`, `documentType: "CC"`, `documentNumber`, `password` + `confirmPassword` (mín. 8) | `201` con `{"data":{"userId":"..."}}`                                                                        |
| 2   | `POST {{baseUrl}}/auth/login`           | `{"documentType":"CC","documentNumber":"<el mismo>","password":"<la misma>"}`                                                                                                                                                       | `200` con `{"data":{"accessToken","refreshToken","expiresIn":900}}` → **copia ambos tokens a tus variables** |
| 3   | `POST {{baseUrl}}/auth/refresh`         | `{"refreshToken":"{{refreshToken}}"}`                                                                                                                                                                                               | `200` con un par nuevo (el viejo muere). Si reusas el viejo → `401`                                          |
| 4   | `POST {{baseUrl}}/auth/logout`          | `{"refreshToken":"{{refreshToken}}"}`                                                                                                                                                                                               | Siempre `200 {"data":{}}`                                                                                    |
| 5   | `POST {{baseUrl}}/auth/password/forgot` | `{"documentType":"CC","documentNumber":"<el mismo>"}`                                                                                                                                                                               | Siempre `200 {"data":{}}` (exista o no la cuenta)                                                            |
| 6   | `POST {{baseUrl}}/auth/password/reset`  | `{"token":"<el-del-enlace>","password":"<nueva>","confirmPassword":"<nueva>"}`                                                                                                                                                      | `200` si el token vale; `400` si venció o se usó                                                             |

El token del paso 6 sale del enlace que el evento lleva a Notifications;
en local lo sacas de la tabla `outbox` (columna `payload` → `data.resetUrl`,
lo que sigue a `#token=`). En Bruno puedes automatizar el paso 2 con un
script post-respuesta que guarde los tokens en variables.

## 2. Endpoints autenticados (sí necesitas estar autenticado)

| #   | Método y URL                            | Cabecera extra                          | Body                                                            | Respuesta esperada |
| --- | --------------------------------------- | --------------------------------------- | --------------------------------------------------------------- | ------------------ |
| 7   | `POST {{baseUrl}}/auth/password/change` | `Authorization: Bearer {{accessToken}}` | `{"currentPassword":"<actual>","newPassword":"<nueva mín. 8>"}` | `204` sin cuerpo   |
| 8   | `POST {{baseUrl}}/auth/email/change`    | `Authorization: Bearer {{accessToken}}` | `{"newEmail":"<nuevo>","currentPassword":"<actual>"}`           | `200 {"data":{}}`  |

Sin cabecera, con token manipulado o vencido → `401`. Clave actual mala →
`401 "Contrasena actual incorrecta."`. Tras 5 intentos fallidos en
10 minutos → `429` con `Retry-After`.

## 3. Orden sugerido para probar el flujo completo

1. **Register** → `201` (guarda el `userId` si quieres).
2. **Login** → `200`, guarda `accessToken` y `refreshToken`.
3. **Refresh** con el token → `200` par nuevo; reintenta con el viejo →
   `401` (reuse detection: el nuevo también cae a `401`, la familia se
   revocó).
4. Vuelve a **Login** para tener sesión fresca → **Change password** con
   el Bearer → `204`; el login con la clave vieja da `401`, con la nueva
   `200`.
5. **Change email** con un Bearer vigente → `200`; verifica que el refresh
   viejo sigue funcionando (las sesiones no se tocan).
6. **Logout** → `200`; el refresh posterior da `401`.
7. **Forgot** → `200`; saca el token de la outbox; **Reset** → `200`;
   comprueba que la clave vieja ya no entra.
