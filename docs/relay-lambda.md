# Relay en AWS Lambda — resumen de lo que hicimos

Fecha: 27 de octubre de 2026. Servicio: `kenko-auth` (Authentication).
Objetivo: sacar el relay outbox → EventBridge de un proceso encendido 24/7
(`bun run relay`) a una función Lambda que corre solo cuando se la invoca.

## 1. Conceptos simples

| Servicio                             | Qué es                                                                                                                 | Para qué lo usamos aquí                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **ECR** (Elastic Container Registry) | El garaje privado de AWS para imágenes Docker. Guarda versiones (`:0.1.0`, `:0.1.1`). No ejecuta nada, solo almacena.  | Guardar la imagen del relay para que Lambda la descargue.                                  |
| **Lambda**                           | Computo que corre tu código solo cuando algo lo invoca (un evento, un horario). Pagas por uso (con tus créditos ≈ $0). | Correr `runRelayOnce()` una vez por invocación, sin servidor encendido.                    |
| **Lambda Adapter**                   | Extensión oficial de AWS que traduce cada invocación a una petición HTTP local.                                        | Permite correr Bun (sin runtime nativo en Lambda) como contenedor.                         |
| **EventBridge Scheduler**            | Despertador que invoca algo cada N tiempo (pendiente: cada 1 min).                                                     | Disparar el relay periódicamente. Sin DB en AWS aún, no se crea.                           |
| **CloudWatch Logs**                  | Donde caen los logs de Lambda, sí o sí.                                                                                | Creamos el grupo en Terraform con retención 14 días (si no, guarda para siempre y cuesta). |
| **IAM (rol)**                        | El permiso de la función: qué puede tocar y qué no.                                                                    | Rol mínimo: logs propios + pull de su imagen + `PutEvents` solo al bus.                    |

¿Por qué Lambda para el relay? Es corto (segundos), sin estado, idempotente
(`eventId` + `SKIP LOCKED`) y periódico. La API (`register/login/...`) se queda
en contenedor: Argon2id + JWT + DB transaccional no encajan en Lambda.

## 2. Cómo fluye ahora

```
Antes:  API → DB (users + outbox pending) → bun run relay (loop cada 5s) → EventBridge
Ahora:  API → DB (users + outbox pending) → Scheduler 1/min (pendiente) → Lambda → EventBridge
                                                  (hoy: bun run relay local, sin cambios)
```

## 3. Archivos creados

| Archivo                            | Qué hace                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/relay-handler.ts`             | Mismo `runRelayOnce()`, servido por HTTP mínimo. `GET /health` (readiness, sin DB) + resto → una pasada. Init una vez por entorno (reuso en caliente).                   |
| `Dockerfile.lambda`                | Imagen: `aws-lambda-adapter:1.0.1` + `oven/bun:1.4.4-debian` (fijadas), `PORT=8080`, solo `package.json`+`bun.lock`+`src`, `bun install --production --frozen-lockfile`. |
| `.dockerignore`                    | Excluye `node_modules`, `.env`/secretos, tests, terraform, docs. La imagen nunca lleva secretos.                                                                         |
| `tests/unit/relay-handler.test.ts` | 3 tests: `/health` sin tocar DB, `POST` devuelve conteos, fallo catastrófico → 500 genérico.                                                                             |
| `package.json` → `relay:lambda`    | Corre el formato Lambda en local (`PORT=8080 bun run relay:lambda`) para probar sin desplegar.                                                                           |
| `terraform/`                       | `versions`, `backend` S3, `variables`, `locals`, `ecr`, `iam`, `logs`, `lambda`, `outputs`, `terraform.tfvars.example`. Scheduler diferido (sin DB).                     |

## 4. Comandos ejecutados

```sh
# Estado real antes de empezar (ECR y Lambda vacíos tras tu limpieza)
aws ecr describe-repositories --region us-east-1
aws lambda list-functions --region us-east-1
aws events describe-event-bus --region us-east-1 --name kenko-dev-bus

# Limpieza de roles huérfanos de la consola
aws iam detach-role-policy / delete-role (x2)

# Estado remoto de Terraform (bootstrap, una sola vez)
aws s3api create-bucket --bucket kenko-tfstate-137696817246-us-east-1
aws s3api put-bucket-versioning ... Status=Enabled
aws s3api put-bucket-encryption ... AES256
aws s3api put-public-access-block ... (todo bloqueado)

# Login + build ARM64 + push (builder 'multi' con emulación)
aws ecr get-login-password --region us-east-1 | docker login ...
docker buildx build --builder multi --platform linux/arm64 \
  --provenance=false --sbom=false -f Dockerfile.lambda \
  -t 137696817246.dkr.ecr.us-east-1.amazonaws.com/kenko-dev-auth-relay:0.1.1 --push .

# Infraestructura
terraform init / fmt / validate / plan
terraform apply -target=aws_ecr_repository.relay   # repo primero (Lambda exige imagen existente)
terraform apply                                     # resto: rol, logs, función

# Prueba real
aws lambda invoke --function-name kenko-dev-auth-relay --payload '{}' out.json
# → {"error":{"code":"RELAY_FAILED",...}} (500 esperado: sin DB en AWS)
```

## 5. Configuración de la función `kenko-dev-auth-relay`

Memoria 512 MB · timeout 30 s · ARM64 · imagen `:0.1.1` · concurrencia sin
reservar (la cuenta nueva tiene tope 10; reactivar en 1 cuando suban el límite;
`SKIP LOCKED` cubre dev) · sin VPC (sin RDS) · sin URL pública.

Variables (`PORT=8080`, `ENVIRONMENT=development`, `EVENT_BUS_NAME=kenko-dev-bus`,
`POSTGRES_URL`, `JWT_SECRET`, `JWT_ISSUER/AUDIENCE`, `PORTAL_BASE_URL`,
`AWS_LWA_READINESS_CHECK_PATH=/health`). `AWS_REGION` no se declara: es
reservada, Lambda la pone sola.

## 6. Pruebas y resultados

- `bun run typecheck` ok · `bun run lint` 113 archivos ok · `bun run test` 17 archivos, 91 tests ok.
- `docker build` local ok (incluye `argon2` prebuilt).
- Contenedor sin env → `configuration.invalid` (fail-fast, sin secretos).
- Local `PORT=8080 bun run relay:lambda`: `/health` 200 sin DB; `POST /` → `published:1` real al bus con credenciales AWS.
- En AWS: init ok (`relay.starting`, `server.starting`), invoke → 500 `RELAY_FAILED` (DB local inalcanzable = comportamiento correcto).

## 7. Problemas y soluciones

1. `exec format error` en build ARM64 → el builder default no emula; se creó builder `multi` (docker-container).
2. Lambda rechazó `:0.1.0` (manifiesto OCI Index + atestación) → rebuild con `--provenance=false --sbom=false`, tag nuevo `:0.1.1`.
3. Concurrencia reservada `1` rechazada por tope de cuenta → `null` temporal + comentario.
4. `ENVIRONMENT=dev` inválido para el schema → var `app_environment=development` separada de `environment` (nombres).
5. `AWS_REGION` reservada → se quitó de env vars (Lambda la inyecta).
6. Tests en Node fallaban por `import "bun"` → import diferido de `client.ts` en el arranque.

## 8. Qué falta (no bloquea lo hecho)

1. Postgres en AWS (RDS dev) + `AWS_RDS_POSTGRES_URL` en la función. **Bloqueante para el loop en AWS.**
2. Scheduler cada 1 min (5 min, cuando haya DB) + VPC/RDS Proxy entonces.
3. Revisar antes de commitear: `bun.lock` trae `p-limit` agregado por algo ajeno; `main.tf` del RDS sigue borrado por tu decisión; `terraform.tfvars` con secretos está ignorado por git.

Costo estimado del relay: ≈ $0–1/mes (43k invocaciones/mes dentro del free tier, imagen 115 MB, logs con retención corta).
