# Checklist: migrar relay a Lambda (ruta segura)

Objetivo: que el relay `outbox -> EventBridge` corra en Lambda de 2 formas combinadas: la API la invoca en modo async justo después de guardar (retardo de segundos) y el Scheduler de 1 minuto queda como red de seguridad. Así se elimina la espera de 60 segundos sin perder la garantía del outbox.

## Antes de aplicar (pre-vuelo)

- Revisar el `terraform plan` línea por línea: ningún `aws_security_group` debe decir `must be replaced` (el `description` de un SG fuerza reemplazo y RDS lo rechaza con la ENI atachada).
- Confirmar que solo se agregan recursos (endpoints, reglas, policies) y se editan in-place (Lambda `vpc_config`, Scheduler destino).
- Tener a mano el comando de rollback (abajo).

## Red (VPC existente)

- Crear Interface Endpoint de EventBridge (`events`) en las subredes privadas, con DNS privado activado.
- Crear Interface Endpoint de CloudWatch Logs (`logs`) en las subredes privadas, con DNS privado activado. Sin este, la Lambda no puede ni escribir sus errores.
- SG de endpoints: solo acepta `443` desde el SG de la Lambda.
- SG nuevo para la Lambda: salida a `443` (endpoints) y a `5432` (RDS).
- SG de RDS: agregar entrada `5432` desde el SG de la Lambda **inline** (no como regla separada: mezclar inline + separadas hace que Terraform borre una).

## IAM

- Al rol `kenko-dev-auth-relay-lambda` agregarle `AWSLambdaVPCAccessExecutionRole` (sin esto no crea su tarjeta de red y falla el primer invoke).
- Mantener lo mínimo actual: logs propios, `PutEvents` solo al bus, pull de su imagen.

## Secretos (decisión de dev, documentada)

- Opción elegida: valores en variables de entorno de la Lambda (cifradas en reposo), para no pagar un 3er endpoint (SSM).
- Actualizar env: agregar `AWS_RDS_POSTGRES_URL` con `?sslmode=require` (hoy la Lambda apunta a `localhost` y no sirve).
- Sacar el `JWT_SECRET` en texto plano de la config actual y rotarlo al migrar.

## Lambda

- Ponerla en subredes privadas + su SG. Mantener `512MB / 30s / ARM64`, concurrencia reservada `1`.
- Probar manual primero: `aws lambda invoke` y ver `published > 0` en `/aws/lambda/kenko-dev-auth-relay` + crecimiento en SQS.

## Corte (solo un relay a la vez)

1. Scheduler en `DISABLED` apuntando a la Lambda, probar manual.
2. Con la Lambda publicando bien: detener el contenedor `relay` del EC2 (la API queda) y habilitar el Scheduler.
3. Si algo falla: pausar Scheduler y reactivar el loop del EC2. Lo pendiente queda en `outbox`, nada se pierde.

## Invocación desde la API (tiempo real, la manera elegida)

- Idea: después de cada escritura en `outbox` (register, forgot, changeEmail), la API invoca la Lambda en modo async y no espera respuesta. Retardo de segundos en vez de 0-60s. El Scheduler de 1 min queda como red por si una invocación se pierde.
- Permiso: darle al rol del EC2 `lambda:InvokeFunction` solo sobre la Lambda del relay (un bloque en Terraform).
- Código: agregar cliente `@aws-sdk/client-lambda` e invocar con `InvocationType: Event` después del commit, dentro de `try/catch` que nunca rompa la petición (si falla el invoke, el Scheduler lo recoge al minuto).
- Seguro ante choques: si la invocada y la programada coinciden, `SKIP LOCKED` evita publicar dos veces lo mismo.
- Costo: una invocación por escritura; en demo es despreciable y sigue dentro del free tier.

## Después (deuda conocida, no bloqueante)

- Alarma de eventos `dead` y de crecimiento de `outbox` (hoy un payload muerto pasa inadvertido).
- RDS sin copias (retención 0) ni multi-AZ: solo datos de prueba hasta activarlo.
- Borrar lo apagado (ECS en 0, Scheduler viejo) cuando la Lambda lleve semanas estable.
- Recordar: el Scheduler mínimo es 1 minuto; con la invocación async el evento tarda segundos, y el Scheduler solo entra si algo se perdió.
