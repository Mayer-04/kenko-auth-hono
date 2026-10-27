# Garaje de la imagen del relay. Immutable: un tag publicado no se reescribe;
# cada deploy usa un tag nuevo y siempre se sabe qué corre en Lambda.
resource "aws_ecr_repository" "relay" {
  name                 = "${local.name_prefix}-relay"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.common_tags
}

# Guarda las últimas 5 con tag (cada una ~115 MB). Sin esto se acumulan
# y consumen el free tier / créditos.
resource "aws_ecr_lifecycle_policy" "relay" {
  repository = aws_ecr_repository.relay.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Conserva las ultimas 5 imagenes con tag"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 5
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Limpia imagenes sin tag (pushes intermedios)"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
    ]
  })
}
