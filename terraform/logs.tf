# Lambda crea el grupo solo con retención infinita (cuesta para siempre).
# Crearlo aquí fija retención corta en dev.
resource "aws_cloudwatch_log_group" "relay" {
  name              = "/aws/lambda/${local.name_prefix}-relay"
  retention_in_days = var.log_retention_days

  tags = local.common_tags
}
