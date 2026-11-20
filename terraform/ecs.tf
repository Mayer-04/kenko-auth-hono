# ECS Fargate Opcion A: API siempre encendida (1 tarea, IP publica)
# + tarea one-shot del relay (Scheduler cada 1 min).
# Sin ALB ni NAT para caber en $200/6 meses.

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "relay_ecs" {
  name              = "/ecs/${local.name_prefix}-relay"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}

resource "aws_security_group" "ecs" {
  name        = "${local.name_prefix}-ecs-sg"
  description = "API dev: HTTP publico en api_port. Solo demo sin datos reales."
  vpc_id      = aws_vpc.main.id
  tags        = local.common_tags

  ingress {
    description = "API demo"
    from_port   = var.api_port
    to_port     = var.api_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Regla compartida que agrego Appointments en este SG; se fija en codigo
  # para que un apply nuestro no los tumbe.
  ingress {
    description = "kenko-dev-appointments-api-8002-dev-only"
    from_port   = 8002
    to_port     = 8002
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Rol de ejecucion: pull ECR + logs + leer SSM.
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_policy" "ecs_execution_ssm" {
  name = "${local.name_prefix}-ecs-exec-ssm"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadSsmParams"
      Effect = "Allow"
      Action = ["ssm:GetParameters", "ssm:GetParameter"]
      Resource = [
        aws_ssm_parameter.rds_url.arn,
        aws_ssm_parameter.jwt_secret.arn,
        aws_ssm_parameter.db_password.arn,
      ]
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution_ssm" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = aws_iam_policy.ecs_execution_ssm.arn
}

# Rol de tarea API: minimo (solo logs via execution; sin PutEvents porque
# la API solo escribe outbox, no publica directo).
resource "aws_iam_role" "api_task" {
  name = "${local.name_prefix}-api-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

# Rol de tarea relay: solo PutEvents al bus + nada mas.
resource "aws_iam_role" "relay_task" {
  name = "${local.name_prefix}-relay-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_policy" "relay_task_events" {
  name = "${local.name_prefix}-relay-task-events"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PublishToBus"
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = local.event_bus_arn
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "relay_task_events" {
  role       = aws_iam_role.relay_task.name
  policy_arn = aws_iam_policy.relay_task_events.arn
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    essential = true
    portMappings = [{
      containerPort = var.api_port
      hostPort      = var.api_port
      protocol      = "tcp"
    }]
    environment = [
      { name = "PORT", value = tostring(var.api_port) },
      { name = "ENVIRONMENT", value = var.app_environment },
      { name = "EVENT_BUS_NAME", value = var.event_bus_name },
      { name = "PORTAL_BASE_URL", value = var.portal_base_url },
      { name = "JWT_ISSUER", value = var.jwt_issuer },
      { name = "JWT_AUDIENCE", value = var.jwt_audience },
      { name = "CORS_ORIGINS", value = var.cors_origins },
      # POSTGRES_URL dummy: el codigo prefiere AWS_RDS_POSTGRES_URL si existe.
      { name = "POSTGRES_URL", value = "postgresql://dummy:dummy@localhost:5432/dummy" },
    ]
    secrets = [
      { name = "AWS_RDS_POSTGRES_URL", valueFrom = aws_ssm_parameter.rds_url.arn },
      { name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "relay_once" {
  family                   = "${local.name_prefix}-relay-once"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.relay_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "relay"
    image     = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    essential = true
    command   = ["bun", "src/relay-once.ts"]
    environment = [
      { name = "PORT", value = "3000" },
      { name = "ENVIRONMENT", value = var.app_environment },
      { name = "EVENT_BUS_NAME", value = var.event_bus_name },
      { name = "PORTAL_BASE_URL", value = var.portal_base_url },
      { name = "JWT_ISSUER", value = var.jwt_issuer },
      { name = "JWT_AUDIENCE", value = var.jwt_audience },
      { name = "POSTGRES_URL", value = "postgresql://dummy:dummy@localhost:5432/dummy" },
    ]
    secrets = [
      { name = "AWS_RDS_POSTGRES_URL", valueFrom = aws_ssm_parameter.rds_url.arn },
      { name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.relay_ecs.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "relay"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.public_a.id, aws_subnet.public_b.id]
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  # Espera a que el ECR tenga imagen; si falla el primer deploy, hacer
  # push y luego `aws ecs update-service --force-new-deployment`.
  depends_on = [aws_ecr_repository.api]

  tags = local.common_tags
}
