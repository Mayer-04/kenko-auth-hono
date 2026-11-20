# Red privada para la Lambda del relay (ruta segura).
# La Lambda vive en las subredes privadas (alcanza RDS) y sale a AWS
# por 2 Interface Endpoints (EventBridge + Logs) en vez de NAT (~$32/mes).
# Sin el endpoint de Logs, la Lambda en VPC ni siquiera puede escribir errores.

resource "aws_security_group" "lambda" {
  name        = "${local.name_prefix}-lambda-sg"
  description = "Relay Lambda: solo HTTPS a endpoints y 5432 a RDS."
  vpc_id      = aws_vpc.main.id
  tags        = local.common_tags

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "endpoints" {
  name        = "${local.name_prefix}-endpoints-sg"
  description = "Endpoints VPC: solo 443 desde la Lambda."
  vpc_id      = aws_vpc.main.id
  tags        = local.common_tags

  ingress {
    description     = "HTTPS desde Lambda"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  ingress {
    description     = "HTTPS desde EC2 (driver de logs + SDK)"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  # Profile comparte esta VPC y el DNS privado de los endpoints: sin esto
  # sus tareas ECS no alcanzan logs/events. Mismo texto que la regla manual
  # existente para no producir diff.
  ingress {
    description     = "HTTPS desde kenko-dev-profile-ecs-sg (logs/events)"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = ["sg-04461420cbf40aec7"]
  }

  # Appointments corre sus tareas Fargate con este SG y comparte esta VPC
  # y el DNS privado de los endpoints: sin esto sus tareas no alcanzan
  # logs/events (503). Mismo texto que la regla que agregaron ellos
  # (jprojas_42) para no producir diff. Precedente: commit 8e769b1 (profile).
  ingress {
    description     = "HTTPS desde kenko-dev-appointments-ecs (logs/events)"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = ["sg-033261f5a0531fe94"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_endpoint" "events" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.events"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.common_tags, { Name = "${local.name_prefix}-events-endpoint" })
}

resource "aws_vpc_endpoint" "logs" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.common_tags, { Name = "${local.name_prefix}-logs-endpoint" })
}
