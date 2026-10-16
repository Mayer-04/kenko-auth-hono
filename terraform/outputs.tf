output "endpoint" {
  description = "Host de conexion RDS (sin puerto ni credenciales)."
  value       = aws_db_instance.auth.address
}

output "port" {
  description = "Puerto PostgreSQL."
  value       = aws_db_instance.auth.port
}

output "identifier" {
  description = "Identificador de la instancia."
  value       = aws_db_instance.auth.id
}

output "database_name" {
  description = "Base inicial creada."
  value       = aws_db_instance.auth.db_name
}

output "master_user_secret_arn" {
  description = "ARN del secreto Secrets Manager con la credencial maestra. Leer user/password desde ahi; nunca versionarlos."
  value       = try(aws_db_instance.auth.master_user_secret[0].secret_arn, null)
  sensitive   = true
}

output "security_group_id" {
  description = "SG de RDS (para autorizar las SGs de app)."
  value       = aws_security_group.rds.id
}
