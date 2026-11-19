# RDS dev economico: db.t4g.micro Single-AZ, 20GB gp3, PG 18.
# En subred PRIVADA, sin IP publica, cifrado, backup 7 dias.
# Password generado aqui y guardado en SSM (nunca en git ni en logs).

resource "random_password" "db" {
  length  = 32
  special = false
}

# Secreto JWT rotado para la migracion a Lambda (invalida sesiones viejas).
resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "aws_db_subnet_group" "auth" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  tags       = local.common_tags
}

resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "Solo ECS puede llegar a Postgres (5432)."
  vpc_id      = aws_vpc.main.id
  tags        = local.common_tags

  ingress {
    description     = "Postgres desde ECS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  ingress {
    description     = "Postgres desde EC2"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2.id]
  }

  ingress {
    description     = "Postgres desde Lambda relay"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "auth" {
  identifier = "${local.name_prefix}-db"

  engine         = "postgres"
  engine_version = "18.6"

  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = var.db_name
  username                     = var.db_username
  password                     = random_password.db.result
  port                         = 5432
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = 0
  backup_window                = "03:00-04:00"
  maintenance_window           = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade   = true
  deletion_protection          = false
  skip_final_snapshot          = true
  performance_insights_enabled = false
  copy_tags_to_snapshot        = true

  db_subnet_group_name   = aws_db_subnet_group.auth.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  tags = local.common_tags
}

# URL y secreto en SSM SecureString (gratis, cifrado KMS default).
# La app resuelve RDS si AWS_RDS_POSTGRES_URL existe (ver src/config/env.ts).

resource "aws_ssm_parameter" "db_password" {
  name  = "/${var.project}/${var.environment}/db_password"
  type  = "SecureString"
  value = random_password.db.result
  tags  = local.common_tags
}

resource "aws_ssm_parameter" "rds_url" {
  name  = "/${var.project}/${var.environment}/rds_postgres_url"
  type  = "SecureString"
  value = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.auth.address}:${aws_db_instance.auth.port}/${var.db_name}?sslmode=require"
  tags  = local.common_tags
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project}/${var.environment}/jwt_secret"
  type  = "SecureString"
  value = random_password.jwt.result
  tags  = local.common_tags
}

# URL del portal (donde vive /reset). String normal: cambia sin recrear nada,
# solo reiniciar el contenedor para que la lea de nuevo.
resource "aws_ssm_parameter" "portal_base_url" {
  name  = "/${var.project}/${var.environment}/portal_base_url"
  type  = "String"
  value = var.portal_base_url
  tags  = local.common_tags
}
