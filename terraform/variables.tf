variable "aws_region" {
  description = "Region AWS (verificada: us-east-1 para dev)."
  type        = string
  default     = "us-east-1"
}

variable "identifier" {
  description = "Identificador RDS solicitado."
  type        = string
  default     = "kenko-auth"
}

variable "database_name" {
  description = "Base inicial. RDS Postgres no admite guiones: se usa kenko_auth."
  type        = string
  default     = "kenko_auth"
}

variable "master_username" {
  description = "Usuario maestro solicitado (valor propuesto en la especificacion)."
  type        = string
  default     = "mayer"
}

variable "engine_version" {
  description = "Version PG verificada como ordenable para db.t4g.micro en us-east-1."
  type        = string
  default     = "18.6"
}

variable "instance_class" {
  description = "Clase solicitada para dev."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Almacenamiento inicial en GiB."
  type        = number
  default     = 20
}

variable "port" {
  description = "Puerto PostgreSQL."
  type        = number
  default     = 5432
}

variable "vpc_id" {
  description = "VPC verificada. Solo existe la default en us-east-1; para prod usar VPC dedicada."
  type        = string
}

variable "subnet_ids" {
  description = "Subredes del grupo RDS (minimo 2 en AZ distintas)."
  type        = list(string)
}

variable "allowed_ingress_security_group_ids" {
  description = "SGs de las apps que pueden llegar a 5432 (minimo privilegio). Vacio = sin ingreso."
  type        = list(string)
  default     = []
}

variable "allowed_ingress_cidr_blocks" {
  description = "CIDRs permitidos a 5432. Preferir SGs; evitar 0.0.0.0/0."
  type        = list(string)
  default     = []
}

variable "backup_retention_period" {
  description = "Dias de backups automaticos (habilitadas para dev)."
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Dev: false para permitir limpieza. Prod: true."
  type        = bool
  default     = false
}

variable "multi_az" {
  description = "Dev: false por costo. Prod: evaluar true."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Etiquetas comunes."
  type        = map(string)
  default = {
    Project     = "kenko"
    Service     = "auth"
    Environment = "dev"
  }
}
