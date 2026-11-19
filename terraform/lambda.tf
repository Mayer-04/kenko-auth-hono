# Relay outbox -> EventBridge como Lambda de imagen (Bun + adapter).
# Vive en subredes privadas (alcanza RDS) y sale a AWS por Interface
# Endpoints (events + logs), sin NAT.
resource "aws_lambda_function" "relay" {
  function_name = "${local.name_prefix}-relay"
  description   = "Relay outbox -> EventBridge de kenko-auth (Scheduler 1/min de red + aviso async desde API)."
  role          = aws_iam_role.relay.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.relay.repository_url}:${var.image_tag}"

  architectures = ["arm64"]
  memory_size   = var.lambda_memory_mb
  timeout       = var.lambda_timeout_seconds

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  # Sin concurrencia reservada: la cuenta nueva tiene tope bajo (10) y AWS
  # exige dejar 10 sin reservar. `SKIP LOCKED` impide dobles publicaciones
  # y el Scheduler 1/min no se solapa en la practica.
  reserved_concurrent_executions = null

  environment {
    variables = {
      PORT                         = "8080"
      ENVIRONMENT                  = var.app_environment
      EVENT_BUS_NAME               = var.event_bus_name
      PORTAL_BASE_URL              = var.portal_base_url
      POSTGRES_URL                 = "postgresql://dummy:dummy@localhost:5432/dummy"
      AWS_RDS_POSTGRES_URL         = aws_ssm_parameter.rds_url.value
      JWT_SECRET                   = random_password.jwt.result
      JWT_ISSUER                   = var.jwt_issuer
      JWT_AUDIENCE                 = var.jwt_audience
      AWS_LWA_READINESS_CHECK_PATH = "/health"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.relay,
    aws_vpc_endpoint.events,
    aws_vpc_endpoint.logs,
  ]

  tags = local.common_tags
}
