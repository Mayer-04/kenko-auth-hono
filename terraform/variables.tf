variable "aws_region" {
  description = "Región de todos los recursos."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  type    = string
  default = "kenko"
}

variable "service" {
  type    = string
  default = "auth"
}

variable "environment" {
  description = "Sufijo de nombres y etiquetas (dev). No es el ENVIRONMENT del contenedor."
  type        = string
  default     = "dev"
}

variable "app_environment" {
  description = "ENVIRONMENT del contenedor. development|test|production (schema de env)."
  type        = string
  default     = "development"
}

variable "event_bus_name" {
  description = "Bus EventBridge existente (lo crean/consumen otros equipos)."
  type        = string
  default     = "kenko-dev-bus"
}

variable "image_tag" {
  description = "Tag de la imagen en ECR. Immutable: cada deploy usa un tag nuevo."
  type        = string
  default     = "0.1.2"
}

variable "lambda_memory_mb" {
  type    = number
  default = 512
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 30
}

variable "lambda_reserved_concurrency" {
  description = "1: una sola pasada del relay a la vez (SKIP LOCKED ya evita dobles)."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "Retención corta en dev: los logs eternos cuestan."
  type        = number
  default     = 14
}

variable "postgres_url" {
  description = "Conexión a la base del servicio. Sin RDS: URL local (no conecta desde AWS)."
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "Exigido por el schema de env aunque el relay no lo use."
  type        = string
  sensitive   = true
}

variable "portal_base_url" {
  type    = string
  default = "http://localhost:3000"
}

variable "jwt_issuer" {
  type    = string
  default = "kenko.auth"
}

variable "jwt_audience" {
  type    = string
  default = "kenko-api"
}

variable "db_name" {
  type    = string
  default = "kenko_auth"
}

variable "db_username" {
  type    = string
  default = "kenko_auth"
}

variable "api_image_tag" {
  description = "Tag de la imagen API en ECR. Immutable: cada deploy usa tag nuevo."
  type        = string
  default     = "0.1.2"
}

variable "api_port" {
  type    = number
  default = 3000
}

variable "api_cpu" {
  description = "CPU Fargate API (256 = 0.25 vCPU, lo minimo)."
  type        = string
  default     = "256"
}

variable "api_memory" {
  description = "Memoria Fargate API en MB (512 minimo con 256 CPU)."
  type        = string
  default     = "512"
}

variable "budget_limit_usd" {
  description = "Alerta de presupuesto mensual en USD."
  type        = string
  default     = "25"
}

variable "cors_origins" {
  description = "CORS para API en dev. Vacio aplica defaults locales."
  type        = string
  default     = ""
}
