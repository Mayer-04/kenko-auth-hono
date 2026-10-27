# Relay outbox -> EventBridge como Lambda de imagen (Bun + adapter).
# Sin VPC por ahora: no hay RDS y la VPC le quitaría internet sin aportar nada.
# Sin Scheduler por ahora: sin DB en AWS solo generaría 500s cada minuto.
resource "aws_lambda_function" "relay" {
  function_name = "${local.name_prefix}-relay"
  description   = "Relay outbox -> EventBridge de kenko-auth (Scheduler 1/min, pendiente de DB en AWS)."
  role          = aws_iam_role.relay.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.relay.repository_url}:${var.image_tag}"

  architectures = ["arm64"]
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  # Sin concurrencia reservada: la cuenta nueva tiene tope bajo (10) y AWS
  # exige dejar 10 sin reservar. Cuando suban el limite, fijar en 1.
  # Entre tanto, `claimPending ... FOR UPDATE SKIP LOCKED` ya impide que dos
  # pasadas publiquen el mismo evento, y el Scheduler 1/min no se solapa.
  reserved_concurrent_executions = null

  environment {
    variables = {
      PORT                         = "8080"
      ENVIRONMENT                  = var.app_environment
      EVENT_BUS_NAME               = var.event_bus_name
      PORTAL_BASE_URL              = var.portal_base_url
      POSTGRES_URL                 = var.postgres_url
      JWT_SECRET                   = var.jwt_secret
      JWT_ISSUER                   = var.jwt_issuer
      JWT_AUDIENCE                 = var.jwt_audience
      AWS_LWA_READINESS_CHECK_PATH = "/health"
    }
  }

  depends_on = [aws_cloudwatch_log_group.relay]

  tags = local.common_tags
}
