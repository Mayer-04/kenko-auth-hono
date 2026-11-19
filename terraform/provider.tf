# Region explicita para todos los recursos (antes implicita por AWS CLI).
provider "aws" {
  region = var.aws_region
}
