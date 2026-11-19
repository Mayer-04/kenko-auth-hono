# Despliegue en AWS — kenko-auth (guía simple)

Todo corre en `us-east-1`. La API responde en:

- **http://52.203.252.87:3000**

Si alguna vez no responde, saca la IP actual así (es fija, pero verifícala):

```sh
aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=kenko-dev-auth-api" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].PublicIpAddress" --output text
```

## Qué servicios usamos y para qué

- **EC2 (t4g.micro) + IP fija (EIP).** Aquí vive la aplicación. Es una máquina virtual pequeña con Docker. La IP `52.203.252.87` es nuestra y no cambia aunque la máquina se recree.
- **RDS Postgres (db.t4g.micro).** La base de datos. Se llama `kenko-dev-auth-db`. Está en una subred privada: no tiene puerta a internet, solo el EC2 la puede ver. Eso es a propósito, por seguridad.
- **ECR.** El garaje privado donde guardamos las imágenes Docker (`kenko-dev-auth-api:0.1.2` y `kenko-dev-auth-relay:0.1.2`). El EC2 descarga la de la API y la Lambda corre la del relay.
- **EventBridge (bus kenko-dev-bus).** El cartero central. Nuestra app publica eventos y otros microservicios los reciben.
- **SQS.** Los buzones donde esperan los eventos (notificaciones, perfil). Cada buzón tiene su buzón de muertos (DLQ) por si algo falla 3 veces.
- **SSM Parameter Store.** La caja fuerte. Guarda la URL de la base, su contraseña y el secreto JWT. Nunca están en git ni en el código.
- **CloudWatch Logs.** Donde quedan los registros. Grupos `/ec2/kenko-dev-auth-api` (servidor) y `/aws/lambda/kenko-dev-auth-relay` (relay). Se borran a los 14 días.
- **Budgets + SNS.** Una alarma que avisa si el gasto mensual pasa el tope.
- **VPC.** Nuestra red privada: 2 subredes públicas (EC2) y 2 privadas (RDS y Lambda), con puerta a internet solo para lo público. La Lambda sale a AWS por 2 caminos privados internos (Endpoints de EventBridge y de logs), sin exponerse.
- **IAM.** Los permisos mínimos: cada pieza solo puede tocar lo suyo (el EC2 lee secretos e invoca la Lambda del relay; la Lambda solo publica en el bus y escribe sus logs).
- **Lambda + Scheduler (activos).** La Lambda `kenko-dev-auth-relay` corre el relay: la API la invoca tras cada escritura y el Scheduler la invoca cada 1 minuto como red. **ECS quedó apagado** (en 0, no cuesta nada); en el futuro se puede borrar del todo.

## Cómo funciona la app por dentro

- El cliente llama a la API (registro, login, etc.).
- La API guarda en Postgres en una sola transacción: el dato (ej. usuario) más el evento en la tabla `outbox` (estado `pending`).
- El relay es la función Lambda `kenko-dev-auth-relay`: la API la invoca en modo async justo después de guardar (retardo de segundos) y el Scheduler de 1 minuto la invoca como red de seguridad. Lee los pendientes de `outbox`, los publica en EventBridge y los marca `sent`. Si falla, reintenta con espera creciente. Si el evento está roto, lo marca `dead` y borra sus datos.
- Por eso nunca se pierde un evento aunque EventBridge esté caído un rato.

## El patrón outbox + relay (explicado simple)

En local lo hacías a mano: la API guardaba el evento en `outbox` y ahí se quedaba hasta que tú abrías otra terminal y corrías `bun run relay`. En el despliegue ya es automático, nadie tiene que correr nada.

Flujo real con un ejemplo (registrar un usuario):

- El cliente llama a `POST /auth/register` en `http://52.203.252.87:3000`.
- Si todo sale bien, la API guarda 2 cosas a la vez en Postgres: el usuario en la tabla `users` y el evento `UserRegistered` en la tabla `outbox` (estado `pending`). Si algo falla, no se guarda nada (o todo o nada).
- La API avisa a la Lambda del relay en modo async justo después de guardar (sin esperar respuesta). La Lambda reclama los eventos `pending`, los publica en el bus `kenko-dev-bus` de EventBridge y los marca `sent` en `outbox`. El Scheduler de 1 minuto es la red por si algún aviso se pierde.
- EventBridge mira sus reglas y reparte copias a las colas SQS que corresponden. `UserRegistered` llega a la cola de notificaciones (correo de bienvenida) y a la de perfil (crear el perfil base). Los otros microservicios consumen desde ahí.
- O sea: registras un usuario y en segundos su evento ya está en las colas, solo. Si el relay está caído, los eventos esperan en `pending` y salen al volver. Por eso no se pierde ninguno.

## Las dos formas en que se dispara el relay (lo actual)

El relay es siempre la misma Lambda haciendo lo mismo (reclamar `pending` -> publicar -> marcar `sent`). Lo que cambió es quién la despierta, y son dos caminos que se complementan:

- **Camino rápido (el normal):** la API, justo después de guardar el usuario y su evento, invoca a la Lambda sin esperar respuesta. El evento llega a SQS en segundos. Si invocar falla, no pasa nada: la petición ya respondió bien y el otro camino lo recoge.
- **Camino de red (el seguro):** un despertador (Scheduler) invoca a la Lambda cada 1 minuto, publique o no algo. Si algún aviso se perdió o la Lambda estuvo caída, lo pendiente sale aquí. Por eso el outbox nunca se queda con eventos olvidados.

Piensa en el primero como el mensajero que sale corriendo con cada carta, y en el segundo como la ronda que pasa cada minuto por si quedó alguna carta en el buzón.

## Configuración del servidor

- Imagen Docker propia (`Dockerfile` en la raíz): Bun 1.4.4, solo dependencias de producción, usuario sin privilegios, escucha en puerto 3000.
- En el EC2 corre 1 contenedor con la misma imagen:
  - `api`: `bun src/index.ts` (el servidor). Tras cada escritura en `outbox`, avisa a la Lambda del relay en modo async (sin esperar respuesta).
- Si se cae, Docker lo reinicia solo. El relay programado (Scheduler 1/min -> Lambda) recoge lo que el aviso no alcance.

## Variables de entorno (las que usa el contenedor)

- `PORT=3000`
- `ENVIRONMENT=development`
- `EVENT_BUS_NAME=kenko-dev-bus`
- `PORTAL_BASE_URL=http://localhost:3000` (URL del portal; se usa para armar el link de recuperar contraseña `/reset#token=...`). Vive en SSM (`/kenko/dev/portal_base_url`): se cambia sin recrear nada.
- `JWT_ISSUER=kenko.auth`, `JWT_AUDIENCE=kenko-api`
- `CORS_ORIGINS` vacío = solo acepta `localhost`. Si el front queda en otra URL, hay que ponerla aquí y redesplegar.
- `POSTGRES_URL` es un valor falso de relleno: el código prefiere `AWS_RDS_POSTGRES_URL` si existe.
- `AWS_RDS_POSTGRES_URL` y `JWT_SECRET` **no** van escritas: llegan desde SSM al arrancar.
- `AWS_REGION=us-east-1` (para que el SDK sepa a qué región llamar) y `RELAY_FUNCTION_NAME=kenko-dev-auth-relay` (nombre de la Lambda a avisar; si se quita, el aviso se apaga y solo queda el Scheduler).

## Cómo saber si está desplegada y probarla

Cambia `BASE` por la IP de arriba si cambió:

```sh
BASE=http://52.203.252.87:3000
curl $BASE/health
```

```sh
curl http://52.203.252.87:3000/health
```

Debe responder `{"data":{"status":"ok"}}`. Si responde eso, el servidor está vivo.

Endpoints que tiene la API (todos con `Content-Type: application/json`):

- `GET /health` — saber si vive. Sin autenticación.
- `POST /auth/register` — crear usuario. Pide nombres, documento, email, teléfono, dirección, ciudad, contraseña y confirmación. Devuelve `userId` y email enmascarado.
- `POST /auth/login` — entrar con tipo/número de documento y contraseña. Devuelve `accessToken` (dura 15 min), `refreshToken` y fija cookie.
- `POST /auth/refresh` — pedir tokens nuevos con el refresh (va en el body o en la cookie). Rota la sesión.
- `POST /auth/logout` — cierra todas las sesiones del usuario y limpia la cookie.
- `POST /auth/password/forgot` — pide el link de recuperación con tu documento. Siempre responde igual (no revela si existes).
- `POST /auth/password/reset` — cambia la contraseña con el token del link.
- `GET /auth/me` — quién soy (lleva `Authorization: Bearer <accessToken>`).
- `POST /auth/password/change` — cambiar contraseña logueado (pide la actual y la nueva, con token).
- `POST /auth/email/change` — cambiar email logueado (pide contraseña actual y email nuevo, con token).

Ejemplo rápido:

```sh
curl -X POST $BASE/auth/register -H "Content-Type: application/json" -d '{"firstName":"Test","lastName":"Demo","birthDate":"1990-01-01","gender":"other","email":"demo.1@example.com","phone":"+573001234567","addressLine":"Calle 1","city":"Bogota","documentType":"CC","documentNumber":"1000000001","password":"Segura123!x","confirmPassword":"Segura123!x"}'
curl -X POST $BASE/auth/login -H "Content-Type: application/json" -d '{"documentType":"CC","documentNumber":"1000000001","password":"Segura123!x"}'
```

Ojo: el email y el documento son únicos. Cada prueba usa otros valores.

## Conectarse a la base desde un cliente (Beekeeper, DBeaver)

Datos (sin secretos):

- Host: `kenko-dev-auth-db.cezucwi0oldg.us-east-1.rds.amazonaws.com`
- Puerto: `5432`
- Base: `kenko_auth`
- Usuario: `kenko_auth`
- SSL: `REQUIRED` (la base rechaza conexiones sin cifrado)

La contraseña **no** está en ningún archivo: está en SSM. Solo tú la ves en tu terminal con:

```sh
aws ssm get-parameter --name /kenko/dev/db_password --with-decrypt --region us-east-1 --query Parameter.Value --output text
```

Y muy importante: la base es privada, desde tu laptop no llega directo (dará timeout). Primero abre el túnel y déjalo corriendo:

```sh
IID=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=kenko-dev-auth-api" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].InstanceId" --output text)
aws ssm start-session --region us-east-1 --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{"host":["kenko-dev-auth-db.cezucwi0oldg.us-east-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5433"]}'
```

(Requiere el plugin de Session Manager instalado.) Con el túnel abierto, en tu cliente usa `Host=localhost`, `Port=5433`, lo demás igual. Hay un ayudante en `scripts/db-info.sh` que imprime todo esto sin guardar secretos.

## Ver los logs del servidor

```sh
aws logs tail /ec2/kenko-dev-auth-api --since 1h --region us-east-1
aws logs tail /aws/lambda/kenko-dev-auth-relay --since 1h --region us-east-1
aws logs tail /ec2/kenko-dev-auth-api --follow --region us-east-1
```

O entrando a la máquina (se abre una terminal dentro del EC2, sin SSH):

```sh
IID=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=kenko-dev-auth-api" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].InstanceId" --output text)
aws ssm start-session --region us-east-1 --target $IID
docker logs api --tail 50
```

Cada respuesta de error trae un `correlationId`: búscalo en los logs para seguir el fallo.

## Datos importantes del despliegue

- La IP es fija (EIP): los redeploys no la cambian, el front no se rompe.
- Redeploy = construir imagen nueva (`:0.1.2`), subirla a ECR y actualizar el EC2 (o recrearlo; la IP se re-asocia sola).
- Todo está en Terraform (`terraform/`): VPC, EC2, RDS, ECR, SSM, logs, presupuesto, roles. El estado remoto vive en S3.
- El front local apunta con `VITE_API_URL=http://52.203.252.87:3000`. Todo es `http`, no `https` (solo demo).
- La base no tiene copias automáticas (retención 0) ni segunda zona: si se borra, se pierde. Solo hay datos de prueba.

## Por mejorar en el futuro

- Dominio propio + HTTPS con certificado (hoy es `http` con IP; los navegadores bloquean `http` desde páginas `https`).
- Copias automáticas de RDS y multi-zona cuando haya datos de verdad.
- Borrar lo apagado (ECS en 0) cuando la Lambda lleve semanas estable.
- Alarmas en CloudWatch (CPU de RDS, errores de la API, eventos muertos en `outbox`).
- Pipeline que construya y suba la imagen sola al hacer push a git.
