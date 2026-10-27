output "ecr_repository_url" {
  value = aws_ecr_repository.relay.repository_url
}

output "lambda_function_name" {
  value = aws_lambda_function.relay.function_name
}

output "lambda_role_name" {
  value = aws_iam_role.relay.name
}
