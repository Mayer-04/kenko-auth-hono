locals {
  name_prefix = "${var.project}-${var.environment}-${var.service}"
  common_tags = {
    Project     = "Kenko"
    Service     = var.service
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  event_bus_arn = "arn:aws:events:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:event-bus/${var.event_bus_name}"
}
