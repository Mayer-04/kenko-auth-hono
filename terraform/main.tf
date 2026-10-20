provider "aws" {
  region = var.aws_region
}

# Las credenciales AWS NO se configuran aqui: el provider usa la cadena
# estandar (AWS CLI / perfil / rol IAM), igual que el SDK del servicio.

resource "aws_db_subnet_group" "auth" {
  name       = "${var.identifier}-subnets"
  subnet_ids = var.subnet_ids
  tags       = merge(var.tags, { Name = "${var.identifier}-subnets" })
}

resource "aws_security_group" "rds" {
  name        = "${var.identifier}-rds"
  description = "RDS ${var.identifier}: solo PostgreSQL desde origenes declarados."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.identifier}-rds" })
}

# Ingreso 5432 solo desde SGs declaradas (preferido) o CIDRs declarados.
resource "aws_vpc_security_group_ingress_rule" "rds_from_sg" {
  for_each = toset(var.allowed_ingress_security_group_ids)

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL desde SG de app"
  ip_protocol                  = "tcp"
  from_port                    = var.port
  to_port                      = var.port
  referenced_security_group_id = each.value
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_cidr" {
  for_each = toset(var.allowed_ingress_cidr_blocks)

  security_group_id = aws_security_group.rds.id
  description       = "PostgreSQL desde CIDR declarado"
  ip_protocol       = "tcp"
  from_port         = var.port
  to_port           = var.port
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "rds_egress" {
  security_group_id = aws_security_group.rds.id
  description       = "Salida estandar"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_db_instance" "auth" {
  identifier     = var.identifier
  engine         = "postgres"
  engine_version = var.engine_version

  instance_class    = var.instance_class
  allocated_storage = var.allocated_storage
  storage_type      = "gp3"

  db_name  = var.database_name
  username = var.master_username
  # Sin password en codigo/vars: RDS la genera y guarda en Secrets Manager.
  manage_master_user_password = true
  port                        = var.port

  db_subnet_group_name   = aws_db_subnet_group.auth.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # Seguridad no negociable (AGENTS.md 11.2).
  publicly_accessible = false
  storage_encrypted   = true

  multi_az                   = var.multi_az
  backup_retention_period    = var.backup_retention_period
  backup_window              = "03:00-04:00"
  maintenance_window         = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
  delete_automated_backups   = true
  deletion_protection        = var.deletion_protection

  # Dev: permite `terraform destroy` sin snapshot final. Prod: false +
  # final_snapshot_identifier.
  skip_final_snapshot = true

  # Supervision minima para dev y presupuesto: logs a CloudWatch, sin
  # Performance Insights ni monitoreo mejorado (tienen costo).
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  performance_insights_enabled    = false
  monitoring_interval             = 0

  tags = merge(var.tags, { Name = var.identifier })
}
