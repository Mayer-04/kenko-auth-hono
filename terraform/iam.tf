# Rol mínimo de la función: logs de su propio grupo, pull de su propio
# repo ECR y PutEvents solo al bus del entorno. Nada más.
resource "aws_iam_role" "relay" {
  name = "${local.name_prefix}-relay-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_policy" "relay" {
  name = "${local.name_prefix}-relay-lambda"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.relay.arn}:*"
      },
      {
        Sid      = "PullOwnImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = aws_ecr_repository.relay.arn
      },
      {
        Sid      = "PublishToBus"
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = local.event_bus_arn
      },
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "relay" {
  role       = aws_iam_role.relay.name
  policy_arn = aws_iam_policy.relay.arn
}
